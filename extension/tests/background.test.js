"use strict";

/*
 * Runs the real background scripts, in manifest order, inside a vm context with
 * a fake `browser` API. Covers menu wiring, the native port lifecycle, and the
 * protocol messages the background page sends and handles.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const EXTENSION_ID = MANIFEST.browser_specific_settings.gecko.id;
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PLAYLIST = "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    emit: (...args) => listeners.map((fn) => fn(...args)),
  };
}

function fakePort(name) {
  return {
    name,
    posted: [],
    dead: false,
    error: null,
    onMessage: event(),
    onDisconnect: event(),
    postMessage(message) {
      if (this.dead) throw new Error("Attempt to postMessage on disconnected port");
      this.posted.push(structuredClone(message));
    },
    disconnect() {
      this.dead = true;
    },
    /** Simulates the host process going away. */
    die(message) {
      this.dead = true;
      this.error = message ? { message } : null;
      this.onDisconnect.emit(this);
    },
    reply(message) {
      this.onMessage.emit(message);
    },
  };
}

/** Copies a value out of the vm realm so deepStrictEqual compares structure, not prototypes. */
function local(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Loads the background page into a fresh context. */
function boot({ settings } = {}) {
  const storage = settings ? { settings: structuredClone(settings) } : {};
  const state = { ports: [], menus: [], notifications: [], cleared: [], badge: null, optionsOpened: 0, tabs: [] };
  const browser = {
    runtime: {
      id: EXTENSION_ID,
      lastError: null,
      getURL: (p) => `moz-extension://test/${p}`,
      connectNative(name) {
        const port = fakePort(name);
        state.ports.push(port);
        return port;
      },
      onMessage: event(),
      onInstalled: event(),
      sendMessage: async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
      openOptionsPage: async () => {
        state.optionsOpened += 1;
      },
    },
    storage: {
      local: {
        get: async (key) => (key in storage ? { [key]: structuredClone(storage[key]) } : {}),
        set: async (items) => Object.assign(storage, structuredClone(items)),
      },
    },
    menus: {
      removeAll: async () => {
        state.menus.length = 0;
      },
      create: (props) => state.menus.push(local(props)),
      onClicked: event(),
    },
    notifications: {
      create: async (id, options) => {
        state.notifications.push({ id, ...options });
        return id;
      },
      clear: async (id) => {
        state.cleared.push(id);
        return true;
      },
      onClicked: event(),
      onClosed: event(),
    },
    tabs: {
      create: async (props) => {
        state.tabs.push(local(props));
        return { id: state.tabs.length };
      },
    },
    browserAction: {
      setBadgeText: async ({ text }) => {
        state.badge = text;
      },
      setBadgeBackgroundColor: async () => {},
    },
  };

  const context = vm.createContext({
    browser,
    console: { warn() {}, log() {}, error() {} },
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    URL,
    structuredClone,
  });
  for (const script of MANIFEST.background.scripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, script), "utf8"), context, { filename: script });
  }

  const port = () => state.ports.at(-1);
  return {
    browser,
    state,
    port,
    click: (menuItemId, info) => browser.menus.onClicked.emit({ menuItemId, ...info }, { id: 1 }),
    send(message, sender = { id: EXTENSION_ID, url: "moz-extension://test/popup/popup.html" }) {
      const result = browser.runtime.onMessage.emit(message, sender)[0];
      return result === undefined ? undefined : Promise.resolve(result).then(local);
    },
    /** The newest download message posted to the current port. */
    lastDownload: () => port().posted.filter((m) => m.type === "download").at(-1),
  };
}

