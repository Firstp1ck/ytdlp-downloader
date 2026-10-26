"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const setup = require("../shared/setup-info.js");

const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")).version;
const DENO = { name: "deno", path: "/home/user/.deno/bin/deno" };
const READY_PONG = {
  type: "pong",
  hostVersion: "1.3.0",
  python: { found: true, path: "/usr/bin/python3", version: "3.14.0", supported: true },
  ytDlp: { found: true, path: "/usr/bin/yt-dlp", version: "2026.10.21" },
  ffmpeg: { found: true, path: "/usr/bin/ffmpeg" },
  ffprobe: { found: true, path: "/usr/bin/ffprobe" },
  jsRuntime: DENO,
  picker: "zenity",
  opener: { found: true, path: "/usr/bin/xdg-open" },
  userDirs: { found: true, path: "/usr/bin/xdg-user-dir" },
  setupLauncher: { found: true, path: "/home/user/.local/bin/ytdlp-setup" },
  downloader: { found: true, name: "curl", path: "/usr/bin/curl" },
  coreutils: { found: true, missing: [] },
  nativeMessagingProxy: { found: true, path: "/usr/bin/xdg-native-messaging-proxy", applicable: true },
};
const KEYS = ["helper", "python", "ytdlp", "ffmpeg", "ffprobe", "jsRuntime", "picker", "opener", "userDirs", "setupLauncher", "downloader", "coreutils", "nativeMessagingProxy"];
const derive = (patch = {}) => setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, ...patch } });
const row = (view, key) => view.checklist.find((check) => check.key === key);

test("the command pins the release of the given version", () => {
  assert.equal(
    setup.setupCommand("1.3.0"),
    "curl -fsSL https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v1.3.0/setup.sh | bash",
  );
  assert.equal(
    setup.setupScriptUrl("2.0.1"),
    "https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v2.0.1/setup.sh",
  );
  assert.match(setup.setupCommand(MANIFEST_VERSION), new RegExp(`/v${MANIFEST_VERSION.replaceAll(".", "\\.")}/setup\\.sh \\| bash$`));
  assert.equal(setup.MANUAL_INSTALL_URL, "https://github.com/Firstp1ck/ytdlp-downloader#install");
});

test("a non-version never ends up in the command", () => {
  for (const bad of ["", "main", "1.3.0; rm -rf ~", "../1.0.0", undefined]) {
    assert.throws(() => setup.setupCommand(bad), TypeError, String(bad));
  }
});

test("MIN_HOST_VERSION is a parsable version the current host meets", () => {
  assert.equal(setup.MIN_HOST_VERSION, "1.3.0");
  const hostSource = fs.readFileSync(path.join(__dirname, "..", "..", "native-host", "ytdlp_host.py"), "utf8");
  const hostVersion = /^HOST_VERSION = "([^"]+)"$/m.exec(hostSource)?.[1];
  assert.ok(setup.isHostVersionSupported(hostVersion), `host ${hostVersion}`);
});

test("versions compare numerically, not as text", () => {
  const { compareVersions } = setup;
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.ok(compareVersions("0.9.9", "1.0.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3-rc1", "1.2.3"), 0, "suffixes are ignored");
  assert.ok(compareVersions("2", "1.99.99") > 0);
  assert.throws(() => compareVersions("x", "1.0.0"), TypeError);
});

test("parseVersion accepts only leading version numbers", () => {
  assert.deepEqual(setup.parseVersion("1.3.0"), [1, 3, 0]);
  assert.deepEqual(setup.parseVersion(" 2.1 "), [2, 1, 0]);
  for (const bad of ["", "1.", "1..0", "a1.0", "1.0.0.0", null, 1]) assert.equal(setup.parseVersion(bad), null, String(bad));
});

test("isHostVersionSupported treats missing or garbled versions as too old", () => {
  assert.equal(setup.isHostVersionSupported("1.0.0"), false, "1.0.0 predates jsRuntime and the yt-dlp probe");
  assert.equal(setup.isHostVersionSupported("1.0.99"), false);
  assert.equal(setup.isHostVersionSupported("1.1.0"), false);
  assert.equal(setup.isHostVersionSupported("1.2.0"), false);
  assert.equal(setup.isHostVersionSupported("1.0.0", "1.0.0"), true, "an explicit minimum overrides the default");
  assert.equal(setup.isHostVersionSupported("0.9.0"), false);
  assert.equal(setup.isHostVersionSupported(undefined), false);
  assert.equal(setup.isHostVersionSupported("dev"), false);
  assert.equal(setup.isHostVersionSupported("1.4.0", "1.5.0"), false);
});

