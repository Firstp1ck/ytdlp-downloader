"use strict";

/*
 * Runs setup/setup.js in a vm context with a minimal fake DOM, fake timers,
 * and a scripted ping reply. Only element ids that exist in setup.html resolve,
 * so a renamed id fails here instead of at load time in the browser.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setupCommand } = require("../shared/setup-info.js");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "setup/setup.html"), "utf8");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const READY_PONG = {
  type: "pong",
  hostVersion: "1.3.0",
  python: { found: true, path: "/usr/bin/python3", version: "3.14.0", supported: true },
  ytDlp: { found: true, path: "/usr/bin/yt-dlp", version: "2026.10.21" },
  ffmpeg: { found: true, path: "/usr/bin/ffmpeg" },
  ffprobe: { found: true, path: "/usr/bin/ffprobe" },
  jsRuntime: { name: "deno", path: "/home/user/.deno/bin/deno" },
  picker: "zenity",
  opener: { found: true, path: "/usr/bin/xdg-open" },
  userDirs: { found: true, path: "/usr/bin/xdg-user-dir" },
  setupLauncher: { found: true, path: "/home/user/.local/bin/ytdlp-setup" },
  downloader: { found: true, name: "curl", path: "/usr/bin/curl" },
  coreutils: { found: true, missing: [] },
  nativeMessagingProxy: { found: true, path: "/usr/bin/xdg-native-messaging-proxy", applicable: true },
};
const REPLY = { ok: true, pong: READY_PONG };
const reply = (patch) => ({ ok: true, pong: { ...READY_PONG, ...patch } });
const KEYS = ["helper", "python", "ytdlp", "ffmpeg", "ffprobe", "jsRuntime", "picker", "opener", "userDirs", "setupLauncher", "downloader", "coreutils", "nativeMessagingProxy"];
const MISSING = { ok: false, error: "No such native application dev.firstpick.ytdlp_downloader" };

class FakeElement {
  constructor(tagName, id = "", hidden = false) {
    this.tagName = tagName;
    this.id = id;
    this.hidden = hidden;
    this.textContent = "";
    this.className = "";
    this.href = "";
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.listeners = {};
  }
  set innerHTML(_value) {
    throw new Error("Setup must render plain text, never HTML");
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  focus() {
    for (const listener of this.listeners.focus ?? []) listener();
  }
  click() {
    return Promise.all((this.listeners.click ?? []).map((listener) => listener()));
  }
}

/** Element ids in setup.html, with their initial `hidden` attribute. */
function pageElements() {
  const elements = new Map();
  for (const match of HTML.matchAll(/<([a-z0-9]+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const attributes = `${match[2]} ${match[4]}`;
    elements.set(match[3], new FakeElement(match[1], match[3], /\shidden(?:\s|$|=)/.test(` ${attributes} `)));
  }
  return elements;
}

/** Loads the setup page. `replies` answers each ping in order; the last one repeats. */
function boot(replies, { clipboard = async () => {}, hidden = false } = {}) {
  const elements = pageElements();
  const sent = [];
  const timers = new Map();
  let nextTimer = 1;
  const state = { selected: 0, optionsOpened: 0, copied: [] };
  const documentListeners = {};
  const document = {
    hidden,
    getElementById(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`setup.js looked up #${id}, which setup.html does not have`);
      return element;
    },
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, listener) => (documentListeners[type] ??= []).push(listener),
  };
  const browser = {
    runtime: {
      getManifest: () => ({ version: VERSION }),
      async sendMessage(message) {
        sent.push(structuredClone(message));
        const response = replies[Math.min(sent.length - 1, replies.length - 1)];
        if (response instanceof Error || response === null) throw response;
        return structuredClone(typeof response === "function" ? await response() : response);
      },
      openOptionsPage: async () => {
        state.optionsOpened += 1;
      },
    },
  };
  const context = vm.createContext({
    browser,
    document,
    window: { getSelection: () => ({ selectAllChildren: () => (state.selected += 1) }) },
    navigator: {
      clipboard: {
        writeText: async (text) => {
          state.copied.push(text);
          await clipboard(text);
        },
      },
    },
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    console,
  });
  for (const script of ["shared/setup-info.js", "setup/setup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, script), "utf8"), context, { filename: script });
  }
  return {
    el: (id) => elements.get(id),
    sent,
    state,
    timers,
    /** Fires every pending timer once (the next poll, feedback resets). */
    async tick() {
      const due = [...timers.entries()];
      for (const [id] of due) timers.delete(id);
      for (const [, { fn }] of due) fn();
      await flush();
    },
    async setHidden(hidden) {
      document.hidden = hidden;
      for (const listener of documentListeners.visibilitychange ?? []) listener();
      await flush();
    },
    pollDelays: () => [...timers.values()].map((timer) => timer.ms),
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function rows(page) {
  return new Map(page.el("checklist").children.map((row) => [row.dataset.key, row]));
}

function part(row, className) {
  return row.children.find((child) => child.className === className);
}

test("initial checking and missing-helper states always show thirteen checks with bootstrap context", async () => {
  const page = boot([MISSING]);
  assert.equal(page.el("setup-card").dataset.state, "checking");
  assert.ok([...rows(page).values()].every((row) => row.dataset.status === "pending"));
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "missing");
  assert.equal(page.el("state-title").textContent, "Install the helper");
  assert.match(page.el("state-lead").textContent, /can't run programs by itself/);
  assert.equal(page.el("command-block").hidden, false);
  assert.equal(page.el("command").textContent, `curl -fsSL https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v${VERSION}/setup.sh | bash`);
  assert.match(page.el("command-alternatives").textContent, /availability cannot be checked.*wget -qO-/);
  assert.ok(page.el("command-alternatives").textContent.includes(`/v${VERSION}/setup.sh | bash`));
  assert.match(page.el("command-alternatives").textContent, /Download setup\.sh.*save.*bash followed by one space.*drag.*full path.*Enter/);
  assert.equal(page.el("script-link").href, `https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v${VERSION}/setup.sh`);
  assert.equal(page.el("manual-link").href, "https://github.com/Firstp1ck/ytdlp-downloader#install");
  assert.equal(page.el("error-details").hidden, false);
  assert.match(page.el("error-text").textContent, /No such native application/);
  assert.equal(page.el("ready-block").hidden, true);
  assert.equal(page.el("ready-warning").hidden, true);
  assert.equal(page.el("poll-text").textContent, "Waiting for the helper…");
  assert.equal(page.el("poll-status").dataset.active, "true");
  assert.deepEqual([...rows(page).keys()], KEYS);
  for (const [key, row] of rows(page)) {
    assert.equal(row.dataset.status, key === "helper" ? "bad" : "pending", key);
    if (key !== "helper") assert.match(part(row, "check-detail").textContent, /Requires a working helper/);
  }
  assert.match(page.el("announce").textContent, /^Install the helper/);
  assert.deepEqual(page.pollDelays(), [2500]);
  assert.deepEqual(page.sent, [{ type: "ping", reconnect: false }]);
});

test("polling reaches healthy Ready automatically and stops", async () => {
  const page = boot([MISSING, MISSING, REPLY]);
  await flush();
  await page.tick();
  assert.equal(page.el("setup-card").dataset.state, "missing");
  await page.tick();
  assert.equal(page.sent.length, 3);
  assert.equal(page.el("setup-card").dataset.state, "ready");
  assert.equal(page.el("state-title").textContent, "Ready to download");
  assert.match(page.el("state-lead").textContent, /supported Python, yt-dlp, ffmpeg and ffprobe/);
  assert.equal(page.el("command-block").hidden, true);
  assert.equal(page.el("error-details").hidden, true);
  assert.equal(page.el("ready-block").hidden, false);
  assert.equal(page.el("poll-status").hidden, true);
  assert.equal(page.el("ready-warning").hidden, true);
  assert.ok([...rows(page).values()].every((row) => row.dataset.status === "ok"));
  assert.equal(part(rows(page).get("jsRuntime"), "check-detail").textContent, "deno (/home/user/.deno/bin/deno)");
  assert.deepEqual(page.pollDelays(), []);
  await page.el("open-settings").click();
  assert.equal(page.state.optionsOpened, 1);
});

test("all rows have visible status words, requirement text and decorative icons", async () => {
  const page = boot([reply({ ffprobe: { found: false }, picker: null, userDirs: undefined })]);
  await flush();
  for (const [key, row] of rows(page)) {
    assert.ok(part(row, "check-label").textContent, key);
    assert.ok(part(row, "check-requirement").textContent, key);
    assert.ok(part(row, "check-detail").textContent, key);
    assert.equal(part(row, "check-icon").attributes["aria-hidden"], "true");
    assert.equal(part(row, "check-status").textContent,
      { ok: "Passed", bad: "Needs action", warn: "Warning", pending: "Pending" }[row.dataset.status]);
  }
  assert.equal(part(rows(page).get("ffprobe"), "check-requirement").textContent, "Required for downloads");
  assert.equal(rows(page).size, 13);
  assert.equal(part(rows(page).get("setupLauncher"), "check-requirement").textContent, "Setup only");
  assert.equal(part(rows(page).get("downloader"), "check-requirement").textContent, "Setup only");
  assert.equal(part(rows(page).get("nativeMessagingProxy"), "check-requirement").textContent, "Conditional: Flatpak / Snap");
});

test("each missing required dependency blocks downloads and exposes assistance", async () => {
  for (const [field, key, name] of [["python", "python", "Python 3.8+"], ["ytDlp", "ytdlp", "yt-dlp"],
    ["ffmpeg", "ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe", "ffprobe"]]) {
    const page = boot([reply({ [field]: { found: false } })]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "tools", key);
    assert.equal(page.el("state-title").textContent, `Install ${name}`);
    assert.ok(page.el("state-lead").textContent.includes(`${name} is missing`));
    assert.match(page.el("state-lead").textContent, /Downloads are blocked/);
    assert.equal(rows(page).get(key).dataset.status, "bad");
    assert.equal(page.el("command-block").hidden, false);
    assert.equal(page.el("ready-block").hidden, true);
    assert.deepEqual(page.pollDelays(), [2500]);
  }
});

test("each optional/setup warning names the missing tool, offers installation, and polls until fixed", async () => {
  for (const [key, report, label] of [
    ["jsRuntime", null, "JavaScript runtime"], ["picker", null, "Folder picker"],
    ["opener", { found: false }, "Folder opener"], ["userDirs", { found: false }, "Downloads-folder detection"],
    ["setupLauncher", { found: false, path: null }, "Setup launcher"],
    ["downloader", { found: false }, "curl / wget downloader"],
    ["coreutils", { found: false, missing: ["install"] }, "Coreutils"],
    ["nativeMessagingProxy", { found: false, applicable: true }, "Sandbox proxy"],
  ]) {
    const page = boot([reply({ [key]: report }), REPLY]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "ready", key);
    assert.equal(rows(page).get(key).dataset.status, "warn");
    assert.equal(page.el("ready-block").hidden, false);
    assert.equal(page.el("ready-warning").hidden, false);
    assert.ok(page.el("warning-text").textContent.includes(label));
    assert.match(page.el("warning-text").textContent, /do not block downloads.*offers to install/);
    assert.equal(page.el("command-block").hidden, false);
    assert.equal(page.el("poll-status").hidden, false);
    assert.equal(page.el("poll-status").dataset.active, "true");
    assert.deepEqual(page.pollDelays(), [2500]);
    await page.tick();
    assert.equal(page.el("ready-warning").hidden, true);
    assert.equal(page.el("command-block").hidden, true);
    assert.deepEqual(page.pollDelays(), [], key);
  }
});

test("generic guidance names multiple optional tools even alongside required failures", async () => {
  const page = boot([reply({ picker: null, opener: { found: false }, ffmpeg: { found: false } })]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "tools");
  assert.equal(page.el("ready-warning").hidden, false);
  assert.match(page.el("warning-text").textContent, /Folder picker and Folder opener/);
  assert.doesNotMatch(page.el("warning-text").textContent, /No JavaScript runtime/);
});

test("unreported optional checks remain pending with assistance and polling", async () => {
  for (const key of ["jsRuntime", "picker", "opener", "userDirs", "setupLauncher", "downloader", "coreutils"]) {
    const page = boot([reply({ [key]: undefined }), REPLY]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "ready", key);
    assert.equal(rows(page).get(key).dataset.status, "pending");
    assert.equal(page.el("ready-warning").hidden, false);
    assert.match(page.el("warning-text").textContent, /checks not confirmed.*not been reported missing/);
    assert.equal(page.el("command-block").hidden, false);
    assert.deepEqual(page.pollDelays(), [2500]);
    if (key === "downloader") {
      assert.match(page.el("command-alternatives").textContent, /Using the verified setup launcher/);
      assert.doesNotMatch(page.el("command-alternatives").textContent, /Neither curl nor wget was found/);
    }
    await page.tick();
    assert.deepEqual(page.sent.at(-1), { type: "ping", reconnect: true });
    assert.deepEqual(page.pollDelays(), []);
  }
});

test("unknown sandbox applicability stays conditional without proxy warning or ongoing polling", async () => {
  for (const nativeMessagingProxy of [undefined, { found: false, applicable: null }]) {
    const page = boot([reply({ nativeMessagingProxy })]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "ready");
    const proxy = rows(page).get("nativeMessagingProxy");
    assert.equal(proxy.dataset.status, "pending");
    assert.match(part(proxy, "check-detail").textContent, /Applicability not established/);
    assert.equal(page.el("ready-warning").hidden, true);
    assert.equal(page.el("command-block").hidden, true);
    assert.deepEqual(page.pollDelays(), []);
  }
});

test("1.2.x and older helpers request an update and reconnect on the next check", async () => {
  for (const hostVersion of ["1.2.0", "1.1.0", "1.0.0", "0.9.0"]) {
    const page = boot([reply({ hostVersion }), REPLY]);
    await flush();
    assert.equal(page.el("state-title").textContent, "Update the helper");
    assert.ok(page.el("state-lead").textContent.includes(`version ${hostVersion}; this extension needs 1.3.0 or newer`));
    assert.equal(page.el("command-block").hidden, false);
    await page.tick();
    assert.deepEqual(page.sent.at(-1), { type: "ping", reconnect: true });
    assert.equal(page.el("setup-card").dataset.state, "ready");
  }
});

test("current helper with missing/malformed required diagnostics explains the real update reason", async () => {
  for (const [field, key] of [["python", "python"], ["ytDlp", "ytdlp"], ["ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe"]]) {
    for (const report of [undefined, { found: "true" }]) {
      const page = boot([reply({ [field]: report }), REPLY]);
      await flush();
      assert.equal(page.el("setup-card").dataset.state, "outdated");
      assert.equal(page.el("state-title").textContent, "Update or reinstall the helper");
      assert.match(page.el("state-lead").textContent, /version 1\.3\.0, but required diagnostics are missing or invalid/);
      assert.doesNotMatch(page.el("state-lead").textContent, /version 1\.3\.0; this extension needs 1\.3\.0/);
      assert.equal(rows(page).get(key).dataset.status, "pending");
      assert.equal(page.el("command-block").hidden, false);
      assert.equal(page.el("ready-block").hidden, true);
      await page.tick();
      assert.deepEqual(page.sent.at(-1), { type: "ping", reconnect: true });
      assert.deepEqual(page.pollDelays(), []);
    }
  }
});

test("unreported version and malformed envelopes never imply readiness or bogus version comparisons", async () => {
  for (const hostVersion of [undefined, "development"]) {
    const page = boot([reply({ hostVersion })]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "outdated");
    assert.match(page.el("state-lead").textContent, /without a valid version.*compatibility cannot be confirmed/);
    assert.equal(page.el("command-block").hidden, false);
  }
  for (const response of [{ ok: true, pong: [] }, { ok: true, pong: "pong" }, true]) {
    const page = boot([response]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "missing");
  }
});

test("broken yt-dlp repair guidance never claims setup replaces an existing broken executable", async () => {
  const page = boot([reply({ ytDlp: { found: true, version: null }, ffmpeg: { found: false } })]);
  await flush();
  assert.equal(page.el("state-title").textContent, "Install ffmpeg and repair yt-dlp");
  assert.match(page.el("state-lead").textContent, /ffmpeg is missing, and yt-dlp doesn't run/);
  assert.match(page.el("state-lead").textContent, /Update yt-dlp with your package manager, or remove it before running setup again/);
  assert.match(page.el("state-lead").textContent, /does not automatically replace an existing broken yt-dlp/);
  assert.equal(page.el("ready-block").hidden, true);
  assert.equal(page.el("command-block").hidden, false);
  assert.equal(page.el("poll-text").textContent, "Waiting for ffmpeg and yt-dlp…");
});

test("unsupported Python repair reconnects before accepting the new interpreter report", async () => {
  const page = boot([reply({ python: { found: true, version: "3.7.17", supported: false } }), REPLY]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "tools");
  await page.tick();
  assert.deepEqual(page.sent.at(-1), { type: "ping", reconnect: true });
  assert.equal(page.el("setup-card").dataset.state, "ready");
  assert.deepEqual(page.pollDelays(), []);
});

test("unsupported Python asks to update Python and reinstall the helper, independently of yt-dlp repair", async () => {
  const python = { found: true, supported: false, version: "3.7.17" };
  const page = boot([reply({ python })]);
  await flush();
  assert.equal(page.el("state-title").textContent, "Update Python");
  assert.match(page.el("state-lead").textContent, /Python 3\.8\+ is unsupported/);
  assert.match(page.el("state-lead").textContent, /Install Python 3\.8 or newer and reinstall the helper/);
  assert.doesNotMatch(page.el("state-lead").textContent, /Update yt-dlp/);
  const mixed = boot([reply({ python, ytDlp: { found: true, version: "" } })]);
  await flush();
  assert.match(mixed.el("state-lead").textContent, /Install Python 3\.8 or newer and reinstall the helper/);
  assert.match(mixed.el("state-lead").textContent, /Update yt-dlp with your package manager/);
});

test("warnings pause polling when hidden and visibility recovery immediately detects fixes", async () => {
  const page = boot([reply({ jsRuntime: null, picker: null }), REPLY]);
  await flush();
  await page.setHidden(true);
  assert.deepEqual(page.pollDelays(), []);
  assert.equal(page.el("poll-text").textContent, "Paused while this tab is in the background.");
  assert.equal(page.el("poll-status").dataset.active, "false");
  assert.equal(page.sent.length, 1);
  await page.setHidden(false);
  assert.equal(page.sent.length, 2);
  assert.equal(page.el("ready-warning").hidden, true);
  assert.deepEqual(page.pollDelays(), []);
});

test("missing-helper polling also pauses and resumes", async () => {
  const page = boot([MISSING]);
  await flush();
  await page.setHidden(true);
  assert.deepEqual(page.pollDelays(), []);
  await page.setHidden(false);
  assert.equal(page.sent.length, 2);
  assert.deepEqual(page.pollDelays(), [2500]);
});

test("a response arriving after the tab is hidden cannot restart polling or overlap checks", async () => {
  let resolve;
  const delayed = new Promise((done) => { resolve = done; });
  const page = boot([() => delayed]);
  await page.el("check-again").click();
  await page.setHidden(true);
  assert.equal(page.sent.length, 1);
  resolve(reply({ picker: null }));
  await flush();
  assert.deepEqual(page.pollDelays(), []);
  assert.equal(page.el("poll-status").dataset.active, "false");
});

test("visibility recovery rechecks even a previously healthy page", async () => {
  const page = boot([REPLY, reply({ ffprobe: { found: false } })]);
  await flush();
  assert.deepEqual(page.pollDelays(), []);
  await page.setHidden(true);
  await page.setHidden(false);
  assert.equal(page.sent.length, 2);
  assert.equal(page.el("setup-card").dataset.state, "tools");
  assert.deepEqual(page.pollDelays(), [2500]);
});

test("Check again pings immediately, including after Ready", async () => {
  const page = boot([REPLY, MISSING]);
  await flush();
  await page.el("check-again").click();
  await flush();
  assert.equal(page.sent.length, 2);
  assert.equal(page.el("setup-card").dataset.state, "missing");
  assert.deepEqual(page.pollDelays(), [2500]);
});

test("failed background messaging becomes bootstrap guidance even for a non-Error rejection", async () => {
  for (const response of [new Error("Receiving end does not exist"), null]) {
    const page = boot([response]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "missing");
    assert.match(page.el("error-text").textContent, /Background page unavailable/);
  }
});

test("wget-only diagnostics choose a pinned wget pipeline and Copy follows the displayed command", async () => {
  const page = boot([reply({ setupLauncher: { found: false, path: null }, downloader: { found: true, name: "wget", path: "/usr/bin/wget" }, picker: null })]);
  await flush();
  const command = `wget -qO- https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v${VERSION}/setup.sh | bash`;
  assert.equal(page.el("command").textContent, command);
  assert.equal(page.el("command-block").hidden, false);
  assert.match(page.el("command-alternatives").textContent, /Using wget/);
  await page.el("copy").click();
  assert.deepEqual(page.state.copied, [command]);
});

test("verified launcher is preferred over both downloaders and Copy is the real short command", async () => {
  for (const downloader of [{ found: true, name: "curl" }, { found: true, name: "wget" }, { found: false }, undefined]) {
    const page = boot([reply({ downloader, picker: null, setupLauncher: { ...READY_PONG.setupLauncher, command: "echo unsafe" } })]);
    await flush();
    const command = `"$HOME/.local/bin/ytdlp-setup" ${VERSION}`;
    assert.equal(page.el("setup-card").dataset.state, "ready");
    assert.equal(page.el("command-block").hidden, false);
    assert.equal(page.el("command").textContent, command);
    assert.match(page.el("command-label").textContent, /terminal anywhere/);
    assert.match(page.el("command-alternatives").textContent, /verified setup launcher.*asks before installing dependencies/);
    assert.equal(page.el("download-step").hidden, true);
    assert.equal(page.el("command-hint").hidden, false);
    assert.doesNotMatch(page.el("command").textContent, /python|urllib|subprocess|unsafe|-c /i);
    await page.el("copy").click();
    assert.deepEqual(page.state.copied, [command]);
  }
});

test("manual bootstrap downloads first, then copies only bash with a trailing space before dragging the file", async () => {
  const page = boot([reply({ setupLauncher: { found: false, path: null }, downloader: { found: false } })]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "ready");
  assert.equal(page.el("command").textContent, "bash ");
  assert.equal(page.el("download-step").hidden, false);
  assert.equal(page.el("command-hint").hidden, true);
  assert.match(HTML, /id="download-step"[^>]*>1\. First, use Download setup\.sh/);
  assert.ok(HTML.indexOf('id="download-step"') < HTML.indexOf('id="script-link"'));
  assert.ok(HTML.indexOf('id="script-link"') < HTML.indexOf('id="command-label"'));
  assert.match(HTML, /id="script-link"[^>]*>Download setup\.sh<\/a>/);
  assert.match(page.el("command-label").textContent, /2\..*bash followed by one space.*Do not press Enter yet/);
  assert.match(page.el("command-alternatives").textContent, /3\. Drag the actual downloaded.*full path.*then press Enter/);
  assert.match(page.el("command-alternatives").textContent, /downloads list.*reveal-folder action/);
  assert.doesNotMatch(page.el("command-alternatives").textContent, /~\/Downloads|bash setup\.sh|Python/);
  await page.el("copy").click();
  assert.deepEqual(page.state.copied, ["bash "]);
  assert.match(page.el("copy-status").textContent, /trailing space.*drag the downloaded file/);
});

test("old or malformed launcher reports offer honest bootstrap guidance rather than the short command", async () => {
  for (const setupLauncher of [undefined, null, { found: true, path: "/tmp/unsafe" }, { found: "true", path: READY_PONG.setupLauncher.path },
    { found: false, path: null }]) {
    const page = boot([reply({ hostVersion: "1.2.0", setupLauncher })]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "outdated");
    assert.match(page.el("state-lead").textContent, /needs 1\.3\.0 or newer/);
    assert.equal(page.el("command").textContent, setupCommand(VERSION, "curl"));
    assert.match(page.el("command-alternatives").textContent, /bootstrap.*working setup launcher has not been confirmed/);
    assert.equal(rows(page).get("setupLauncher").dataset.status, setupLauncher?.found === false ? "warn" : "pending");
  }
  const capable = boot([reply({ hostVersion: "1.2.0" })]);
  await flush();
  assert.equal(capable.el("command").textContent, setupCommand(VERSION, "launcher"));
  assert.match(capable.el("state-lead").textContent, /needs 1\.3\.0 or newer/);
});

test("unknown downloader and unverified launcher offer conditional curl and wget with a manual alternative", async () => {
  const page = boot([reply({ setupLauncher: undefined, downloader: undefined })]);
  await flush();
  assert.equal(page.el("command").textContent, setupCommand(VERSION, "curl"));
  assert.match(page.el("command-label").textContent, /If curl is installed/);
  assert.match(page.el("command-alternatives").textContent, /has not reported which downloader.*If wget is installed.*Browser alternative/);
  assert.match(page.el("command-alternatives").textContent, /Download setup\.sh.*bash followed by one space.*drag.*full path/);
});

test("Copy feedback resets and follows a changed setup method", async () => {
  const page = boot([MISSING, reply({ downloader: { found: false } })]);
  await flush();
  await page.el("copy").click();
  assert.equal(page.el("copy-status").dataset.state, "ok");
  assert.equal(page.el("copy").textContent, "Copied ✓");
  await page.tick();
  const command = setupCommand(VERSION, "launcher");
  assert.equal(page.el("command").textContent, command);
  assert.equal(page.el("copy").textContent, "Copy");
  assert.equal(page.el("copy-status").textContent, "");
  await page.el("copy").click();
  assert.deepEqual(page.state.copied, [setupCommand(VERSION, "curl"), command]);
});

test("Copy failure selects the exact displayed launcher command or manual prefix", async () => {
  for (const [patch, command] of [[{}, setupCommand(VERSION, "launcher")],
    [{ setupLauncher: { found: false, path: null }, downloader: { found: false } }, "bash "]]) {
    const page = boot([reply({ ...patch, picker: null })], { clipboard: async () => { throw new Error("NotAllowedError"); } });
    await flush();
    await page.el("copy").click();
    assert.ok(page.state.selected >= 1);
    assert.equal(page.el("command").textContent, command);
    assert.deepEqual(page.state.copied, [command]);
    assert.equal(page.el("copy-status").dataset.state, "error");
    assert.match(page.el("copy-status").textContent, /press Ctrl\+C/);
    if (command === "bash ") assert.match(page.el("copy-status").textContent, /one space follows bash/);
  }
});

test("native diagnostics and browser errors are rendered as plain text", async () => {
  const unsafe = '<img src=x onerror="alert(1)">';
  const page = boot([reply({ picker: unsafe, ytDlp: { found: true, version: unsafe }, jsRuntime: { name: unsafe, path: unsafe } }),
    { ok: false, error: unsafe }]);
  await flush();
  assert.equal(part(rows(page).get("picker"), "check-detail").textContent, unsafe);
  assert.equal(part(rows(page).get("ytdlp"), "check-detail").textContent, `Version ${unsafe}`);
  assert.equal(part(rows(page).get("jsRuntime"), "check-detail").textContent, `${unsafe} (${unsafe})`);
  await page.el("check-again").click();
  await flush();
  assert.equal(page.el("error-text").textContent, unsafe);
});

test("version badge, platform footer and external-only scripts are preserved", async () => {
  const page = boot([REPLY]);
  await flush();
  assert.equal(page.el("extension-version").textContent, `v${VERSION}`);
  assert.match(HTML, /Linux only, and you need a terminal/);
  assert.match(HTML, /Flatpak and Snap builds can only reach the helper under some conditions/);
  assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
  for (const script of HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(script[1], /src=/);
    assert.equal(script[2].trim(), "");
  }
});


test("helper-update and incomplete-report states retain confirmed tool repair guidance", async () => {
  for (const patch of [{ hostVersion: "1.1.0" }, { ffprobe: undefined }]) {
    const page = boot([reply({ ...patch, ytDlp: { found: true, version: null },
      python: { found: true, version: "3.7.17", supported: false } })]);
    await flush();
    assert.equal(page.el("setup-card").dataset.state, "outdated");
    assert.match(page.el("state-lead").textContent, /does not automatically replace an existing broken yt-dlp/);
    assert.match(page.el("state-lead").textContent, /Install Python 3\.8 or newer and reinstall the helper/);
    assert.equal(page.el("command-block").hidden, false);
  }
});
