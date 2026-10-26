/*
 * Canonical setup facts: the one-line install command, the minimum helper
 * (native host) version, and how a ping result maps to a setup state.
 *
 * The setup page, the options page, the popup, and the tests all read these
 * values from here so the command and version rule exist only once.
 *
 * Loaded as a classic script in extension pages (exposes globalThis.YtdlpSetup)
 * and as a CommonJS module under `node --test`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.YtdlpSetup = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const REPO = "Firstp1ck/ytdlp-downloader";
  const MANUAL_INSTALL_URL = `https://github.com/${REPO}#install`;
  // Oldest host whose protocol this extension speaks. Raise it together with
  // a host change the extension depends on.
  const MIN_HOST_VERSION = "1.2.0";
  const SETUP_STATES = Object.freeze(["checking", "missing", "outdated", "tools", "ready"]);

  /**
   * URL of the setup script published with the release of `version`. Pinned per
   * release so the command never runs unreviewed code from a moving branch.
   * @param {string} version extension version, e.g. "1.3.0"
   * @returns {string}
   */
  function setupScriptUrl(version) {
    if (parseVersion(version) === null) throw new TypeError(`Not a release version: ${version}`);
    return `https://github.com/${REPO}/releases/download/v${version}/setup.sh`;
  }

  /**
   * The command the user pastes into a terminal.
   * @param {string} version extension version
   * @param {"curl" | "wget" | "browser"} [downloader] browser means save the pinned script first
   * @returns {string}
   */
  function setupCommand(version, downloader = "curl") {
    const url = setupScriptUrl(version);
    if (downloader === "curl") return `curl -fsSL ${url} | bash`;
    if (downloader === "wget") return `wget -qO- ${url} | bash`;
    if (downloader === "browser") return "bash setup.sh";
    throw new TypeError("Unknown setup downloader");
  }

  /**
   * Parses "1.2.3" (optionally "v1.2", or with a "-suffix"/"+build") into numbers.
   * Missing minor/patch parts count as 0; suffixes are ignored.
   * @param {unknown} text
   * @returns {[number, number, number] | null} null if it does not start with a version
   */
  function parseVersion(text) {
    if (typeof text !== "string") return null;
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]*)?$/.exec(text.trim());
    if (!match) return null;
    const parts = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
    return parts.every(Number.isSafeInteger) ? parts : null;
  }

  /**
   * Compares two versions numerically.
   * @param {string} a
   * @param {string} b
   * @returns {number} negative if a < b, 0 if equal, positive if a > b
   * @throws {TypeError} if either is not a version
   */
  function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) throw new TypeError(`Cannot compare versions ${a} and ${b}`);
    for (let i = 0; i < 3; i += 1) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return 0;
  }

  /**
   * True if a helper reporting `hostVersion` is new enough. An unparsable or
   * missing version cannot establish compatibility and is not supported.
   * @param {unknown} hostVersion
   * @param {string} [minVersion]
   * @returns {boolean}
   */
  function isHostVersionSupported(hostVersion, minVersion = MIN_HOST_VERSION) {
    return parseVersion(hostVersion) !== null && compareVersions(hostVersion, minVersion) >= 0;
  }

  const CHECKS = Object.freeze({
    helper: ["Helper program", "Required for downloads"],
    python: ["Python 3.8+", "Required for downloads"],
    ytdlp: ["yt-dlp", "Required for downloads"],
    ffmpeg: ["ffmpeg", "Required for downloads"],
    ffprobe: ["ffprobe", "Required for downloads"],
    jsRuntime: ["JavaScript runtime", "Recommended for YouTube"],
    picker: ["Folder picker", "Optional convenience"],
    opener: ["Folder opener", "Optional convenience"],
    userDirs: ["Downloads-folder detection", "Optional convenience"],
    downloader: ["curl / wget downloader", "Setup only"],
    coreutils: ["Coreutils", "Setup only"],
    nativeMessagingProxy: ["Sandbox proxy", "Conditional: Flatpak / Snap"],
  });
  const REQUIRED_KEYS = new Set(["python", "ytdlp", "ffmpeg", "ffprobe"]);
  const COREUTILS = ["cat", "mkdir", "install", "rm", "rmdir", "mktemp", "uname"];

  /**
   * @typedef {"ok" | "bad" | "warn" | "pending"} CheckStatus
   * @typedef {{key: string, label: string, requirement: string, status: CheckStatus, detail: string}} CheckItem
   * @typedef {{
   *   state: "checking" | "missing" | "outdated" | "tools" | "ready",
   *   checklist: CheckItem[], missingTools: string[], brokenTools: string[],
   *   unsupportedTools: string[], warnings: string[], unknownChecks: string[],
   *   updateReason: null | "version" | "versionUnknown" | "diagnostics",
   *   needsAttention: boolean, setupMethod: "curl" | "wget" | "browser" | "unknown",
   *   hostVersion: string | null, error: string | null,
   * }} SetupView
   * Missing/broken/unsupported tools are confirmed required failures only.
   * Warnings and unknownChecks contain row keys. Conditional proxy applicability
   * alone is not an actionable unknown and does not keep polling alive.
   */

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasText(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function foundStatus(report) {
    return isRecord(report) && typeof report.found === "boolean" ? report.found : null;
  }

  function item(key, status, detail) {
    const [label, requirement] = CHECKS[key];
    return { key, label, requirement, status, detail };
  }

  function unknown(key) {
    return item(key, "pending", "Not reported or invalid; update/reinstall the helper and check again");
  }

  function presenceCheck(key, report, present, absent) {
    const found = foundStatus(report);
    if (found === null) return unknown(key);
    return item(key, found ? "ok" : REQUIRED_KEYS.has(key) ? "bad" : "warn", found ? present : absent);
  }

  function pythonCheck(report) {
    if (foundStatus(report) === false) return item("python", "bad", "Not found; Python 3.8 or newer is required");
    if (foundStatus(report) !== true || !parseVersion(report.version) || typeof report.supported !== "boolean") {
      return unknown("python");
    }
    const supportedVersion = compareVersions(report.version, "3.8.0") >= 0;
    if (supportedVersion !== report.supported) return unknown("python");
    return item("python", supportedVersion ? "ok" : "bad",
      `Version ${report.version}${supportedVersion ? "" : "; unsupported: install Python 3.8 or newer and reinstall the helper"}`);
  }

  function ytDlpCheck(report) {
    if (foundStatus(report) === false) return item("ytdlp", "bad", "Not found");
    if (foundStatus(report) !== true) return unknown("ytdlp");
    // Null/empty is an explicit failed --version probe. An absent or malformed
    // version is unknown, not evidence that an installed executable is broken.
    if (report.version === null || report.version === "") return item("ytdlp", "bad", "Installed but doesn't run");
    if (!hasText(report.version)) return unknown("ytdlp");
    return item("ytdlp", "ok", `Version ${report.version}`);
  }

  function runtimeCheck(runtime) {
    if (runtime === null) return item("jsRuntime", "warn", "Not found; Deno (or Node 22+) helps yt-dlp find YouTube formats");
    if (!isRecord(runtime) || !hasText(runtime.name)) return unknown("jsRuntime");
    const where = hasText(runtime.path) ? ` (${runtime.path})` : "";
    return item("jsRuntime", "ok", `${runtime.name}${where}`);
  }

  function downloaderCheck(report) {
    const found = foundStatus(report);
    if (found === false) return item("downloader", "warn", "Neither curl nor wget found; setup needs one to download files");
    if (found !== true || !["curl", "wget"].includes(report.name)) return unknown("downloader");
    return item("downloader", "ok", `Found: ${report.name}`);
  }

  function coreutilsCheck(report) {
    const found = foundStatus(report);
    if (found === null || !Array.isArray(report.missing) ||
        report.missing.some((name) => !COREUTILS.includes(name)) ||
        found !== (report.missing.length === 0)) return unknown("coreutils");
    return item("coreutils", found ? "ok" : "warn", found
      ? `Found: ${COREUTILS.join(", ")}`
      : `Missing: ${joinNames(report.missing)}; needed by setup`);
  }

  function proxyCheck(report) {
    if (isRecord(report) && report.applicable === true) {
      return presenceCheck("nativeMessagingProxy", report, "Found for the detected sandbox environment",
        "Not found in a detected Flatpak / Snap environment; needed for sandbox helper integration");
    }
    // No sandbox markers is not evidence that the browser is unsandboxed.
    // Do not turn every native-browser setup into a proxy installation warning.
    if (foundStatus(report) === true) {
      return item("nativeMessagingProxy", "ok", "Found; whether this browser needs it is not established");
    }
    return item("nativeMessagingProxy", "pending", "Applicability not established; only needed for some Flatpak / Snap browsers");
  }

  /** Maps a background ping reply to setup UI facts without inspecting the browser's computer. */
  function deriveSetupState(pingResult, minVersion = MIN_HOST_VERSION) {
    const checking = pingResult === null || pingResult === undefined;
    const pong = isRecord(pingResult) && pingResult.ok === true && isRecord(pingResult.pong) ? pingResult.pong : null;
    if (!pong) {
      const checklist = Object.keys(CHECKS).map((key) => key === "helper"
        ? item(key, checking ? "pending" : "bad", checking ? "Checking…" : "Not installed or not reachable")
        : item(key, "pending", "Requires a working helper; install/connect it before these checks can run"));
      const error = checking ? null : hasText(pingResult?.error) ? pingResult.error : "The helper did not answer.";
      return view(checking ? "checking" : "missing", checklist, { error });
    }

    const hostVersion = hasText(pong.hostVersion) ? pong.hostVersion : null;
    const supported = isHostVersionSupported(hostVersion, minVersion);
    let updateReason = supported ? null : parseVersion(hostVersion) ? "version" : "versionUnknown";
    const downloader = downloaderCheck(pong.downloader);
    const checklist = [
      item("helper", supported ? "ok" : "bad", supported ? `Version ${hostVersion}` : updateReason === "version"
        ? `Version ${hostVersion}, needs ${minVersion} or newer`
        : "Version not reported or invalid; update/reinstall the helper"),
      pythonCheck(pong.python),
      ytDlpCheck(pong.ytDlp),
      presenceCheck("ffmpeg", pong.ffmpeg, "Found for video merging and audio conversion", "Not found; required for video and audio downloads"),
      presenceCheck("ffprobe", pong.ffprobe, "Found for media inspection", "Not found; required for video and audio downloads (ffmpeg package)"),
      runtimeCheck(pong.jsRuntime),
      pong.picker === null ? item("picker", "warn", "Not found; install zenity, kdialog or yad, or enter folder paths manually")
        : hasText(pong.picker) ? item("picker", "ok", pong.picker) : unknown("picker"),
      presenceCheck("opener", pong.opener, "Found: xdg-open", "Not found: xdg-open; opening saved folders is unavailable"),
      presenceCheck("userDirs", pong.userDirs, "Found: xdg-user-dir", "Not found: xdg-user-dir; the helper falls back to ~/Downloads"),
      downloader,
      coreutilsCheck(pong.coreutils),
      proxyCheck(pong.nativeMessagingProxy),
    ];
    const unknownChecks = checklist.filter((check) => check.status === "pending" &&
      (check.key !== "nativeMessagingProxy" || pong.nativeMessagingProxy?.applicable === true)).map((check) => check.key);
    if (supported && unknownChecks.some((key) => REQUIRED_KEYS.has(key))) updateReason = "diagnostics";
    const requiredFailures = checklist.filter((check) => REQUIRED_KEYS.has(check.key) && check.status === "bad");
    const missingTools = requiredFailures.filter((check) => foundStatus(pong[check.key === "ytdlp" ? "ytDlp" : check.key]) === false).map((check) => check.label);
    const brokenTools = requiredFailures.filter((check) => check.key === "ytdlp" && !missingTools.includes(check.label)).map((check) => check.label);
    const unsupportedTools = requiredFailures.filter((check) => check.key === "python" && !missingTools.includes(check.label)).map((check) => check.label);
    const warnings = checklist.filter((check) => check.status === "warn").map((check) => check.key);
    const state = updateReason ? "outdated" : requiredFailures.length ? "tools" : "ready";
    const setupMethod = downloader.status === "warn" ? "browser"
      : downloader.status === "ok" ? pong.downloader.name : "unknown";
    return view(state, checklist, { hostVersion, updateReason, unknownChecks, missingTools, brokenTools, unsupportedTools, warnings, setupMethod });
  }

  /** "yt-dlp", "yt-dlp and ffmpeg", "a, b and c". */
  function joinNames(names) {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }

  /** Confirmed required tool problems, as a sentence fragment. */
  function describeToolProblems({ missingTools, brokenTools, unsupportedTools = [] }) {
    const parts = [];
    if (missingTools.length > 0) parts.push(`${joinNames(missingTools)} ${missingTools.length > 1 ? "are" : "is"} missing`);
    if (brokenTools.length > 0) parts.push(`${joinNames(brokenTools)} ${brokenTools.length > 1 ? "don't" : "doesn't"} run`);
    if (unsupportedTools.length > 0) parts.push(`${joinNames(unsupportedTools)} ${unsupportedTools.length > 1 ? "are" : "is"} unsupported`);
    return parts.join(", and ");
  }

  function view(state, checklist, { missingTools = [], brokenTools = [], unsupportedTools = [], warnings = [],
    unknownChecks = [], updateReason = null, hostVersion = null, error = null, setupMethod = "unknown" } = {}) {
    const needsAttention = state !== "ready" || warnings.length > 0 || unknownChecks.length > 0;
    return { state, checklist, missingTools, brokenTools, unsupportedTools, warnings, unknownChecks,
      updateReason, needsAttention, hostVersion, error, setupMethod };
  }

  return Object.freeze({
    MANUAL_INSTALL_URL,
    MIN_HOST_VERSION,
    SETUP_STATES,
    setupScriptUrl,
    setupCommand,
    parseVersion,
    compareVersions,
    isHostVersionSupported,
    deriveSetupState,
    describeToolProblems,
    joinNames,
  });
});
