"use strict";

/*
 * Persistent background page: owns the context menus, the single native
 * messaging port, and the in-memory download list. Extension pages read state
 * with {type: "getState"} and receive {type: "state"} broadcasts.
 */

const { loadSettings, toDownloadOptions, validateSaveDir } = globalThis.YtdlpSettings;
const { LINK_TARGET_PATTERNS, DOCUMENT_PATTERNS, resolveContextUrl } = globalThis.YtdlpYouTube;
const { isActive, createEntry, failEntry, applyHostEvent, folderOf, pruneHistory } =
  globalThis.YtdlpDownloads;

const HOST_NAME = "dev.firstpick.ytdlp_downloader";
const INSTALL_HINT = "Run native-host/install.sh, then restart the browser.";
// Above the host's own 5 s bound on `yt-dlp --version`, so a slow cold start still answers.
const PING_TIMEOUT_MS = 10_000;
// A folder dialog waits on the user; the bound only guards against a hung picker process.
const PICK_DIRECTORY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INACTIVE_ENTRIES = 50;
const BROADCAST_INTERVAL_MS = 250;
const ICON_URL = browser.runtime.getURL("icons/icon.svg");

/** @type {browser.runtime.Port | null} */
let port = null;
/** @type {Map<string, import("./shared/downloads.js").DownloadEntry>} */
const downloads = new Map();
/** @type {{promise: Promise<object>, settle: (error: Error | null, pong?: object) => void} | null} */
let pendingPing = null;
/** @type {Map<string, (error: Error | null, path?: string | null) => void>} */
const pendingDirectories = new Map();
/** notification id → folder to open when the notification is clicked */
const notificationFolders = new Map();
/** Last known host status, shown on the options page. */
let hostStatus = { reachable: null, error: null, pong: null };
let broadcastTimer = null;
let lastBadgeCount = -1;

// ---------------------------------------------------------------------------
// Native host port
// ---------------------------------------------------------------------------

/**
 * Turns a port/lastError value into an actionable message.
 * @param {unknown} error
 * @returns {string}
 */
function describeHostError(error) {
  const raw = typeof error?.message === "string" ? error.message : error ? String(error) : "";
  if (raw === "") return "The native host exited unexpectedly. Check the browser console for details.";
  if (/no such native application|not found|no such file/i.test(raw)) {
    return `The native host "${HOST_NAME}" is not installed. ${INSTALL_HINT}`;
  }
  if (/permission/i.test(raw)) {
    return `The native host manifest does not allow this extension. Re-run native-host/install.sh. (${raw})`;
  }
  return `Native host error: ${raw}`;
}

/**
 * Returns the connected port, connecting lazily.
 * @returns {browser.runtime.Port}
 */
function getPort() {
  if (port) return port;
  const created = browser.runtime.connectNative(HOST_NAME);
  created.onMessage.addListener(onHostMessage);
  created.onDisconnect.addListener(onHostDisconnect);
  port = created;
  return created;
}

/**
 * Sends a message to the host, reconnecting if the previous port died.
 * @param {object} message protocol message
 * @returns {string | null} an error message, or null on success
 */
function postToHost(message) {
  try {
    getPort().postMessage(message);
    return null;
  } catch (error) {
    // postMessage throws once the port is dead, possibly before onDisconnect has fired.
    // Clean up the old port's waiters, then retry once on a fresh port.
    if (port) handlePortLoss(port, error);
    try {
      getPort().postMessage(message);
      return null;
    } catch (retryError) {
      if (port) handlePortLoss(port, retryError);
      return describeHostError(retryError);
    }
  }
}

/**
 * @param {browser.runtime.Port} disconnected
 */
function onHostDisconnect(disconnected) {
  if (disconnected === port) handlePortLoss(disconnected, disconnected.error ?? browser.runtime.lastError);
}

/**
 * Forgets the current port and fails everything that was waiting on it.
 * Callers that are about to send a new download must register its entry only
 * after posting, so this cleanup cannot fail a request sent on the next port.
 * @param {browser.runtime.Port} lost
 * @param {unknown} error
 */
