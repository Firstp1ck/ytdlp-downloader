"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const READY = {
  hostVersion: "1.2.0",
  python: { found: true, version: "3.12.0", supported: true, path: "/usr/bin/python3" },
  ytDlp: { found: true, version: "2026.10.21", path: "/usr/bin/yt-dlp" },
  ffmpeg: { found: true, path: "/usr/bin/ffmpeg" },
  ffprobe: { found: true, path: "/usr/bin/ffprobe" },
  jsRuntime: { name: "deno", path: "/usr/bin/deno" },
  picker: "zenity",
  opener: { found: true, path: "/usr/bin/xdg-open" },
  userDirs: { found: true, path: "/usr/bin/xdg-user-dir" },
  downloader: { found: true, name: "curl", path: "/usr/bin/curl" },
  coreutils: { found: true, missing: [] },
  nativeMessagingProxy: { found: false, path: null, applicable: null },
  defaultSaveDir: "/home/test/Downloads",
};

class Element {
  constructor(attributes = "") {
    this.name = /\bname="([^"]+)"/.exec(attributes)?.[1] ?? "";
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.classList = { add() {} };
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this._text = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  add(value) { this.children.push(value); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  setAttribute(name, value) { this[name] = String(value); }
}

/** Run the real settings/popup scripts without a browser or native host. */
async function boot(page, pong) {
  const html = fs.readFileSync(path.join(ROOT, `${page}/${page}.html`), "utf8");
  const elements = new Map([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
    .map((match) => [match[1], new Element(match[0])]));
  const document = {
    body: new Element(),
    activeElement: null,
    getElementById(id) {
      assert.ok(elements.has(id), `Missing #${id} in ${page}`);
      return elements.get(id);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-browse]");
      return ["videoSaveDir", "audioSaveDir"].map((key) => {
        const button = new Element();
        button.dataset.browse = key;
        return button;
      });
    },
    createElement() { return new Element(); },
  };
  const context = vm.createContext({
    document,
    browser: {
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: {
        getManifest: () => ({ version: "1.3.1" }),
        sendMessage: async (message) => message.type === "getState"
          ? { downloads: [], host: { reachable: true, pong } }
          : { ok: true, pong },
        openOptionsPage: async () => {},
        onMessage: { addListener() {} },
      },
    },
    Option: class { constructor(label, value) { this.textContent = label; this.value = value; } },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: () => 1,
    clearTimeout() {},
    window: { close() {} },
    console,
  });
  for (const file of ["shared/settings.js", "shared/downloads.js", "shared/setup-info.js", `${page}/${page}.js`]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  return (id) => document.getElementById(id);
}

test("settings and popup do not warn for a healthy host with unknown proxy applicability", async () => {
  const settings = await boot("options", READY);
  assert.equal(settings("host-summary").dataset.state, "ok");
  assert.equal(settings("host-summary-text").textContent, "Connected");
  assert.match(settings("host-ytdlp").textContent, /\/usr\/bin\/yt-dlp/);
  assert.match(settings("host-ffmpeg").textContent, /\/usr\/bin\/ffmpeg/);
  assert.equal(settings("host-install-hint").hidden, true);
  const popup = await boot("popup", READY);
  assert.equal(popup("setup-banner").hidden, true);
});

test("old helper versions request an update in settings and popup", async () => {
  const pong = { ...READY, hostVersion: "1.1.0" };
  const settings = await boot("options", pong);
  assert.match(settings("host-install-text").textContent, /version 1\.1\.0 needs to be 1\.2\.0 or newer/);
  const popup = await boot("popup", pong);
  assert.equal(popup("setup-banner").hidden, false);
  assert.match(popup("setup-text").textContent, /helper program needs an update/);
});

test("settings and popup surface missing ffprobe instead of claiming full readiness", async () => {
  const pong = { ...READY, ffprobe: { found: false, path: null } };
  const settings = await boot("options", pong);
  assert.equal(settings("host-summary").dataset.state, "warn");
  assert.match(settings("host-summary-text").textContent, /ffprobe is missing/);
  assert.equal(settings("host-install-hint").hidden, false);
  const popup = await boot("popup", pong);
  assert.equal(popup("setup-banner").hidden, false);
  assert.match(popup("setup-text").textContent, /ffprobe is missing/);
});

test("optional desktop tool warnings link both consumers to setup without blocking downloads", async () => {
  const pong = { ...READY, picker: null, opener: { found: false, path: null } };
  const settings = await boot("options", pong);
  assert.match(settings("host-install-text").textContent, /Folder picker and Folder opener/);
  assert.match(settings("host-install-text").textContent, /Downloads are not blocked/);
  assert.equal(settings("host-picker").children[0].className, "recommended");
  const popup = await boot("popup", pong);
  assert.match(popup("setup-text").textContent, /optional or setup checks/);
  assert.equal(popup("open-setup").textContent, "Review setup");
});

test("incomplete current-helper diagnostics are not described as an older helper version", async () => {
  const { python, ...pong } = READY;
  const settings = await boot("options", pong);
  assert.match(settings("host-install-text").textContent, /not confirmed/);
  assert.doesNotMatch(settings("host-install-text").textContent, /version 1\.2\.0 needs/);
  const popup = await boot("popup", pong);
  assert.match(popup("setup-text").textContent, /required diagnostics are not confirmed/);
});

test("settings distinguish unsupported Python from an existing broken yt-dlp", async () => {
  const settings = await boot("options", {
    ...READY,
    python: { found: true, version: "3.7.9", supported: false },
    ytDlp: { found: true, version: null },
  });
  assert.match(settings("host-install-text").textContent, /Install Python 3\.8 or newer/);
  assert.match(settings("host-install-text").textContent, /does not replace an existing executable/);
});