/** Lets pending promise chains (storage reads, notifications) settle. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("startup creates link and page/video menu sets", async () => {
  const bg = boot();
  await flush();
  assert.deepEqual(bg.state.menus.map((m) => m.id), [
    "link:video", "link:audio", "link:settings", "page:video", "page:audio", "page:settings",
  ]);
  const link = bg.state.menus.find((m) => m.id === "link:video");
  assert.deepEqual(link.contexts, ["link"]);
  assert.ok(link.targetUrlPatterns.includes("*://youtu.be/*"));
  assert.equal(link.documentUrlPatterns, undefined, "link items must show on any page");
  const page = bg.state.menus.find((m) => m.id === "page:video");
  assert.deepEqual(page.contexts, ["page", "video"]);
  assert.ok(page.documentUrlPatterns.includes("*://*.youtube.com/watch*"));
  assert.equal(bg.state.menus.find((m) => m.id === "page:settings").title, "yt-dlp Settings…");
  assert.equal(bg.state.ports.length, 0, "the native port connects lazily");
});

test("settings menu opens the options page", async () => {
  const bg = boot();
  bg.click("link:settings", {});
  await flush();
  assert.equal(bg.state.optionsOpened, 1);
});

test("Download Video on a link sends the video defaults to the host", async () => {
  const bg = boot({ settings: { videoResolution: "720", videoSaveDir: "~/Videos", audioSaveDir: "~/Music" } });
  bg.click("link:video", { linkUrl: `${VIDEO}&si=track`, pageUrl: "https://example.org/" });
  await flush();
  assert.equal(bg.port().name, "dev.firstpick.ytdlp_downloader");
  const message = bg.lastDownload();
  assert.equal(message.url, VIDEO);
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(message.options, {
    mode: "video", videoResolution: "720", videoFormat: "mp4", audioQuality: "best",
    audioFormat: "mp3", saveDir: "~/Videos", playlist: false,
  });
  assert.equal(bg.state.badge, "1");
});

test("Download Audio uses the audio defaults; video context uses the page URL", async () => {
  const bg = boot({ settings: { audioFormat: "opus", videoSaveDir: "~/Videos", audioSaveDir: "~/Music" } });
  bg.click("page:audio", { srcUrl: "blob:https://www.youtube.com/abc", pageUrl: VIDEO, mediaType: "video" });
  await flush();
  const message = bg.lastDownload();
  assert.equal(message.url, VIDEO);
  assert.equal(message.options.mode, "audio");
  assert.equal(message.options.audioFormat, "opus");
  assert.equal(message.options.saveDir, "~/Music");
});

test("each action has its own playlist setting", async () => {
  const bg = boot({ settings: { videoPlaylist: true, audioPlaylist: false } });
  bg.click("link:video", { linkUrl: PLAYLIST });
  await flush();
  assert.equal(bg.lastDownload().options.playlist, true);
  const sent = bg.port().posted.length;
  bg.click("link:audio", { linkUrl: PLAYLIST });
  await flush();
  assert.equal(bg.port().posted.length, sent, "audio playlists are off, so nothing is sent");
  assert.match(bg.state.notifications.at(-1).message, /under Audio/);
});

test("one long-lived port is reused across downloads", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  bg.click("link:audio", { linkUrl: VIDEO });
  await flush();
  assert.equal(bg.state.ports.length, 1);
  assert.equal(bg.port().posted.filter((m) => m.type === "download").length, 2);
  assert.equal(bg.state.badge, "2");
});

test("host lifecycle events update state, badge, and notifications", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  const { id } = bg.lastDownload();
  bg.port().reply({ type: "queued", id });
  bg.port().reply({ type: "started", id, saveDir: "/home/u/Downloads" });
  bg.port().reply({ type: "progress", id, status: "downloading", percent: 50, speed: "1MiB/s", eta: "00:05", title: "Song" });
  await flush();
  let state = await bg.send({ type: "getState" });
  assert.equal(state.downloads[0].status, "downloading");
  assert.equal(state.downloads[0].title, "Song");
  assert.equal(bg.state.notifications.at(-1).title, "Download started");

  bg.port().reply({ type: "finished", id, files: ["/home/u/Downloads/Song [dQw4w9WgXcQ].mp4"] });
  await flush();
  state = await bg.send({ type: "getState" });
  assert.equal(state.downloads[0].status, "finished");
  assert.equal(bg.state.badge, "");
  const finished = bg.state.notifications.at(-1);
  assert.equal(finished.title, "Download finished");

  bg.browser.notifications.onClicked.emit(finished.id);
  assert.deepEqual(bg.port().posted.at(-1), { type: "openPath", path: "/home/u/Downloads" });
  assert.ok(bg.state.cleared.includes(finished.id));

  assert.deepEqual(await bg.send({ type: "openFolder", id }), { ok: true });
  assert.deepEqual(bg.port().posted.at(-1), { type: "openPath", path: "/home/u/Downloads" });
});

test("host errors for a download mark it failed and notify", async () => {
  const bg = boot();
  bg.click("link:audio", { linkUrl: VIDEO });
  await flush();
  const { id } = bg.lastDownload();
  bg.port().reply({ type: "error", id, code: "ffmpeg_missing", message: "ffmpeg is required for audio conversion" });
  await flush();
  const [entry] = (await bg.send({ type: "getState" })).downloads;
  assert.equal(entry.status, "error");
  assert.equal(entry.errorCode, "ffmpeg_missing");
  assert.equal(bg.state.notifications.at(-1).title, "Download failed");
  assert.equal(bg.state.badge, "");
});

test("notifications setting off suppresses lifecycle notifications", async () => {
  const bg = boot({ settings: { notifications: false } });
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  const { id } = bg.lastDownload();
  bg.port().reply({ type: "started", id, saveDir: "/tmp" });
  bg.port().reply({ type: "finished", id, files: ["/tmp/a.mp4"] });
  await flush();
  assert.equal(bg.state.notifications.length, 0);
});

test("non-YouTube targets never reach the host", async () => {
  const bg = boot({ settings: { notifications: false } });
  bg.click("link:video", { linkUrl: "javascript:alert(1)", pageUrl: VIDEO });
  bg.click("page:video", { pageUrl: "https://www.youtube.com/feed/subscriptions" });
  await flush();
  assert.equal(bg.state.ports.length, 0);
  assert.equal(bg.state.notifications.length, 2, "click failures notify even with notifications off");
  assert.equal(bg.state.notifications[0].title, "Not a YouTube video");
});

test("playlist URLs require the playlist setting", async () => {
  const off = boot();
  off.click("link:video", { linkUrl: PLAYLIST });
  await flush();
  assert.equal(off.state.ports.length, 0);
  assert.equal(off.state.notifications.at(-1).title, "Playlist downloads are off");

  const on = boot({ settings: { videoPlaylist: true } });
  on.click("link:video", { linkUrl: PLAYLIST });
  await flush();
  assert.equal(on.lastDownload().url, PLAYLIST);
  assert.equal(on.lastDownload().options.playlist, true);
});

test("watch URL with list= is sent even when playlists are off", async () => {
  const bg = boot();
  const url = `${VIDEO}&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf`;
  bg.click("link:video", { linkUrl: url });
  await flush();
  assert.equal(bg.lastDownload().url, url);
  assert.equal(bg.lastDownload().options.playlist, false);
});

test("missing host: downloads fail with the install hint, next click reconnects", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  bg.port().die("No such native application dev.firstpick.ytdlp_downloader");
  await flush();
  const [entry] = (await bg.send({ type: "getState" })).downloads;
  assert.equal(entry.status, "error");
  assert.match(entry.error, /not installed.*setup page/);
  assert.match(bg.state.notifications.at(-1).message, /Click to open the setup page/);
  assert.equal(bg.state.badge, "");

  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  assert.equal(bg.state.ports.length, 2);
  assert.equal(bg.port().posted.length, 1);
});

test("a dead port that throws on post is replaced without failing the new download", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  bg.port().dead = true; // post throws, onDisconnect not yet delivered
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  assert.equal(bg.state.ports.length, 2);
  const [first, second] = bg.state.ports.map((p) => p.posted[0].id);
  const byId = new Map((await bg.send({ type: "getState" })).downloads.map((d) => [d.id, d.status]));
  assert.equal(byId.get(first), "error", "the download on the dead port fails");
  assert.equal(byId.get(second), "pending", "the download sent on the fresh port survives cleanup");
});

test("ping replies with the pong and records host status", async () => {
  const bg = boot();
  const reply = bg.send({ type: "ping" });
  assert.deepEqual(bg.port().posted, [{ type: "ping" }]);
  const pong = {
    type: "pong", hostVersion: "1.1.0", ytDlp: { found: true, path: "/usr/bin/yt-dlp", version: "2026.10.21" },
    ffmpeg: { found: true, path: "/usr/bin/ffmpeg" }, defaultSaveDir: "/home/u/Downloads", picker: "zenity",
  };
  bg.port().reply(pong);
  const result = await reply;
  assert.equal(result.ok, true);
  assert.equal(result.pong.hostVersion, "1.1.0");
  assert.equal((await bg.send({ type: "getState" })).host.reachable, true);
});

test("ping on a missing host reports the install hint", async () => {
  const bg = boot();
  const reply = bg.send({ type: "ping" });
  bg.port().die("No such native application dev.firstpick.ytdlp_downloader");
  const result = await reply;
  assert.equal(result.ok, false);
  assert.match(result.error, /not installed.*setup page/);
  const { host } = await bg.send({ type: "getState" });
  assert.equal(host.reachable, false);
});

test("pickDirectory round trip, cancel, and no_picker", async () => {
  const bg = boot();
  const picked = bg.send({ type: "pickDirectory", start: "~/Videos" });
  const request = bg.port().posted.at(-1);
  assert.equal(request.type, "pickDirectory");
  assert.equal(request.start, "~/Videos");
  assert.match(request.requestId, /^[0-9a-f-]{36}$/);
  bg.port().reply({ type: "directory", requestId: request.requestId, path: "/home/u/Videos/YT" });
  assert.deepEqual(await picked, { ok: true, path: "/home/u/Videos/YT" });

  const cancelled = bg.send({ type: "pickDirectory", start: "relative/ignored" });
  const second = bg.port().posted.at(-1);
  assert.equal(second.start, "~", "an invalid start falls back to the host default");
  bg.port().reply({ type: "directory", requestId: second.requestId, path: null });
  assert.deepEqual(await cancelled, { ok: true, path: null });

  const failing = bg.send({ type: "pickDirectory", start: "" });
  const failingRequest = bg.port().posted.at(-1);
  bg.port().reply({ type: "error", id: null, requestId: failingRequest.requestId, code: "no_picker", message: "Install zenity or kdialog." });
  assert.deepEqual(await failing, { ok: false, error: "Install zenity or kdialog." });

  const routed = bg.send({ type: "pickDirectory", start: "" });
  const other = bg.send({ type: "pickDirectory", start: "" });
  const [routedRequest, otherRequest] = bg.port().posted.slice(-2);
  bg.port().reply({ type: "error", id: null, requestId: routedRequest.requestId, code: "invalid_path", message: "bad start" });
  assert.deepEqual(await routed, { ok: false, error: "bad start" });
  bg.port().reply({ type: "directory", requestId: otherRequest.requestId, path: "/x" });
  assert.deepEqual(await other, { ok: true, path: "/x" }, "a requestId-tagged error only answers its own request");
});

test("id-less host errors with no open dialog become a notification", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  bg.port().reply({ type: "error", id: null, code: "invalid_path", message: "Path does not exist." });
  await flush();
  assert.equal(bg.state.notifications.at(-1).message, "Path does not exist.");
});

test("cancel sends the protocol message and the row becomes cancelled", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  const { id } = bg.lastDownload();
  assert.deepEqual(await bg.send({ type: "cancel", id }), { ok: true });
  assert.deepEqual(bg.port().posted.at(-1), { type: "cancel", id });
  bg.port().reply({ type: "cancelled", id });
  bg.port().reply({ type: "progress", id, status: "downloading", percent: 99 });
  const [entry] = (await bg.send({ type: "getState" })).downloads;
  assert.equal(entry.status, "cancelled", "late progress does not revive a cancelled row");
  assert.equal((await bg.send({ type: "cancel", id })).ok, false);
});

test("clearInactive keeps running downloads", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  bg.click("link:audio", { linkUrl: VIDEO });
  await flush();
  const [first] = bg.port().posted;
  bg.port().reply({ type: "finished", id: first.id, files: ["/tmp/a.mp4"] });
  await bg.send({ type: "clearInactive" });
  const downloads = (await bg.send({ type: "getState" })).downloads;
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].status, "pending");
});

test("messages from other senders and unknown types are ignored", () => {
  const bg = boot();
  assert.equal(bg.send({ type: "getState" }, { id: "evil@example.com" }), undefined);
  assert.equal(bg.send({ type: "download", url: VIDEO }), undefined);
  assert.equal(bg.send("getState"), undefined);
});

test("playlist setting only applies to URLs with a list id", async () => {
  const bg = boot({ settings: { videoPlaylist: true } });
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  assert.equal(bg.lastDownload().options.playlist, false, "a plain watch URL never gets --yes-playlist");

  const withList = `${VIDEO}&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf`;
  bg.click("link:video", { linkUrl: withList });
  await flush();
  assert.equal(bg.lastDownload().options.playlist, true);
});

const YOUTUBE_TAB = { id: EXTENSION_ID, url: VIDEO, tab: { id: 7 } };

test("the player menu on a YouTube page starts a download with that action's defaults", async () => {
  const bg = boot({ settings: { audioFormat: "opus", audioSaveDir: "~/Music" } });
  assert.deepEqual(await bg.send({ type: "downloadFromPage", action: "audio", url: `${VIDEO}&t=42s` }, YOUTUBE_TAB), { ok: true });
  await flush();
  const message = bg.lastDownload();
  assert.equal(message.url, VIDEO, "the page URL is re-validated and canonicalized");
  assert.equal(message.options.mode, "audio");
  assert.equal(message.options.saveDir, "~/Music");
});

test("an embedded player's URL is downloaded as the watch URL", async () => {
  const bg = boot();
  const embed = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1";
  await bg.send({ type: "downloadFromPage", action: "video", url: embed }, { ...YOUTUBE_TAB, url: embed });
  await flush();
  assert.equal(bg.lastDownload().url, VIDEO);
});

test("web pages can only send downloadFromPage", async () => {
  const bg = boot();
  for (const type of ["getState", "ping", "pickDirectory", "cancel", "openFolder", "clearInactive", "openSetup"]) {
    assert.equal(await bg.send({ type, id: "x", start: "~" }, YOUTUBE_TAB), undefined, type);
  }
  assert.equal(await bg.send({ type: "downloadFromPage", action: "settings", url: VIDEO }, YOUTUBE_TAB), undefined);
  await flush();
  assert.equal(bg.state.ports.length, 0, "nothing reached the native host");
  assert.equal(bg.state.tabs.length, 0, "no setup tab was opened");
});

test("downloadFromPage with a non-YouTube URL only shows a notice", async () => {
  const bg = boot();
  await bg.send({ type: "downloadFromPage", action: "video", url: "https://evil.example/watch?v=dQw4w9WgXcQ" }, YOUTUBE_TAB);
  await flush();
  assert.equal(bg.state.ports.length, 0);
  assert.equal(bg.state.notifications.at(-1).title, "Not a YouTube video");
});

const SETUP_URL = "moz-extension://test/setup/setup.html";

test("a fresh install opens the setup page; updates do not", async () => {
  const fresh = boot();
  fresh.browser.runtime.onInstalled.emit({ reason: "install", temporary: false });
  await flush();
  assert.deepEqual(fresh.state.tabs, [{ url: SETUP_URL }]);

  for (const reason of ["update", "browser_update", "shared_module_update"]) {
    const bg = boot();
    bg.browser.runtime.onInstalled.emit({ reason, previousVersion: "1.2.1" });
    await flush();
    assert.equal(bg.state.tabs.length, 0, reason);
  }
});

test("a temporary load does not open the setup page", async () => {
  const bg = boot();
  bg.browser.runtime.onInstalled.emit({ reason: "install", temporary: true });
  await flush();
  assert.equal(bg.state.tabs.length, 0);
});

test("extension pages can open the setup page", async () => {
  const bg = boot();
  assert.deepEqual(await bg.send({ type: "openSetup" }), { ok: true });
  assert.deepEqual(bg.state.tabs, [{ url: SETUP_URL }]);
  assert.equal(bg.state.ports.length, 0, "opening setup does not start the helper");
});

test("openSetup reports a tab that could not be opened", async () => {
  const bg = boot();
  bg.browser.tabs.create = async () => {
    throw new Error("No window");
  };
  assert.deepEqual(await bg.send({ type: "openSetup" }), { ok: false, error: "No window" });
});

test("clicking the host-unavailable notification opens the setup page", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  bg.port().die("No such native application dev.firstpick.ytdlp_downloader");
  await flush();
  const notice = bg.state.notifications.at(-1);
  assert.equal(notice.title, "yt-dlp: native host unavailable");
  bg.browser.notifications.onClicked.emit(notice.id);
  await flush();
  assert.deepEqual(bg.state.tabs, [{ url: SETUP_URL }]);
  assert.deepEqual(bg.state.cleared, [notice.id]);
  assert.equal(bg.state.ports.length, 1, "the click does not try the missing host again");
});

test("a download that cannot be posted at all also leads to setup", async () => {
  const bg = boot();
  bg.browser.runtime.connectNative = () => {
    throw new Error("No such native application dev.firstpick.ytdlp_downloader");
  };
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  const notice = bg.state.notifications.at(-1);
  assert.match(notice.message, /not installed.*Click to open the setup page/s);
  bg.browser.notifications.onClicked.emit(notice.id);
  await flush();
  assert.deepEqual(bg.state.tabs, [{ url: SETUP_URL }]);
});

test("a download failing because ffmpeg is missing leads to setup", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  const { id } = bg.lastDownload();
  bg.port().reply({ type: "error", id, code: "ffmpeg_missing", message: "ffmpeg is required." });
  await flush();
  const notice = bg.state.notifications.at(-1);
  assert.equal(notice.title, "Download failed");
  bg.browser.notifications.onClicked.emit(notice.id);
  await flush();
  assert.deepEqual(bg.state.tabs, [{ url: SETUP_URL }]);
  assert.equal(bg.port().posted.filter((m) => m.type === "openPath").length, 0);
});

test("other download failures do not open setup when clicked", async () => {
  const bg = boot();
  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  const { id } = bg.lastDownload();
  bg.port().reply({ type: "error", id, code: "ytdlp_failed", message: "ERROR: Video unavailable" });
  await flush();
  bg.browser.notifications.onClicked.emit(bg.state.notifications.at(-1).id);
  await flush();
  assert.equal(bg.state.tabs.length, 0);
});

test("ping with reconnect restarts an idle helper but never a busy one", async () => {
  const bg = boot();
  const first = bg.send({ type: "ping" });
  bg.port().reply({ type: "pong", hostVersion: "0.9.0" });
  await first;
  const idle = bg.port();

  const second = bg.send({ type: "ping", reconnect: true });
  assert.equal(idle.dead, true, "the idle port was closed");
  assert.equal(bg.state.ports.length, 2);
  bg.port().reply({ type: "pong", hostVersion: "1.1.0" });
  assert.equal((await second).pong.hostVersion, "1.1.0");

  bg.click("link:video", { linkUrl: VIDEO });
  await flush();
  const busy = bg.port();
  const third = bg.send({ type: "ping", reconnect: true });
  assert.equal(busy.dead, false, "a running download keeps its port");
  assert.equal(bg.state.ports.length, 2);
  busy.reply({ type: "pong", hostVersion: "1.1.0" });
  assert.equal((await third).ok, true);
});