function handlePortLoss(lost, error) {
  if (lost !== port) return;
  port = null;
  try {
    lost.disconnect();
  } catch {
    // Already disconnected.
  }
  const message = describeHostError(error);
  hostStatus = { reachable: false, error: message, pong: hostStatus.pong };

  pendingPing?.settle(new Error(message));
  for (const settle of [...pendingDirectories.values()]) settle(new Error(message));

  let failed = 0;
  for (const entry of downloads.values()) {
    if (!isActive(entry)) continue;
    downloads.set(entry.id, failEntry(entry, message, "host_disconnected"));
    failed += 1;
  }
  if (failed > 0) notifyAlways("yt-dlp: native host unavailable", message);
  stateChanged();
}

/**
 * Dispatches one host → extension message.
 * @param {unknown} msg
 */
function onHostMessage(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    console.warn("yt-dlp: ignoring malformed host message", msg);
    return;
  }
  switch (msg.type) {
    case "pong":
      hostStatus = { reachable: true, error: null, pong: msg };
      pendingPing?.settle(null, msg);
      stateChanged();
      break;
    case "directory":
      pendingDirectories.get(msg.requestId)?.(null, typeof msg.path === "string" ? msg.path : null);
      break;
    case "queued":
    case "started":
    case "progress":
    case "finished":
    case "cancelled":
      applyDownloadEvent(msg);
      break;
    case "error":
      onHostError(msg);
      break;
    default:
      console.warn("yt-dlp: unknown host message type", msg.type);
  }
}

/**
 * Routes a host error to the download, directory request, or general status it belongs to.
 * @param {{id?: string | null, requestId?: string, code?: string, message?: string}} msg
 */
function onHostError(msg) {
  if (typeof msg.id === "string" && downloads.has(msg.id)) {
    applyDownloadEvent(msg);
    return;
  }
  const message = typeof msg.message === "string" ? msg.message : `Host error (${msg.code ?? "unknown"})`;
  const directorySettle = typeof msg.requestId === "string" && pendingDirectories.get(msg.requestId);
  if (directorySettle) {
    directorySettle(new Error(message));
    return;
  }
  console.warn("yt-dlp: host error", msg.code, message);
  void notify("yt-dlp error", message);
}

// ---------------------------------------------------------------------------
// Requests with replies (ping, pickDirectory)
// ---------------------------------------------------------------------------

/**
 * Pings the host. Concurrent callers share one in-flight request because pong carries no id.
 * @returns {Promise<object>} the pong message
 */
function pingHost() {
  if (pendingPing) return pendingPing.promise;
  let resolvePing;
  let rejectPing;
  const promise = new Promise((resolve, reject) => {
    resolvePing = resolve;
    rejectPing = reject;
  });
  const timer = setTimeout(
    () => current.settle(new Error(`The native host did not answer within ${PING_TIMEOUT_MS / 1000} s.`)),
    PING_TIMEOUT_MS,
  );
  const current = {
    promise,
    settle(error, pong) {
      clearTimeout(timer);
      if (pendingPing === current) pendingPing = null;
      if (error) {
        hostStatus = { reachable: false, error: error.message, pong: hostStatus.pong };
        stateChanged();
        rejectPing(error);
      } else {
        resolvePing(pong);
      }
    },
  };
  // Registered after posting for the same reason as in startDownload.
  const sendError = postToHost({ type: "ping" });
  if (sendError) current.settle(new Error(sendError));
  else pendingPing = current;
  return promise;
}

/**
 * Opens the host's native folder dialog.
 * @param {unknown} start preferred starting folder
 * @returns {Promise<string | null>} chosen absolute path, or null if the user cancelled
 */
function pickDirectory(start) {
  const checked = validateSaveDir(start);
  const startDir = (checked.ok && checked.value) || hostStatus.pong?.defaultSaveDir || "~";
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => settle(new Error("The folder dialog did not respond.")),
      PICK_DIRECTORY_TIMEOUT_MS,
    );
    function settle(error, path) {
      clearTimeout(timer);
      pendingDirectories.delete(requestId);
      if (error) reject(error);
      else resolve(path ?? null);
    }
    const sendError = postToHost({ type: "pickDirectory", requestId, start: startDir });
    if (sendError) settle(new Error(sendError));
    else pendingDirectories.set(requestId, settle);
  });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/**
 * Applies a host download event and fires the matching notification.
 * @param {{id?: unknown, type: string}} msg
 */
