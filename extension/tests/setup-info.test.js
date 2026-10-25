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
  hostVersion: "1.1.0",
  ytDlp: { found: true, path: "/usr/bin/yt-dlp", version: "2026.10.21" },
  ffmpeg: { found: true, path: "/usr/bin/ffmpeg" },
  jsRuntime: DENO,
};

/** @returns {string[]} "key:status" per checklist row, for compact assertions */
function statuses(view) {
  return view.checklist.map((item) => `${item.key}:${item.status}`);
}

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
  assert.equal(setup.MIN_HOST_VERSION, "1.1.0");
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
  assert.equal(setup.isHostVersionSupported("1.1.0"), true);
  assert.equal(setup.isHostVersionSupported("1.2.0"), true);
  assert.equal(setup.isHostVersionSupported("1.0.0", "1.0.0"), true, "an explicit minimum overrides the default");
  assert.equal(setup.isHostVersionSupported("0.9.0"), false);
  assert.equal(setup.isHostVersionSupported(undefined), false);
  assert.equal(setup.isHostVersionSupported("dev"), false);
  assert.equal(setup.isHostVersionSupported("1.4.0", "1.5.0"), false);
});

test("no reply yet: checking, everything pending", () => {
  const view = setup.deriveSetupState(null);
  assert.equal(view.state, "checking");
  assert.deepEqual(statuses(view), ["helper:pending", "ytdlp:pending", "ffmpeg:pending", "jsRuntime:pending"]);
  assert.equal(view.error, null);
});

test("an unreachable helper is missing and keeps the browser's error", () => {
  const view = setup.deriveSetupState({ ok: false, error: "No such native application" });
  assert.equal(view.state, "missing");
  assert.deepEqual(statuses(view), ["helper:bad", "ytdlp:pending", "ffmpeg:pending", "jsRuntime:pending"]);
  assert.equal(view.error, "No such native application");
  assert.equal(setup.deriveSetupState({ ok: true }).state, "missing", "ok without a pong");
  assert.equal(setup.deriveSetupState({ ok: false }).error, "The helper did not answer.");
});

test("an old helper is outdated even when the tools are there", () => {
  const view = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, hostVersion: "0.9.0" } });
  assert.equal(view.state, "outdated");
  assert.equal(view.hostVersion, "0.9.0");
  assert.deepEqual(statuses(view), ["helper:bad", "ytdlp:ok", "ffmpeg:ok", "jsRuntime:ok"]);
  assert.match(view.checklist[0].detail, /0\.9\.0, needs 1\.1\.0 or newer/);
  const unknown = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, hostVersion: undefined } });
  assert.equal(unknown.state, "outdated");
  assert.match(unknown.checklist[0].detail, /unknown/);
});

test("a connected helper without yt-dlp or ffmpeg lists what is missing", () => {
  const noFfmpeg = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, ffmpeg: { found: false, path: null } } });
  assert.equal(noFfmpeg.state, "tools");
  assert.deepEqual(noFfmpeg.missingTools, ["ffmpeg"]);
  assert.deepEqual(statuses(noFfmpeg), ["helper:ok", "ytdlp:ok", "ffmpeg:bad", "jsRuntime:ok"]);
  assert.deepEqual(noFfmpeg.brokenTools, []);
  assert.equal(setup.describeToolProblems(noFfmpeg), "ffmpeg is missing");

  const neither = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, ytDlp: { found: false }, ffmpeg: undefined } });
  assert.equal(neither.state, "tools");
  assert.deepEqual(neither.missingTools, ["yt-dlp", "ffmpeg"]);
  assert.equal(setup.describeToolProblems(neither), "yt-dlp and ffmpeg are missing");
});

test("a 1.0.0 helper (no jsRuntime, unprobed yt-dlp) is outdated", () => {
  const { jsRuntime, ...oldPong } = READY_PONG;
  const view = setup.deriveSetupState({ ok: true, pong: { ...oldPong, hostVersion: "1.0.0" } });
  assert.equal(view.state, "outdated");
  assert.match(view.checklist[0].detail, /1\.0\.0, needs 1\.1\.0 or newer/);
  assert.deepEqual(view.checklist[3], {
    key: "jsRuntime",
    label: "JavaScript runtime",
    status: "pending",
    detail: "Not reported by this helper version",
  });
  assert.deepEqual(view.warnings, [], "an unknown runtime is not a warning");
  assert.equal(setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, hostVersion: "1.1.0" } }).state, "ready");
});

