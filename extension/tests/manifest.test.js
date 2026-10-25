"use strict";

/*
 * Static checks a browser would otherwise only report at load time: the
 * manifest parses, carries the contract IDs, and every file referenced by the
 * manifest or by an extension page exists.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
// Opened with tabs.create, so it is not referenced by the manifest itself.
const SETUP_PAGE = "setup/setup.html";

/** @returns {string[]} every extension page */
function extensionPages() {
  return [manifest.browser_action.default_popup, manifest.options_ui.page, SETUP_PAGE];
}

/** @returns {string[]} every extension script outside tests/, extension-relative */
function extensionScripts() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory() && rel !== "tests") walk(rel);
      else if (entry.isFile() && rel.endsWith(".js")) found.push(rel);
    }
  };
  walk("");
  return found.sort();
}

/** @returns {string[]} every extension-relative path the manifest references */
function manifestPaths() {
  return [
    ...Object.values(manifest.icons),
    ...manifest.background.scripts,
    manifest.browser_action.default_popup,
    manifest.browser_action.default_icon,
    manifest.options_ui.page,
    ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  ];
}

/**
 * Local src/href references in an HTML page, resolved relative to the page.
 * @param {string} page extension-relative path
 * @returns {string[]} extension-relative paths
 */
function htmlReferences(page) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  const refs = [...html.matchAll(/\b(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  return refs.map((ref) => path.posix.normalize(path.posix.join(path.posix.dirname(page), ref)));
}

test("manifest carries the contract IDs and MV2 persistent background", () => {
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.browser_specific_settings.gecko.id, "ytdlp-downloader@firstpick.dev");
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  // Only for the linter: data_collection_permissions needs Firefox for Android 142.
  // The add-on is desktop-only (no native messaging on Android); AMO sets that at upload.
  assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, "142.0");
  assert.equal(manifest.background.persistent, true);
  assert.equal(manifest.options_ui.open_in_tab, true);
  assert.deepEqual([...manifest.permissions].sort(), ["menus", "nativeMessaging", "notifications", "storage"]);
});

test("background scripts load the shared modules before background.js", () => {
  const scripts = manifest.background.scripts;
  assert.equal(scripts.at(-1), "background.js");
  for (const shared of ["shared/settings.js", "shared/youtube.js", "shared/downloads.js"]) {
    assert.ok(scripts.indexOf(shared) >= 0 && scripts.indexOf(shared) < scripts.length - 1, shared);
  }
});

test("background.js uses the contract native host name", () => {
  const source = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  assert.match(source, /const HOST_NAME = "dev\.firstpick\.ytdlp_downloader";/);
});

test("every file referenced by the manifest exists", () => {
  for (const rel of manifestPaths()) {
    assert.ok(fs.statSync(path.join(ROOT, rel)).isFile(), rel);
  }
});

test("the setup page exists and background.js opens that path", () => {
  assert.ok(fs.statSync(path.join(ROOT, SETUP_PAGE)).isFile());
  const source = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  assert.match(source, new RegExp(`const SETUP_PAGE = "${SETUP_PAGE.replace(".", "\\.")}";`));
  assert.equal(manifest.web_accessible_resources, undefined, "no extension page is exposed to websites");
});

test("every local file referenced by extension pages exists", () => {
  for (const page of extensionPages()) {
    const refs = htmlReferences(page);
    assert.ok(refs.length > 0, page);
    for (const rel of refs) assert.ok(fs.statSync(path.join(ROOT, rel)).isFile(), `${page} → ${rel}`);
  }
});

test("pages that use the setup command load the shared setup module first", () => {
  for (const page of extensionPages()) {
    const refs = htmlReferences(page).filter((ref) => ref.endsWith(".js"));
    const shared = refs.indexOf("shared/setup-info.js");
    assert.ok(shared >= 0 && shared < refs.length - 1, page);
  }
});

test("extension pages contain no inline scripts or handlers (MV2 CSP blocks them)", () => {
  for (const page of extensionPages()) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, page);
    assert.doesNotMatch(html, /\son[a-z]+=/i, page);
  }
});

test("extension scripts never assign innerHTML or use document.write", () => {
  const files = extensionScripts();
  assert.ok(files.includes("setup/setup.js") && files.includes("shared/setup-info.js"), files.join(", "));
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(source, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, rel);
  }
});

test("the player-menu content script only runs on YouTube player pages", () => {
  assert.deepEqual(manifest.content_scripts.map((entry) => entry.matches), [
    ["*://www.youtube.com/*", "*://www.youtube-nocookie.com/embed/*"],
  ]);
  assert.deepEqual(manifest.content_scripts[0].js, ["content/player-menu.js"]);
});

test("the content script never sends anything but downloadFromPage", () => {
  const source = fs.readFileSync(path.join(ROOT, "content/player-menu.js"), "utf8");
  const types = [...source.matchAll(/type:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(types, ["downloadFromPage"]);
  assert.match(source, /if \(!event\.isTrusted\) return;/, "synthetic clicks are ignored");
  // Key events reach YouTube's page-wide shortcuts (Escape left theater mode).
  assert.doesNotMatch(source, /new KeyboardEvent/, "the script never synthesizes key events");
});

test("the settings page always offers the setup page, not only when something is wrong", () => {
  const html = fs.readFileSync(path.join(ROOT, "options/options.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "options/options.js"), "utf8");
  const button = /<button[^>]*id="show-setup"[^>]*>/.exec(html);
  assert.ok(button, "a #show-setup button exists");
  assert.doesNotMatch(button[0], /\bhidden\b/, "it is not hidden by default");
  assert.match(js, /getElementById\("show-setup"\)\.addEventListener\("click"/);
});
