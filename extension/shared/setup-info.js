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
  const MIN_HOST_VERSION = "1.1.0";
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
   * @returns {string}
   */
  function setupCommand(version) {
    return `curl -fsSL ${setupScriptUrl(version)} | bash`;
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
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
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
   * missing version counts as too old: only a broken or ancient helper sends one.
   * @param {unknown} hostVersion
   * @param {string} [minVersion]
   * @returns {boolean}
   */
  function isHostVersionSupported(hostVersion, minVersion = MIN_HOST_VERSION) {
    return parseVersion(hostVersion) !== null && compareVersions(hostVersion, minVersion) >= 0;
  }

  /**
   * @typedef {"ok" | "bad" | "warn" | "pending"} CheckStatus
   *   "warn" is recommended but does not block downloads
   * @typedef {{key: "helper" | "ytdlp" | "ffmpeg" | "jsRuntime", label: string, status: CheckStatus, detail: string}} CheckItem
   * @typedef {{
   *   state: "checking" | "missing" | "outdated" | "tools" | "ready",
   *   checklist: CheckItem[],
   *   missingTools: string[],
   *   brokenTools: string[],
   *   warnings: Array<"jsRuntime">,
   *   hostVersion: string | null,
   *   error: string | null,
   * }} SetupView
   *   missingTools: not found; brokenTools: found, but `--version` failed;
   *   warnings: recommended pieces that are missing without blocking "ready"
   */

  /**
   * Maps the background page's ping reply to what the setup UI shows.
   * @param {{ok?: boolean, pong?: object, error?: string} | null | undefined} pingResult
   *   null/undefined while the first ping is in flight
   * @param {string} [minVersion]
   * @returns {SetupView}
   */
  function deriveSetupState(pingResult, minVersion = MIN_HOST_VERSION) {
    if (pingResult === null || pingResult === undefined) {
      return view("checking", [
        item("helper", "pending", "Checking…"),
        item("ytdlp", "pending", "Checked once the helper answers"),
        item("ffmpeg", "pending", "Checked once the helper answers"),
        item("jsRuntime", "pending", "Checked once the helper answers"),
      ]);
    }
    const pong = pingResult.ok === true && pingResult.pong && typeof pingResult.pong === "object" ? pingResult.pong : null;
    if (!pong) {
      const error = typeof pingResult.error === "string" && pingResult.error ? pingResult.error : "The helper did not answer.";
      return view(
        "missing",
        [
          item("helper", "bad", "Not installed or not reachable"),
          item("ytdlp", "pending", "Checked once the helper is installed"),
          item("ffmpeg", "pending", "Checked once the helper is installed"),
          item("jsRuntime", "pending", "Checked once the helper is installed"),
        ],
        { error },
      );
    }

    const hostVersion = typeof pong.hostVersion === "string" ? pong.hostVersion : null;
    const supported = isHostVersionSupported(hostVersion, minVersion);
    const ytDlp = pong.ytDlp && typeof pong.ytDlp === "object" ? pong.ytDlp : {};
    const ffmpeg = pong.ffmpeg && typeof pong.ffmpeg === "object" ? pong.ffmpeg : {};
    // The host reports a null version when `yt-dlp --version` fails, e.g. a
    // zipimport build on a Python that is too old for it.
    const ytDlpVersion = typeof ytDlp.version === "string" && ytDlp.version ? ytDlp.version : null;
    const missingTools = [];
    const brokenTools = [];
    if (ytDlp.found !== true) missingTools.push("yt-dlp");
    else if (ytDlpVersion === null) brokenTools.push("yt-dlp");
    if (ffmpeg.found !== true) missingTools.push("ffmpeg");

    const runtime = jsRuntimeCheck(pong);
    const warnings = runtime.status === "warn" ? ["jsRuntime"] : [];

    const checklist = [
      supported
        ? item("helper", "ok", `Version ${hostVersion}`)
        : item("helper", "bad", `Version ${hostVersion ?? "unknown"}, needs ${minVersion} or newer`),
      ytDlp.found !== true
        ? item("ytdlp", "bad", "Not found")
        : ytDlpVersion === null
          ? item("ytdlp", "bad", "Installed but doesn't run")
          : item("ytdlp", "ok", `Version ${ytDlpVersion}`),
      ffmpeg.found === true
        ? item("ffmpeg", "ok", "Found")
        : item("ffmpeg", "bad", "Not found (needed for video merging and all audio downloads)"),
      runtime,
    ];
    const toolsOk = missingTools.length === 0 && brokenTools.length === 0;
    const state = !supported ? "outdated" : toolsOk ? "ready" : "tools";
    return view(state, checklist, { missingTools, brokenTools, warnings, hostVersion });
  }

  /**
   * The JavaScript runtime row. yt-dlp needs one (Deno preferred) to solve
   * YouTube's challenges; without it some formats go missing, but downloads
   * still work, so it only warns.
   * @param {object} pong
   * @returns {CheckItem}
   */
  function jsRuntimeCheck(pong) {
    const runtime = pong.jsRuntime;
    if (runtime === null) {
      return item("jsRuntime", "warn", "Recommended for YouTube: run the setup command again to install Deno");
    }
    if (runtime && typeof runtime === "object" && typeof runtime.name === "string" && runtime.name) {
      const where = typeof runtime.path === "string" && runtime.path ? ` (${runtime.path})` : "";
      return item("jsRuntime", "ok", `${runtime.name}${where}`);
    }
    // Helpers older than 1.1.0 don't report it; they are already "outdated".
    return item("jsRuntime", "pending", "Not reported by this helper version");
  }

  /**
   * "yt-dlp", "yt-dlp and ffmpeg", "a, b and c".
   * @param {string[]} names
   * @returns {string}
   */
  function joinNames(names) {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }

  /**
   * What is wrong with the tools, as a sentence fragment without a capital or
   * full stop: "ffmpeg is missing, and yt-dlp doesn't run".
   * @param {SetupView} setupView
   * @returns {string} empty if nothing is wrong
   */
  function describeToolProblems({ missingTools, brokenTools }) {
    const parts = [];
    if (missingTools.length > 0) parts.push(`${joinNames(missingTools)} ${missingTools.length > 1 ? "are" : "is"} missing`);
    if (brokenTools.length > 0) {
      parts.push(`${joinNames(brokenTools)} ${brokenTools.length > 1 ? "don't" : "doesn't"} run`);
    }
    return parts.join(", and ");
  }

  const LABELS = Object.freeze({
    helper: "Helper program",
    ytdlp: "yt-dlp",
    ffmpeg: "ffmpeg",
    jsRuntime: "JavaScript runtime",
  });

  /** @returns {CheckItem} */
  function item(key, status, detail) {
    return { key, label: LABELS[key], status, detail };
  }

  /** @returns {SetupView} */
  function view(state, checklist, { missingTools = [], brokenTools = [], warnings = [], hostVersion = null, error = null } = {}) {
    return { state, checklist, missingTools, brokenTools, warnings, hostVersion, error };
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