function applyDownloadEvent(msg) {
  const entry = typeof msg.id === "string" ? downloads.get(msg.id) : undefined;
  const next = entry ? applyHostEvent(entry, msg) : null;
  if (!next) return;
  downloads.set(next.id, next);
  const name = next.title ?? next.url;
  if (msg.type === "started") {
    void notify("Download started", name);
  } else if (msg.type === "finished") {
    void notify("Download finished", `${name}\nClick to open the folder.`, folderOf(next));
  } else if (msg.type === "error") {
    void notify("Download failed", `${name}\n${next.error}`);
  }
  stateChanged();
}

/**
 * Sends a download request for a resolved URL.
 * @param {string} url canonical YouTube URL
 * @param {ReturnType<typeof toDownloadOptions>} options
 */
function startDownload(url, options) {
  const id = crypto.randomUUID();
  const entry = createEntry({ id, url, mode: options.mode, now: Date.now() });
  // Post before registering: host replies arrive asynchronously, and handlePortLoss
  // during a retry must not fail this entry. See handlePortLoss.
  const sendError = postToHost({ type: "download", id, url, options });
  downloads.set(id, sendError ? failEntry(entry, sendError, "host_unavailable") : entry);
  if (sendError) notifyAlways("yt-dlp: native host unavailable", sendError);
  pruneDownloads();
  stateChanged();
}

/**
 * Handles a "Download Video" / "Download Audio" menu click.
 * @param {browser.menus.OnClickData} info
 * @param {"video" | "audio"} action
 */
async function downloadFromContext(info, action) {
  const target = resolveContextUrl(info);
  if (!target) {
    notifyAlways("Not a YouTube video", "Right-click a YouTube video, Short, live stream, or playlist.");
    return;
  }
  let settings;
  try {
    settings = await loadSettings();
  } catch (error) {
    notifyAlways("yt-dlp: settings unavailable", String(error?.message ?? error));
    return;
  }
  // A bare playlist URL would download every item even with --no-playlist.
  if (target.kind === "playlist" && !settings.playlist) {
    notifyAlways(
      "Playlist downloads are off",
      'Turn on "Download playlists" in yt-dlp settings to download this playlist.',
    );
    return;
  }
  // --yes-playlist on a URL without a list id makes yt-dlp render the playlist
  // output template with "NA" fields, so only list URLs get playlist handling.
  const overrides = { playlist: settings.playlist && target.listId !== null };
  if (action === "audio") overrides.mode = "audio";
  startDownload(target.url, toDownloadOptions(settings, overrides));
}

/**
 * Requests cancellation; the row updates when the host replies `cancelled`.
 * @param {unknown} id
 * @returns {{ok: boolean, error?: string}}
 */
function cancelDownload(id) {
  const entry = typeof id === "string" ? downloads.get(id) : undefined;
  if (!entry || !isActive(entry)) return { ok: false, error: "That download is not running." };
  const sendError = postToHost({ type: "cancel", id: entry.id });
  return sendError ? { ok: false, error: sendError } : { ok: true };
}

/**
 * Asks the host to open the folder of a finished download.
 * @param {unknown} id
 * @returns {{ok: boolean, error?: string}}
 */
function openDownloadFolder(id) {
  const entry = typeof id === "string" ? downloads.get(id) : undefined;
  const folder = entry && entry.status === "finished" ? folderOf(entry) : null;
  if (!folder) return { ok: false, error: "No folder is known for that download." };
  const sendError = postToHost({ type: "openPath", path: folder });
  return sendError ? { ok: false, error: sendError } : { ok: true };
}

/** Removes finished, cancelled, and failed entries. */
function clearInactive() {
  for (const entry of [...downloads.values()]) {
    if (!isActive(entry)) downloads.delete(entry.id);
  }
  stateChanged();
}

function pruneDownloads() {
  const keep = new Set(pruneHistory([...downloads.values()], MAX_INACTIVE_ENTRIES).map((e) => e.id));
  for (const id of [...downloads.keys()]) {
    if (!keep.has(id)) downloads.delete(id);
  }
}

/**
 * @returns {object[]} download entries, newest first
 */
function snapshot() {
  return [...downloads.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------------------
// Badge, broadcasts, notifications
// ---------------------------------------------------------------------------

/** Updates the badge immediately and coalesces page broadcasts (progress can arrive many times a second). */
function stateChanged() {
  updateBadge();
  if (broadcastTimer !== null) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    browser.runtime
      .sendMessage({ type: "state", downloads: snapshot(), host: hostStatus })
      // Rejects with "Receiving end does not exist" when no popup or options page is open.
      .catch(() => {});
  }, BROADCAST_INTERVAL_MS);
}