test("no reply yet: all thirteen rows are pending, with helper bootstrap context", () => {
  const view = setup.deriveSetupState(null);
  assert.equal(view.state, "checking");
  assert.deepEqual(view.checklist.map((check) => check.key), KEYS);
  assert.ok(view.checklist.every((check) => check.status === "pending"));
  for (const check of view.checklist.filter((check) => check.key !== "helper")) {
    assert.match(check.detail, /Requires a working helper/);
    assert.ok(check.requirement);
  }
  assert.equal(view.error, null);
  assert.equal(view.needsAttention, true);
});

test("unreachable or malformed helper replies keep all dependent checks pending", () => {
  for (const reply of [{ ok: false, error: "No such native application" }, { ok: true }, { ok: true, pong: [] },
    { ok: true, pong: "pong" }, [], true, "garbled"]) {
    const view = setup.deriveSetupState(reply);
    assert.equal(view.state, "missing");
    assert.equal(row(view, "helper").status, "bad");
    assert.ok(view.checklist.filter((check) => check.key !== "helper").every((check) => check.status === "pending"));
    assert.deepEqual(view.missingTools, []);
    assert.deepEqual(view.warnings, []);
    assert.deepEqual(view.unknownChecks, []);
    assert.ok(view.error);
  }
  assert.equal(setup.deriveSetupState({ ok: false, error: "<browser error>" }).error, "<browser error>");
});

test("healthy diagnostics cover every row with explicit requirements and stop needing attention", () => {
  const view = derive();
  assert.equal(view.state, "ready");
  assert.deepEqual(view.checklist.map((check) => check.key), KEYS);
  assert.ok(view.checklist.every((check) => check.status === "ok" && check.requirement && check.detail));
  assert.equal(row(view, "python").requirement, "Required for downloads");
  assert.equal(row(view, "jsRuntime").requirement, "Recommended for YouTube");
  assert.equal(row(view, "picker").requirement, "Optional convenience");
  assert.equal(row(view, "setupLauncher").requirement, "Setup only");
  assert.equal(row(view, "downloader").requirement, "Setup only");
  assert.equal(row(view, "nativeMessagingProxy").requirement, "Conditional: Flatpak / Snap");
  assert.equal(view.needsAttention, false);
  assert.equal(setup.describeToolProblems(view), "");
});

test("1.2.x and earlier helpers explicitly need an update", () => {
  for (const hostVersion of ["0.9.0", "1.0.0", "1.1.0", "1.1.99", "1.2.0", "1.2.99"]) {
    const view = derive({ hostVersion });
    assert.equal(view.state, "outdated");
    assert.equal(view.updateReason, "version");
    assert.match(row(view, "helper").detail, /needs 1\.3\.0 or newer/);
    assert.equal(view.needsAttention, true);
  }
  const legacy = setup.deriveSetupState({ ok: true, pong: { hostVersion: "1.1.0", ytDlp: READY_PONG.ytDlp,
    ffmpeg: READY_PONG.ffmpeg, picker: "zenity", jsRuntime: DENO } });
  for (const key of ["python", "ffprobe", "opener", "userDirs", "setupLauncher", "downloader", "coreutils"]) {
    assert.equal(row(legacy, key).status, "pending", key);
  }
  assert.deepEqual(legacy.missingTools, []);
  assert.deepEqual(legacy.warnings, []);
});

test("missing or invalid helper versions have their own update reason", () => {
  for (const hostVersion of [undefined, null, "garbled", 120, [], "9".repeat(400)]) {
    const view = derive({ hostVersion });
    assert.equal(view.state, "outdated");
    assert.equal(view.updateReason, "versionUnknown");
    assert.match(row(view, "helper").detail, /Version not reported or invalid/);
  }
});

test("each confirmed required tool failure blocks readiness and names that tool", () => {
  for (const [field, key, name] of [["python", "python", "Python 3.8+"], ["ytDlp", "ytdlp", "yt-dlp"],
    ["ffmpeg", "ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe", "ffprobe"]]) {
    const view = derive({ [field]: { found: false, path: null } });
    assert.equal(view.state, "tools", key);
    assert.equal(row(view, key).status, "bad");
    assert.deepEqual(view.missingTools, [name]);
    assert.equal(setup.describeToolProblems(view), `${name} is missing`);
    assert.equal(view.needsAttention, true);
  }
});

