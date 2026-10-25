/*
 * Canonical settings for the yt-dlp downloader extension.
 *
 * This is the only place that defines setting keys, defaults, and allowed
 * values. The options page builds its controls from CHOICES, the background
 * page builds native host options from it, and the tests import it directly.
 *
 * Loaded as a classic script in extension pages (exposes globalThis.YtdlpSettings)
 * and as a CommonJS module under `node --test`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.YtdlpSettings = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "settings";
  const MAX_PATH_LENGTH = 4096;

  // Values mirror the native messaging protocol in TECHNICAL.md.
  // The host rejects anything else, so labels may change but values must not.
  const CHOICES = deepFreeze({
    mode: [
      { value: "video", label: "Video" },
      { value: "audio", label: "Audio" },
    ],
    videoResolution: [
      { value: "best", label: "Best available" },
      { value: "2160", label: "2160p (4K)" },
      { value: "1440", label: "1440p" },
      { value: "1080", label: "1080p" },
      { value: "720", label: "720p" },
      { value: "480", label: "480p" },
      { value: "360", label: "360p" },
    ],
    videoFormat: [
      { value: "any", label: "Any (no preference)" },
      { value: "mp4", label: "MP4" },
      { value: "webm", label: "WebM" },
      { value: "mkv", label: "MKV" },
    ],
    audioQuality: [
      { value: "best", label: "Best (VBR)" },
      { value: "320", label: "320 kbps" },
      { value: "256", label: "256 kbps" },
      { value: "192", label: "192 kbps" },
      { value: "128", label: "128 kbps" },
      { value: "96", label: "96 kbps" },
    ],
    audioFormat: [
      { value: "best", label: "Original (no conversion)" },
      { value: "mp3", label: "MP3" },
      { value: "m4a", label: "M4A (AAC)" },
      { value: "opus", label: "Opus" },
      { value: "flac", label: "FLAC" },
      { value: "wav", label: "WAV" },
    ],
  });

  const DEFAULTS = Object.freeze({
    mode: "video",
    videoResolution: "best",
    videoFormat: "mp4",
    audioQuality: "best",
    audioFormat: "mp3",
    saveDir: "",
    playlist: false,
    notifications: true,
  });

  const BOOLEAN_KEYS = Object.freeze(["playlist", "notifications"]);

  // Keys forwarded to the host in a `download` message; `notifications` is extension-only.
  const DOWNLOAD_OPTION_KEYS = Object.freeze([
    "mode",
    "videoResolution",
    "videoFormat",
    "audioQuality",
    "audioFormat",
    "saveDir",
    "playlist",
  ]);

  const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

  /**
   * Recursively freezes an object graph so shared constants cannot be mutated.
   * @template T
   * @param {T} value
   * @returns {T} the same value, frozen
   */
  function deepFreeze(value) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  }

  /**
   * Validates a save directory as typed by the user.
   *
   * Accepts "" (host default), "~", "~/..." or an absolute POSIX path. The host
   * performs the authoritative check after expanding "~"; this keeps obviously
   * bad values out of storage and gives the options page an error message.
   * @param {unknown} value
   * @returns {{ok: true, value: string} | {ok: false, error: string}}
   */
  function validateSaveDir(value) {
    if (typeof value !== "string") return { ok: false, error: "Save path must be text." };
    const trimmed = value.trim();
    if (trimmed === "") return { ok: true, value: "" };
    if (trimmed.length > MAX_PATH_LENGTH) return { ok: false, error: "Save path is too long." };
    if (CONTROL_CHARS.test(trimmed)) {
      return { ok: false, error: "Save path contains control characters." };
    }
    if (!(trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/"))) {
      return { ok: false, error: "Use an absolute path such as /home/you/Videos or ~/Videos." };
    }
    return { ok: true, value: trimmed };
  }

  /**
   * Validates one setting value against its enum or type.
   * @param {string} key a key of DEFAULTS
   * @param {unknown} value
   * @returns {{ok: true, value: string | boolean} | {ok: false, error: string}}
   */
  function validateSetting(key, value) {
    if (!Object.hasOwn(DEFAULTS, key)) return { ok: false, error: `Unknown setting "${key}".` };
    if (key === "saveDir") return validateSaveDir(value);
    if (BOOLEAN_KEYS.includes(key)) {
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, error: `Setting "${key}" must be true or false.` };
    }
    const allowed = CHOICES[key].some((choice) => choice.value === value);
    return allowed
      ? { ok: true, value }
      : { ok: false, error: `Invalid value for "${key}".` };
  }

  /**
   * Builds a complete settings object from untrusted stored data.
   * Unknown keys are dropped; missing or invalid values fall back to DEFAULTS.
   * @param {unknown} raw whatever was found in storage
   * @returns {typeof DEFAULTS} a new, complete settings object
   */
  function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const result = {};
    for (const key of Object.keys(DEFAULTS)) {
      const checked = Object.hasOwn(source, key) ? validateSetting(key, source[key]) : null;
      result[key] = checked && checked.ok ? checked.value : DEFAULTS[key];
    }
    return result;
  }

  /**
   * Resolves the storage area, defaulting to browser.storage.local.
   * @param {{get: Function, set: Function} | undefined} area
   * @returns {{get: Function, set: Function}}
   * @throws {Error} when no storage area is available
   */
  function resolveArea(area) {
    const resolved = area ?? globalThis.browser?.storage?.local;
    if (!resolved) throw new Error("browser.storage.local is not available.");
    return resolved;
  }

  /**
   * Loads settings with defaults merged in.
   * @param {{get: Function}} [area] storage area (defaults to browser.storage.local)
   * @returns {Promise<typeof DEFAULTS>}
   */
  async function loadSettings(area) {
    const stored = await resolveArea(area).get(STORAGE_KEY);
    return normalizeSettings(stored ? stored[STORAGE_KEY] : undefined);
  }

  /**
   * Validates a partial update, merges it over the stored settings, and saves.
   * @param {Partial<typeof DEFAULTS>} patch keys to change
   * @param {{get: Function, set: Function}} [area] storage area
   * @returns {Promise<typeof DEFAULTS>} the settings as saved
   * @throws {TypeError} when any key in patch is unknown or invalid; nothing is saved
   */
  function saveSettings(patch, area) {
    // Each save is a read-modify-write of one object; chaining keeps overlapping
    // saves from this page from overwriting each other's keys.
    const run = saveQueue.then(() => writeSettings(patch, area));
    saveQueue = run.catch(() => {});
    return run;
  }

  let saveQueue = Promise.resolve();

  async function writeSettings(patch, area) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("Settings patch must be an object.");
    }
    const storage = resolveArea(area);
    const next = await loadSettings(storage);
    for (const [key, value] of Object.entries(patch)) {
      const checked = validateSetting(key, value);
      if (!checked.ok) throw new TypeError(checked.error);
      next[key] = checked.value;
    }
    await storage.set({ [STORAGE_KEY]: next });
    return next;
  }

  /**
   * Builds the `options` object of a native `download` message.
   * @param {unknown} settings stored settings (normalized here)
   * @param {Partial<typeof DEFAULTS>} [overrides] per-action changes, e.g. {mode: "audio"}
   * @returns {{mode: string, videoResolution: string, videoFormat: string,
   *   audioQuality: string, audioFormat: string, saveDir: string, playlist: boolean}}
   * @throws {TypeError} when an override is invalid
   */
  function toDownloadOptions(settings, overrides = {}) {
    const merged = normalizeSettings(settings);
    for (const [key, value] of Object.entries(overrides)) {
      const checked = validateSetting(key, value);
      if (!checked.ok) throw new TypeError(checked.error);
      merged[key] = checked.value;
    }
    const options = {};
    for (const key of DOWNLOAD_OPTION_KEYS) options[key] = merged[key];
    return options;
  }

  return Object.freeze({
    STORAGE_KEY,
    MAX_PATH_LENGTH,
    CHOICES,
    DEFAULTS,
    DOWNLOAD_OPTION_KEYS,
    validateSaveDir,
    validateSetting,
    normalizeSettings,
    loadSettings,
    saveSettings,
    toDownloadOptions,
  });
});
