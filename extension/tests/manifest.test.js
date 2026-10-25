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

/** @returns {string[]} every extension-relative path the manifest references */
function manifestPaths() {
  return [
    ...Object.values(manifest.icons),
    ...manifest.background.scripts,
    manifest.browser_action.default_popup,
    manifest.browser_action.default_icon,
    manifest.options_ui.page,
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
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
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

test("every local file referenced by extension pages exists", () => {
  for (const page of [manifest.browser_action.default_popup, manifest.options_ui.page]) {
    const refs = htmlReferences(page);
    assert.ok(refs.length > 0, page);
    for (const rel of refs) assert.ok(fs.statSync(path.join(ROOT, rel)).isFile(), `${page} → ${rel}`);
  }
});

test("extension pages contain no inline scripts or handlers (MV2 CSP blocks them)", () => {
  for (const page of [manifest.browser_action.default_popup, manifest.options_ui.page]) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, page);
    assert.doesNotMatch(html, /\son[a-z]+=/i, page);
  }
});

test("extension scripts never assign innerHTML or use document.write", () => {
  const files = ["background.js", "popup/popup.js", "options/options.js", "shared/settings.js", "shared/youtube.js", "shared/downloads.js"];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(source, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, rel);
  }
});