test("Python 3.8 boundary, unsupported versions and conflicting diagnostics", () => {
  for (const version of ["3.8.0", "3.9.0", "3.14.0", "4.0.0"]) {
    assert.equal(derive({ python: { found: true, supported: true, version } }).state, "ready", version);
  }
  const unsupported = derive({ python: { found: true, version: "3.7.17", supported: false } });
  assert.equal(unsupported.state, "tools");
  assert.deepEqual(unsupported.unsupportedTools, ["Python 3.8+"]);
  assert.deepEqual(unsupported.brokenTools, []);
  assert.match(setup.describeToolProblems(unsupported), /Python 3\.8\+ is unsupported/);
  for (const report of [{ found: true, version: "3.7.17", supported: true },
    { found: true, version: "3.8.0", supported: false }, { found: true, version: "garbled", supported: true },
    { found: true, version: "3.14.0" }, { found: true, version: "3.14.0", supported: "yes" }]) {
    const view = derive({ python: report });
    assert.equal(view.state, "outdated");
    assert.equal(row(view, "python").status, "pending");
    assert.deepEqual(view.missingTools, []);
  }
});

test("all unreported or malformed required fields prevent Ready without claiming missing", () => {
  for (const [field, key] of [["python", "python"], ["ytDlp", "ytdlp"], ["ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe"]]) {
    for (const report of [undefined, null, [], "found", {}, { found: "true" }, { found: 1 }]) {
      const view = derive({ [field]: report });
      assert.equal(view.state, "outdated", `${field}: ${JSON.stringify(report)}`);
      assert.equal(view.updateReason, "diagnostics");
      assert.equal(row(view, key).status, "pending");
      assert.ok(view.unknownChecks.includes(key));
      assert.deepEqual(view.missingTools, []);
      assert.deepEqual(view.brokenTools, []);
      assert.equal(view.needsAttention, true);
    }
  }
});