test("yt-dlp found without a version is installed but doesn't run, which blocks ready", () => {
  for (const version of [null, "", undefined]) {
    const view = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, ytDlp: { found: true, path: "/usr/bin/yt-dlp", version } } });
    assert.equal(view.state, "tools", String(version));
    assert.deepEqual(view.missingTools, []);
    assert.deepEqual(view.brokenTools, ["yt-dlp"]);
    assert.deepEqual(view.checklist[1], { key: "ytdlp", label: "yt-dlp", status: "bad", detail: "Installed but doesn't run" });
    assert.equal(setup.describeToolProblems(view), "yt-dlp doesn't run");
  }
  const both = setup.deriveSetupState({
    ok: true,
    pong: { ...READY_PONG, ytDlp: { found: true, version: null }, ffmpeg: { found: false } },
  });
  assert.equal(setup.describeToolProblems(both), "ffmpeg is missing, and yt-dlp doesn't run");
});

test("a found JavaScript runtime shows its name and path", () => {
  const view = setup.deriveSetupState({ ok: true, pong: READY_PONG });
  assert.deepEqual(view.checklist[3], {
    key: "jsRuntime",
    label: "JavaScript runtime",
    status: "ok",
    detail: "deno (/home/user/.deno/bin/deno)",
  });
  const node = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, jsRuntime: { name: "node", path: "/usr/bin/node" } } });
  assert.equal(node.checklist[3].detail, "node (/usr/bin/node)");
  const noPath = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, jsRuntime: { name: "bun" } } });
  assert.equal(noPath.checklist[3].detail, "bun");
});

test("no JavaScript runtime is ready with a warning, not a blocker", () => {
  const view = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, jsRuntime: null } });
  assert.equal(view.state, "ready");
  assert.deepEqual(view.warnings, ["jsRuntime"]);
  assert.deepEqual(view.checklist[3], {
    key: "jsRuntime",
    label: "JavaScript runtime",
    status: "warn",
    detail: "Recommended for YouTube: run the setup command again to install Deno",
  });
  const tools = setup.deriveSetupState({ ok: true, pong: { ...READY_PONG, jsRuntime: null, ffmpeg: { found: false } } });
  assert.equal(tools.state, "tools", "the warning does not hide a real problem");
  assert.deepEqual(tools.warnings, ["jsRuntime"]);
});

test("an absent or garbled jsRuntime field is unknown, never a warning", () => {
  const { jsRuntime, ...withoutField } = READY_PONG;
  for (const pong of [withoutField, { ...READY_PONG, jsRuntime: {} }, { ...READY_PONG, jsRuntime: "deno" }]) {
    const view = setup.deriveSetupState({ ok: true, pong });
    assert.equal(view.checklist[3].status, "pending", JSON.stringify(pong.jsRuntime));
    assert.deepEqual(view.warnings, []);
  }
});

test("everything installed is ready, with versions in the checklist", () => {
  const view = setup.deriveSetupState({ ok: true, pong: READY_PONG });
  assert.equal(view.state, "ready");
  assert.deepEqual(statuses(view), ["helper:ok", "ytdlp:ok", "ffmpeg:ok", "jsRuntime:ok"]);
  assert.deepEqual(
    view.checklist.map((item) => item.detail),
    ["Version 1.1.0", "Version 2026.10.21", "Found", "deno (/home/user/.deno/bin/deno)"],
  );
  assert.deepEqual(view.missingTools, []);
  assert.deepEqual(view.brokenTools, []);
  assert.deepEqual(view.warnings, []);
  assert.equal(setup.describeToolProblems(view), "");
});

test("every derived state is a declared state", () => {
  const replies = [
    null,
    { ok: false },
    { ok: true, pong: READY_PONG },
    { ok: true, pong: { hostVersion: "0.1" } },
    { ok: true, pong: { ...READY_PONG, jsRuntime: null } },
    { ok: true, pong: { ...READY_PONG, ytDlp: { found: true, version: null } } },
  ];
  for (const reply of replies) assert.ok(setup.SETUP_STATES.includes(setup.deriveSetupState(reply).state));
});