function updateBadge() {
  let count = 0;
  for (const entry of downloads.values()) if (isActive(entry)) count += 1;
  if (count === lastBadgeCount) return;
  lastBadgeCount = count;
  void browser.browserAction.setBadgeText({ text: count > 0 ? String(count) : "" });
}

/**
 * Shows a notification regardless of the notifications setting. Used when a
 * click could not start a download at all, so it never fails silently.
 * @param {string} title
 * @param {string} message
 * @param {string | null} [folder] folder to open when clicked
 */
function notifyAlways(title, message, folder = null) {
  const id = `ytdlp-${crypto.randomUUID()}`;
  if (folder) notificationFolders.set(id, folder);
  browser.notifications
    .create(id, { type: "basic", iconUrl: ICON_URL, title, message })
    .catch((error) => {
      notificationFolders.delete(id);
      console.warn("yt-dlp: notification failed", error);
    });
}

/**
 * Shows a notification if the user enabled notifications.
 * @param {string} title
 * @param {string} message
 * @param {string | null} [folder]
 * @returns {Promise<void>}
 */
async function notify(title, message, folder = null) {
  try {
    if (!(await loadSettings()).notifications) return;
  } catch {
    return;
  }
  notifyAlways(title, message, folder);
}

browser.notifications.onClicked.addListener((notificationId) => {
  const folder = notificationFolders.get(notificationId);
  if (folder) {
    const sendError = postToHost({ type: "openPath", path: folder });
    if (sendError) notifyAlways("Could not open folder", sendError);
  }
  void browser.notifications.clear(notificationId);
});

browser.notifications.onClosed.addListener((notificationId) => {
  notificationFolders.delete(notificationId);
});

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

const MENU_ACTIONS = [
  { action: "video", title: "Download Video" },
  { action: "audio", title: "Download Audio" },
  { action: "settings", title: "yt-dlp Settings…" },
];

/**
 * Creates two parallel sets of items: link items filtered by the link target,
 * and page/video items filtered by the document URL. One item cannot do both,
 * because documentUrlPatterns would also hide link items on non-YouTube pages.
 */
async function createMenus() {
  await browser.menus.removeAll();
  for (const { action, title } of MENU_ACTIONS) {
    browser.menus.create({
      id: `link:${action}`,
      title,
      contexts: ["link"],
      targetUrlPatterns: [...LINK_TARGET_PATTERNS],
    });
  }
  for (const { action, title } of MENU_ACTIONS) {
    browser.menus.create({
      id: `page:${action}`,
      title,
      contexts: ["page", "video"],
      documentUrlPatterns: [...DOCUMENT_PATTERNS],
    });
  }
}

browser.menus.onClicked.addListener((info) => {
  const action = String(info.menuItemId).split(":")[1];
  if (action === "settings") {
    void browser.runtime.openOptionsPage();
  } else if (action === "video" || action === "audio") {
    void downloadFromContext(info, action);
  }
});

// ---------------------------------------------------------------------------
// Messages from the popup and options page
// ---------------------------------------------------------------------------

/**
 * Wraps a promise into the {ok, ...} reply shape used by extension pages.
 * @param {Promise<object>} promise
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function reply(promise) {
  return promise.then(
    (value) => ({ ok: true, ...value }),
    (error) => ({ ok: false, error: String(error?.message ?? error) }),
  );
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id || !message || typeof message !== "object") return undefined;
  switch (message.type) {
    case "getState":
      return Promise.resolve({ ok: true, downloads: snapshot(), host: hostStatus });
    case "ping":
      return reply(pingHost().then((pong) => ({ pong })));
    case "pickDirectory":
      return reply(pickDirectory(message.start).then((path) => ({ path })));
    case "cancel":
      return Promise.resolve(cancelDownload(message.id));
    case "openFolder":
      return Promise.resolve(openDownloadFolder(message.id));
    case "clearInactive":
      clearInactive();
      return Promise.resolve({ ok: true });
    default:
      return undefined;
  }
});

void browser.browserAction.setBadgeBackgroundColor({ color: "#e5484d" });
void createMenus();
updateBadge();
