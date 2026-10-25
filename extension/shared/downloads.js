/*
 * Download entry state shared by the background page (state owner) and the
 * popup (renderer). Host messages are applied through applyHostEvent, a pure
 * reducer, so protocol handling is testable under `node --test`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.YtdlpDownloads = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const MAX_TITLE_LENGTH = 300;
  const MAX_SHORT_TEXT_LENGTH = 40;
  const MAX_MESSAGE_LENGTH = 2000;
  const MAX_FILES = 1000;

  const STATUS_LABELS = Object.freeze({
    pending: "Waiting for host",
    queued: "Queued",
    started: "Starting",
    downloading: "Downloading",
    processing: "Processing",
    finished: "Finished",
    cancelled: "Cancelled",
    error: "Failed",
  });

  const ACTIVE_STATUSES = Object.freeze(["pending", "queued", "started", "downloading", "processing"]);
  const PROGRESS_STATUSES = Object.freeze(["downloading", "processing"]);

  /**
   * @typedef {object} DownloadEntry
   * @property {string} id
   * @property {string} url
   * @property {"video" | "audio"} mode
   * @property {keyof typeof STATUS_LABELS} status
   * @property {string | null} title
   * @property {number | null} percent 0..100
   * @property {string | null} speed
   * @property {string | null} eta
   * @property {number | null} playlistIndex
   * @property {number | null} playlistCount
   * @property {string | null} saveDir
   * @property {string[]} files
   * @property {string | null} error
   * @property {string | null} errorCode
   * @property {number} createdAt epoch ms
   * @property {number} updatedAt epoch ms
   */

  /**
   * Returns a trimmed string capped at max characters, or null.
   * Host values are relayed from yt-dlp and the network, so lengths are bounded.
   * @param {unknown} value
   * @param {number} max
   * @returns {string | null}
   */
  function boundedString(value, max) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
  }

  /**
   * @param {unknown} value
   * @returns {number | null} value clamped to 0..100, or null if not a finite number
   */
  function percentOf(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.min(100, Math.max(0, value));
  }

  /**
   * @param {unknown} value
   * @returns {number | null} a positive integer, or null
   */
  function positiveIntOf(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {string[]} absolute path strings only
   */
  function filesOf(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((file) => typeof file === "string" && file.startsWith("/"))
      .slice(0, MAX_FILES);
  }

  /**
   * @param {{status: string}} entry
   * @returns {boolean} true while the host may still report progress
   */
  function isActive(entry) {
    return ACTIVE_STATUSES.includes(entry.status);
  }

  /**
   * Creates the entry for a download that is about to be sent to the host.
   * @param {{id: string, url: string, mode: "video" | "audio", now: number}} init
   * @returns {DownloadEntry}
   */
  function createEntry({ id, url, mode, now }) {
    return {
      id,
      url,
      mode,
      status: "pending",
      title: null,
      percent: null,
      speed: null,
      eta: null,
      playlistIndex: null,
      playlistCount: null,
      saveDir: null,
      files: [],
      error: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Marks an entry as failed.
   * @param {DownloadEntry} entry
   * @param {string} message human readable reason
   * @param {string | null} [code] protocol error code, if any
   * @param {number} [now]
   * @returns {DownloadEntry} a new entry
   */
  function failEntry(entry, message, code = null, now = Date.now()) {
    return {
      ...entry,
      status: "error",
      error: boundedString(message, MAX_MESSAGE_LENGTH) ?? "Download failed.",
      errorCode: code,
      speed: null,
      eta: null,
      updatedAt: now,
    };
  }

  /**
   * Applies one host → extension message to an entry.
   *
   * Terminal entries (finished, cancelled, error) are never revived: a late
   * progress line after a cancel must not resurrect the row.
   * @param {DownloadEntry} entry
   * @param {object} msg a host message whose `id` matches entry.id
   * @param {number} [now]
   * @returns {DownloadEntry | null} the updated entry, or null if msg does not apply
   */
  function applyHostEvent(entry, msg, now = Date.now()) {
    if (!entry || !msg || msg.id !== entry.id || !isActive(entry)) return null;
    switch (msg.type) {
      case "queued":
        return { ...entry, status: "queued", updatedAt: now };
      case "started":
        return {
          ...entry,
          status: "started",
          saveDir: boundedString(msg.saveDir, 4096) ?? entry.saveDir,
          updatedAt: now,
        };
      case "progress":
        return {
          ...entry,
          status: PROGRESS_STATUSES.includes(msg.status) ? msg.status : entry.status,
          percent: percentOf(msg.percent),
          speed: boundedString(msg.speed, MAX_SHORT_TEXT_LENGTH),
          eta: boundedString(msg.eta, MAX_SHORT_TEXT_LENGTH),
          title: boundedString(msg.title, MAX_TITLE_LENGTH) ?? entry.title,
          playlistIndex: positiveIntOf(msg.playlistIndex) ?? entry.playlistIndex,
          playlistCount: positiveIntOf(msg.playlistCount) ?? entry.playlistCount,
          updatedAt: now,
        };
      case "finished":
        return {
          ...entry,
          status: "finished",
          files: filesOf(msg.files),
          percent: 100,
          speed: null,
          eta: null,
          updatedAt: now,
        };
      case "cancelled":
        return { ...entry, status: "cancelled", speed: null, eta: null, updatedAt: now };
      case "error":
        return failEntry(entry, msg.message, boundedString(msg.code, MAX_SHORT_TEXT_LENGTH), now);
      default:
        return null;
    }
  }

  /**
   * Returns the parent directory of an absolute POSIX path.
   * @param {string} path
   * @returns {string}
   */
  function dirname(path) {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const index = trimmed.lastIndexOf("/");
    return index > 0 ? trimmed.slice(0, index) : "/";
  }

  /**
   * The folder to open for a finished entry: the first file's directory
   * (a playlist subfolder for playlists), else the save directory.
   * @param {DownloadEntry} entry
   * @returns {string | null}
   */
  function folderOf(entry) {
    if (entry.files.length > 0) return dirname(entry.files[0]);
    return entry.saveDir;
  }

  /**
   * Keeps every active entry plus the newest `maxInactive` inactive ones.
   * @param {DownloadEntry[]} entries
   * @param {number} maxInactive
   * @returns {DownloadEntry[]} entries to keep, newest first
   */
  function pruneHistory(entries, maxInactive) {
    const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
    let inactive = 0;
    return sorted.filter((entry) => isActive(entry) || inactive++ < maxInactive);
  }

  /**
   * One-line progress detail for display, e.g. "42% · 3.2MiB/s · ETA 00:12 · 3/10".
   * @param {DownloadEntry} entry
   * @returns {string}
   */
  function formatDetail(entry) {
    const parts = [];
    if (isActive(entry)) {
      if (entry.percent !== null) parts.push(`${entry.percent.toFixed(entry.percent < 10 ? 1 : 0)}%`);
      if (entry.speed) parts.push(entry.speed);
      if (entry.eta) parts.push(`ETA ${entry.eta}`);
    } else if (entry.status === "finished" && entry.files.length > 1) {
      parts.push(`${entry.files.length} files`);
    }
    if (entry.playlistIndex !== null && entry.playlistCount !== null) {
      parts.push(`${entry.playlistIndex}/${entry.playlistCount}`);
    }
    return parts.join(" · ");
  }

  return Object.freeze({
    STATUS_LABELS,
    ACTIVE_STATUSES,
    isActive,
    createEntry,
    failEntry,
    applyHostEvent,
    dirname,
    folderOf,
    pruneHistory,
    formatDetail,
  });
});