test("explicit failed yt-dlp execution probes require repair; absent probes stay unknown", () => {
  for (const version of [null, ""]) {
    const view = derive({ ytDlp: { found: true, version } });
    assert.equal(view.state, "tools");
    assert.deepEqual(view.brokenTools, ["yt-dlp"]);
    assert.match(row(view, "ytdlp").detail, /doesn't run/);
  }
  for (const version of [undefined, 123, {}, "   "]) {
    const view = derive({ ytDlp: { found: true, version } });
    assert.equal(view.state, "outdated");
    assert.deepEqual(view.brokenTools, []);
  }
  const mixed = derive({ ytDlp: { found: true, version: null }, ffmpeg: { found: false }, ffprobe: { found: false } });
  assert.equal(setup.describeToolProblems(mixed), "ffmpeg and ffprobe are missing, and yt-dlp doesn't run");
});

test("each confirmed recommended, optional and setup failure warns without blocking downloads", () => {
  const cases = [
    ["jsRuntime", null, /Deno.*Node 22/],
    ["picker", null, /zenity, kdialog or yad.*manually/],
    ["opener", { found: false }, /xdg-open.*opening saved folders/],
    ["userDirs", { found: false }, /xdg-user-dir.*falls back to ~\/Downloads/],
    ["setupLauncher", { found: false, path: null }, /Not installed or not verified/],
    ["downloader", { found: false, name: null }, /Neither curl nor wget/],
    ["coreutils", { found: false, missing: ["cat", "install"] }, /Missing: cat and install/],
    ["nativeMessagingProxy", { found: false, applicable: true }, /detected Flatpak \/ Snap environment/],
  ];
  for (const [key, report, detail] of cases) {
    const view = derive({ [key]: report });
    assert.equal(view.state, "ready", key);
    assert.equal(row(view, key).status, "warn");
    assert.match(row(view, key).detail, detail);
    assert.deepEqual(view.warnings, [key]);
    assert.deepEqual(view.missingTools, []);
    assert.equal(view.needsAttention, true);
  }
  const warningsAndFailure = derive({ picker: null, jsRuntime: null, ffprobe: { found: false } });
  assert.equal(warningsAndFailure.state, "tools");
  assert.deepEqual(warningsAndFailure.warnings, ["jsRuntime", "picker"]);
});

test("unreported optional fields remain pending and actionable rather than falsely healthy or missing", () => {
  for (const key of ["jsRuntime", "picker", "opener", "userDirs", "setupLauncher", "downloader", "coreutils"]) {
    for (const report of [undefined, [], {}, 1, ""]) {
      const view = derive({ [key]: report });
      assert.equal(view.state, "ready", key);
      assert.equal(row(view, key).status, "pending");
      assert.deepEqual(view.warnings, []);
      assert.deepEqual(view.unknownChecks, [key]);
      assert.equal(view.needsAttention, true);
    }
  }
  for (const coreutils of [{ found: true, missing: ["cat"] }, { found: false, missing: [] },
    { found: true }, { found: false, missing: [42] }, { found: false, missing: ["not-a-setup-command"] }]) {
    assert.equal(row(derive({ coreutils }), "coreutils").status, "pending");
  }
  assert.equal(row(derive({ downloader: { found: true, name: "aria2" } }), "downloader").status, "pending");
});

test("proxy applicability is conditional, never assumed from a missing executable", () => {
  for (const nativeMessagingProxy of [undefined, null, {}, { found: false, path: null, applicable: null },
    { found: false, applicable: false }, { found: false, applicable: "true" }]) {
    const view = derive({ nativeMessagingProxy });
    assert.equal(view.state, "ready");
    assert.equal(row(view, "nativeMessagingProxy").status, "pending");
    assert.match(row(view, "nativeMessagingProxy").detail, /Applicability not established/);
    assert.deepEqual(view.warnings, []);
    assert.deepEqual(view.unknownChecks, []);
    assert.equal(view.needsAttention, false, "no proxy warning for every native-browser user");
  }
  const found = derive({ nativeMessagingProxy: { found: true, applicable: null } });
  assert.equal(row(found, "nativeMessagingProxy").status, "ok");
  assert.match(row(found, "nativeMessagingProxy").detail, /not established/);
  const unreported = derive({ nativeMessagingProxy: { applicable: true } });
  assert.equal(unreported.state, "ready");
  assert.equal(row(unreported, "nativeMessagingProxy").status, "pending");
  assert.deepEqual(unreported.unknownChecks, ["nativeMessagingProxy"]);
  assert.equal(unreported.needsAttention, true);
});

test("legacy picker remains a string or null; either downloader and runtime details are preserved", () => {
  assert.equal(row(derive(), "picker").detail, "zenity");
  for (const name of ["curl", "wget"]) {
    assert.equal(row(derive({ downloader: { found: true, name } }), "downloader").detail, `Found: ${name}`);
  }
  assert.equal(row(derive(), "jsRuntime").detail, "deno (/home/user/.deno/bin/deno)");
  assert.equal(row(derive({ jsRuntime: { name: "node", path: "/usr/bin/node" } }), "jsRuntime").detail, "node (/usr/bin/node)");
});

test("every derived state is a declared state", () => {
  for (const view of [setup.deriveSetupState(null), setup.deriveSetupState({ ok: false }), derive(),
    derive({ hostVersion: "1.1.0" }), derive({ ffprobe: { found: false } }), derive({ python: {} })]) {
    assert.ok(setup.SETUP_STATES.includes(view.state));
  }
});


test("setup commands are literal, pinned and contain no Python bootstrap", () => {
  const url = setup.setupScriptUrl(MANIFEST_VERSION);
  assert.equal(setup.setupCommand(MANIFEST_VERSION, "launcher"), `"$HOME/.local/bin/ytdlp-setup" ${MANIFEST_VERSION}`);
  assert.equal(setup.setupCommand(MANIFEST_VERSION, "curl"), `curl -fsSL ${url} | bash`);
  assert.equal(setup.setupCommand(MANIFEST_VERSION, "wget"), `wget -qO- ${url} | bash`);
  assert.equal(setup.setupCommand(MANIFEST_VERSION, "browser"), "bash ");
  for (const method of ["python", "aria2"]) assert.throws(() => setup.setupCommand(MANIFEST_VERSION, method), TypeError);
  assert.equal(derive().setupMethod, "launcher");
  for (const name of ["curl", "wget"]) {
    assert.equal(derive({ setupLauncher: { found: false, path: null }, downloader: { found: true, name } }).setupMethod, name);
  }
  assert.equal(derive({ setupLauncher: undefined, downloader: { found: false } }).setupMethod, "browser");
  assert.equal(derive({ setupLauncher: undefined, downloader: undefined }).setupMethod, "unknown");
  assert.equal(setup.deriveSetupState({ ok: false }).setupMethod, "unknown");
  assert.equal("pythonPath" in derive(), false);
  const source = fs.readFileSync(path.join(__dirname, "..", "shared/setup-info.js"), "utf8");
  assert.doesNotMatch(source, /pythonPath|urllib\.request|subprocess\.run| -I -c /);
});

test("all setup methods reject versions outside the native CLI contract", () => {
  const invalid = ["", "main", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-beta", "1.2.3+build", "1.2.3/other",
    " 1.2.3", "1.2.3 ", "1.2.3\n", "1.2.3\r", "1.2.3\r\n", "1.2.3\0", "١.2.3", "１.2.3", "1e1.2.3",
    "1".repeat(10) + ".2.3", "1.2." + "9".repeat(10), "--help", "$(touch injected)", "1.2.3;exit 99", null, undefined, 123, {}];
  for (const version of invalid) {
    for (const method of ["launcher", "curl", "wget", "browser"]) {
      assert.throws(() => setup.setupCommand(version, method), TypeError, `${method}: ${JSON.stringify(version)}`);
    }
    assert.throws(() => setup.setupScriptUrl(version), TypeError);
  }
  for (const version of ["0.0.0", "01.002.0003", "999999999.999999999.999999999"]) {
    assert.equal(setup.setupCommand(version, "launcher"), `"$HOME/.local/bin/ytdlp-setup" ${version}`);
  }
});

test("only a well-formed verified canonical launcher capability enables the short command", () => {
  const invalidPath = [undefined, null, {}, "", "ytdlp-setup", "~/.local/bin/ytdlp-setup", "/tmp/other",
    "/home/user/.local/bin/ytdlp-setup/", "/home/user/../other/.local/bin/ytdlp-setup",
    "/home//user/.local/bin/ytdlp-setup", "/home/user\n/.local/bin/ytdlp-setup", "/home/user\0/.local/bin/ytdlp-setup",
    "/" + "x".repeat(4096) + "/.local/bin/ytdlp-setup"];
  const invalid = [undefined, null, [], {}, "found", { found: "true", path: READY_PONG.setupLauncher.path },
    { found: false, path: READY_PONG.setupLauncher.path }, { found: false },
    ...invalidPath.map((path) => ({ found: true, path }))];
  for (const setupLauncher of invalid) {
    const view = derive({ setupLauncher });
    assert.equal(view.state, "ready", JSON.stringify(setupLauncher));
    assert.equal(row(view, "setupLauncher").status, "pending");
    assert.deepEqual(view.unknownChecks, ["setupLauncher"]);
    assert.deepEqual(view.warnings, []);
    assert.equal(view.setupMethod, "curl");
  }
  for (const hostVersion of ["1.3.0", "1.2.0", "1.0.0"]) {
    const view = derive({ hostVersion, downloader: { found: false } });
    assert.equal(view.setupMethod, "launcher", "capability survives a future minimum protocol bump");
  }
  assert.equal(setup.deriveSetupState({ ok: true, pong: READY_PONG }, "2.0.0").setupMethod, "launcher");
  for (const path of ["/.local/bin/ytdlp-setup", "/home/O'Brien $(touch injected); folder/.local/bin/ytdlp-setup"]) {
    assert.equal(derive({ setupLauncher: { found: true, path, command: "unsafe host command" } }).setupMethod, "launcher");
  }
});

test("malformed nested diagnostic values never coerce objects into display strings", () => {
  const invalid = { toString: null, valueOf: null };
  for (const [field, report, key] of [
    ["python", { found: true, version: invalid, supported: true }, "python"],
    ["ytDlp", { found: true, version: invalid }, "ytdlp"],
    ["jsRuntime", { name: invalid, path: invalid }, "jsRuntime"],
    ["downloader", { found: true, name: invalid }, "downloader"],
    ["coreutils", { found: false, missing: [invalid] }, "coreutils"],
    ["picker", invalid, "picker"],
  ]) {
    assert.equal(row(derive({ [field]: report }), key).status, "pending", field);
  }
  assert.equal(derive({ downloader: { found: false, name: invalid } }).setupMethod, "launcher");
});
