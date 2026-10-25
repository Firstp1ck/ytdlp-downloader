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

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "setup/setup.html"), "utf8");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const READY_PONG = {
  type: "pong",
  hostVersion: "1.1.0",
  ytDlp: { found: true, path: "/usr/bin/yt-dlp", version: "2026.10.21" },
  ffmpeg: { found: true, path: "/usr/bin/ffmpeg" },
  jsRuntime: { name: "deno", path: "/home/user/.deno/bin/deno" },
};
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
function boot(replies, { clipboard = async () => {} } = {}) {
  const elements = pageElements();
  const sent = [];
  const timers = new Map();
  let nextTimer = 1;
  const state = { selected: 0, optionsOpened: 0, copied: [] };
  const documentListeners = {};
  const document = {
    hidden: false,
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
        const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
        if (reply instanceof Error) throw reply;
        return structuredClone(reply);
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

/** "label:status" per checklist row */
function checklist(page) {
  return page.el("checklist").children.map((row) => `${row.children[1].textContent}:${row.dataset.status}`);
}

test("missing helper: explanation, command, links, and polling every 2.5 s", async () => {
  const page = boot([MISSING]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "missing");
  assert.equal(page.el("state-title").textContent, "Install the helper");
  assert.match(page.el("state-lead").textContent, /can't run programs by itself/);
  assert.equal(page.el("command-block").hidden, false);
  assert.equal(
    page.el("command").textContent,
    `curl -fsSL https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v${VERSION}/setup.sh | bash`,
  );
  assert.equal(page.el("script-link").href, `https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v${VERSION}/setup.sh`);
  assert.equal(page.el("manual-link").href, "https://github.com/Firstp1ck/ytdlp-downloader#install");
  assert.equal(page.el("error-details").hidden, false);
  assert.match(page.el("error-text").textContent, /No such native application/);
  assert.equal(page.el("ready-block").hidden, true);
  assert.equal(page.el("poll-text").textContent, "Waiting for the helper…");
  assert.equal(page.el("poll-status").dataset.active, "true");
  assert.deepEqual(checklist(page), [
    "Helper program:bad",
    "yt-dlp:pending",
    "ffmpeg:pending",
    "JavaScript runtime:pending",
  ]);
  assert.equal(page.el("announce").textContent, "Install the helper");
  assert.deepEqual(page.pollDelays(), [2500]);
  assert.deepEqual(page.sent, [{ type: "ping", reconnect: false }]);
});

test("polling flips to Ready on its own and then stops", async () => {
  const page = boot([MISSING, MISSING, { ok: true, pong: READY_PONG }]);
  await flush();
  await page.tick();
  assert.equal(page.el("setup-card").dataset.state, "missing");
  await page.tick();
  assert.equal(page.sent.length, 3);
  assert.equal(page.el("setup-card").dataset.state, "ready");
  assert.equal(page.el("state-title").textContent, "Ready to download");
  assert.equal(page.el("announce").textContent, "Ready to download");
  assert.equal(page.el("command-block").hidden, true);
  assert.equal(page.el("error-details").hidden, true);
  assert.equal(page.el("ready-block").hidden, false);
  assert.equal(page.el("poll-status").hidden, true);
  assert.equal(page.el("ready-warning").hidden, true);
  assert.deepEqual(checklist(page), ["Helper program:ok", "yt-dlp:ok", "ffmpeg:ok", "JavaScript runtime:ok"]);
  assert.equal(page.el("checklist").children[3].children[3].textContent, "deno (/home/user/.deno/bin/deno)");
  assert.deepEqual(page.pollDelays(), [], "no further polls once ready");

  await page.el("open-settings").click();
  assert.equal(page.state.optionsOpened, 1);
});

test("polling pauses while the tab is hidden and resumes with an immediate check", async () => {
  const page = boot([MISSING]);
  await flush();
  await page.setHidden(true);
  assert.deepEqual(page.pollDelays(), []);
  assert.equal(page.el("poll-text").textContent, "Paused while this tab is in the background.");
  assert.equal(page.el("poll-status").dataset.active, "false");

  await page.setHidden(false);
  assert.equal(page.sent.length, 2, "becoming visible checks right away");
  assert.deepEqual(page.pollDelays(), [2500]);
  assert.equal(page.el("poll-text").textContent, "Waiting for the helper…");
});

test("Check again pings immediately, and also after Ready", async () => {
  const page = boot([{ ok: true, pong: READY_PONG }, MISSING]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "ready");
  await page.el("check-again").click();
  await flush();
  assert.equal(page.sent.length, 2);
  assert.equal(page.el("setup-card").dataset.state, "missing");
  assert.deepEqual(page.pollDelays(), [2500], "polling resumes when something broke");
});

test("an outdated helper says Update and the next ping asks for a fresh connection", async () => {
  const page = boot([{ ok: true, pong: { ...READY_PONG, hostVersion: "0.9.0" } }, { ok: true, pong: READY_PONG }]);
  await flush();
  assert.equal(page.el("state-title").textContent, "Update the helper");
  assert.match(page.el("state-lead").textContent, /version 0\.9\.0; this extension needs 1\.1\.0 or newer/);
  assert.equal(page.el("command-block").hidden, false);
  await page.tick();
  assert.deepEqual(page.sent.at(-1), { type: "ping", reconnect: true });
  assert.equal(page.el("setup-card").dataset.state, "ready");
});

test("missing tools are named, with the same command", async () => {
  const pong = { ...READY_PONG, ytDlp: { found: false }, ffmpeg: { found: false } };
  const page = boot([{ ok: true, pong }]);
  await flush();
  assert.equal(page.el("state-title").textContent, "Install yt-dlp and ffmpeg");
  assert.match(page.el("state-lead").textContent, /yt-dlp and ffmpeg are missing\. Run the same command again/);
  assert.equal(page.el("command-block").hidden, false);
  assert.equal(page.el("poll-text").textContent, "Waiting for yt-dlp and ffmpeg…");
  assert.deepEqual(checklist(page), ["Helper program:ok", "yt-dlp:bad", "ffmpeg:bad", "JavaScript runtime:ok"]);
});

test("yt-dlp that is installed but doesn't run asks to update or remove it first", async () => {
  const pong = { ...READY_PONG, ytDlp: { found: true, path: "/usr/bin/yt-dlp", version: null } };
  const page = boot([{ ok: true, pong }]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "tools");
  assert.equal(page.el("state-title").textContent, "Repair yt-dlp");
  assert.equal(
    page.el("state-lead").textContent,
    "The helper is connected, but yt-dlp doesn't run, often because the system's Python is too old for it. " +
      "Update yt-dlp with your package manager, or remove it and run the same command again, which installs a working one.",
  );
  assert.equal(page.el("command-block").hidden, false);
  assert.equal(page.el("ready-block").hidden, true);
  assert.equal(page.el("poll-text").textContent, "Waiting for yt-dlp…");
  assert.deepEqual(page.pollDelays(), [2500]);
  assert.deepEqual(checklist(page), ["Helper program:ok", "yt-dlp:bad", "ffmpeg:ok", "JavaScript runtime:ok"]);
  assert.equal(page.el("checklist").children[1].children[3].textContent, "Installed but doesn't run");
});

test("a broken yt-dlp and a missing ffmpeg are both named", async () => {
  const pong = { ...READY_PONG, ytDlp: { found: true, version: "" }, ffmpeg: { found: false } };
  const page = boot([{ ok: true, pong }]);
  await flush();
  assert.equal(page.el("state-title").textContent, "Install ffmpeg and repair yt-dlp");
  assert.match(page.el("state-lead").textContent, /ffmpeg is missing, and yt-dlp doesn't run/);
  assert.match(page.el("state-lead").textContent, /installs a working one together with what's missing\.$/);
  assert.equal(page.el("poll-text").textContent, "Waiting for ffmpeg and yt-dlp…");
});

test("no JavaScript runtime: ready, with a visible warning and the command", async () => {
  const page = boot([{ ok: true, pong: { ...READY_PONG, jsRuntime: null } }, { ok: true, pong: READY_PONG }]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "ready");
  assert.equal(page.el("state-title").textContent, "Ready to download");
  assert.equal(page.el("ready-block").hidden, false);
  assert.equal(page.el("ready-warning").hidden, false);
  assert.equal(page.el("command-block").hidden, false, "the command installs Deno");
  assert.equal(page.el("error-details").hidden, true);
  assert.deepEqual(checklist(page), ["Helper program:ok", "yt-dlp:ok", "ffmpeg:ok", "JavaScript runtime:warn"]);
  const row = page.el("checklist").children[3];
  assert.equal(row.children[0].textContent, "⚠");
  assert.equal(row.children[2].textContent, ": Recommended.");
  assert.equal(row.children[3].textContent, "Recommended for YouTube: run the setup command again to install Deno");
  assert.deepEqual(page.pollDelays(), [], "ready stops polling even with the warning");

  await page.el("check-again").click();
  await flush();
  assert.equal(page.el("ready-warning").hidden, true, "Check again picks up a newly installed runtime");
  assert.equal(page.el("command-block").hidden, true);
  assert.deepEqual(checklist(page), ["Helper program:ok", "yt-dlp:ok", "ffmpeg:ok", "JavaScript runtime:ok"]);
});

test("the runtime warning stays out of states that already show the command", async () => {
  const pong = { ...READY_PONG, jsRuntime: null, ffmpeg: { found: false } };
  const page = boot([{ ok: true, pong }]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "tools");
  assert.equal(page.el("ready-warning").hidden, true);
  assert.deepEqual(checklist(page), ["Helper program:ok", "yt-dlp:ok", "ffmpeg:bad", "JavaScript runtime:warn"]);
});

test("a background page that is gone counts as missing, not as a crash", async () => {
  const page = boot([new Error("Receiving end does not exist")]);
  await flush();
  assert.equal(page.el("setup-card").dataset.state, "missing");
  assert.match(page.el("error-text").textContent, /Background page unavailable: Receiving end does not exist/);
});

test("Copy writes the command and shows feedback that resets", async () => {
  const page = boot([MISSING]);
  await flush();
  await page.el("copy").click();
  assert.deepEqual(page.state.copied, [page.el("command").textContent]);
  assert.equal(page.el("copy-status").dataset.state, "ok");
  assert.match(page.el("copy-status").textContent, /^Copied/);
  assert.equal(page.el("copy").textContent, "Copied ✓");
  await page.tick();
  assert.equal(page.el("copy").textContent, "Copy");
  assert.equal(page.el("copy-status").textContent, "");
});

test("Copy falls back to selecting the command", async () => {
  const page = boot([MISSING], {
    clipboard: async () => {
      throw new Error("NotAllowedError");
    },
  });
  await flush();
  await page.el("copy").click();
  assert.ok(page.state.selected >= 1, "the command text is selected");
  assert.equal(page.el("copy-status").dataset.state, "error");
  assert.match(page.el("copy-status").textContent, /press Ctrl\+C/);
});
