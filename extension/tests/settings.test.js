"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const settings = require("../shared/settings.js");

const { DEFAULTS, CHOICES, STORAGE_KEY } = settings;

/** In-memory stand-in for browser.storage.local. */
function fakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
  };
}

test("defaults: each action has its own settings, notifications are shared", () => {
  assert.deepEqual({ ...DEFAULTS }, {
    videoResolution: "best",
    videoFormat: "mp4",
    videoSaveDir: "",
    videoPlaylist: false,
    audioQuality: "best",
    audioFormat: "mp3",
    audioSaveDir: "",
    audioPlaylist: false,
    notifications: true,
  });
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(Object.isFrozen(CHOICES.videoResolution[0]));
});

test("every enum default is one of its choices", () => {
  for (const [key, choices] of Object.entries(CHOICES)) {
    assert.ok(choices.some((c) => c.value === DEFAULTS[key]), key);
  }
});

test("enum values match the native messaging protocol", () => {
  const values = (key) => CHOICES[key].map((c) => c.value);
  assert.deepEqual([...settings.MODES], ["video", "audio"]);
  assert.deepEqual(values("videoResolution"), ["best", "2160", "1440", "1080", "720", "480", "360"]);
  assert.deepEqual(values("videoFormat"), ["any", "mp4", "webm", "mkv"]);
  assert.deepEqual(values("audioQuality"), ["best", "320", "256", "192", "128", "96"]);
  assert.deepEqual(values("audioFormat"), ["best", "mp3", "m4a", "opus", "flac", "wav"]);
});

test("enum values and download keys match the native host", () => {
  const hostPath = require("node:path").join(__dirname, "..", "..", "native-host", "ytdlp_host.py");
  const script = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('h', sys.argv[1])",
    "h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)",
    "print(json.dumps({'enums': {k: sorted(v) for k, v in h.ENUMS.items()}, 'keys': sorted(h.DEFAULT_OPTIONS)}))",
  ].join("\n");
  const out = require("node:child_process").execFileSync("python3", ["-I", "-c", script, hostPath], { encoding: "utf8" });
  const host = JSON.parse(out);
  for (const [key, values] of Object.entries(host.enums)) {
    const ours = key === "mode" ? [...settings.MODES] : CHOICES[key].map((c) => c.value);
    assert.deepEqual(ours.sort(), values, key);
  }
  assert.deepEqual([...settings.DOWNLOAD_OPTION_KEYS].sort(), host.keys);
});

test("normalizeSettings returns defaults for missing or non-object data", () => {
  for (const raw of [undefined, null, 42, "settings", true, [], ["video"]]) {
    assert.deepEqual(settings.normalizeSettings(raw), { ...DEFAULTS }, String(raw));
  }
});

test("normalizeSettings merges partial data over defaults", () => {
  const result = settings.normalizeSettings({ audioSaveDir: "~/Music", audioFormat: "opus" });
  assert.deepEqual(result, { ...DEFAULTS, audioSaveDir: "~/Music", audioFormat: "opus" });
});

test("normalizeSettings migrates the old shared saveDir/playlist to both actions", () => {
  const result = settings.normalizeSettings({ mode: "audio", saveDir: "~/YT", playlist: true });
  assert.deepEqual(result, {
    ...DEFAULTS, videoSaveDir: "~/YT", audioSaveDir: "~/YT", videoPlaylist: true, audioPlaylist: true,
  });
  assert.equal(Object.hasOwn(result, "mode"), false, "the removed default action is dropped");
  const explicit = settings.normalizeSettings({ saveDir: "~/YT", audioSaveDir: "~/Music" });
  assert.equal(explicit.audioSaveDir, "~/Music", "new keys win over legacy ones");
  assert.equal(explicit.videoSaveDir, "~/YT");
});

test("normalizeSettings replaces invalid values and drops unknown keys", () => {
  const result = settings.normalizeSettings({
    videoResolution: 1080,
    videoFormat: "MP4",
    audioQuality: "320k",
    audioFormat: "--exec rm",
    videoSaveDir: "relative/path",
    audioSaveDir: "-P/tmp",
    videoPlaylist: "true",
    audioPlaylist: 1,
    notifications: 0,
    extraArgs: "--exec evil",
    __proto__: { audioFormat: "flac" },
  });
  assert.deepEqual(result, { ...DEFAULTS });
  assert.equal(Object.hasOwn(result, "extraArgs"), false);
});

test("normalizeSettings does not read inherited properties", () => {
  const raw = Object.create({ audioFormat: "flac" });
  assert.equal(settings.normalizeSettings(raw).audioFormat, "mp3");
});

test("normalizeSettings returns a fresh mutable object", () => {
  const a = settings.normalizeSettings({});
  a.audioFormat = "flac";
  assert.equal(settings.normalizeSettings({}).audioFormat, "mp3");
});

test("validateSaveDir accepts empty, ~, ~/ and absolute paths", () => {
  assert.deepEqual(settings.validateSaveDir(""), { ok: true, value: "" });
  assert.deepEqual(settings.validateSaveDir("   "), { ok: true, value: "" });
  assert.deepEqual(settings.validateSaveDir("~"), { ok: true, value: "~" });
  assert.deepEqual(settings.validateSaveDir(" ~/Videos/YT "), { ok: true, value: "~/Videos/YT" });
  assert.deepEqual(settings.validateSaveDir("/home/u/Music"), { ok: true, value: "/home/u/Music" });
});

test("validateSaveDir rejects relative, ~user, control characters, non-strings and long paths", () => {
  for (const bad of [
    "Videos",
    "./x",
    "../etc",
    "~root/x",
    "/tmp/a\nb",
    "/tmp/\u0000x",
    "-P/tmp",
    "file:///tmp",
    `/${"a".repeat(settings.MAX_PATH_LENGTH)}`,
    null,
    42,
    ["/tmp"],
  ]) {
    assert.equal(settings.validateSaveDir(bad).ok, false, JSON.stringify(bad));
  }
});

test("validateSetting rejects unknown keys", () => {
  assert.equal(settings.validateSetting("extraArgs", "--x").ok, false);
  assert.equal(settings.validateSetting("__proto__", {}).ok, false);
});

test("loadSettings merges stored data with defaults", async () => {
  const storage = fakeStorage({ [STORAGE_KEY]: { videoResolution: "720", videoPlaylist: true, junk: 1 } });
  assert.deepEqual(await settings.loadSettings(storage), { ...DEFAULTS, videoResolution: "720", videoPlaylist: true });
});

test("loadSettings returns defaults for empty or corrupt storage", async () => {
  assert.deepEqual(await settings.loadSettings(fakeStorage()), { ...DEFAULTS });
  assert.deepEqual(await settings.loadSettings(fakeStorage({ [STORAGE_KEY]: "corrupt" })), { ...DEFAULTS });
});

test("loadSettings throws a clear error without a storage area", async () => {
  await assert.rejects(settings.loadSettings(), /storage\.local is not available/);
});

test("saveSettings validates, merges, and writes a complete object", async () => {
  const storage = fakeStorage({ [STORAGE_KEY]: { videoFormat: "mkv", junk: true } });
  const saved = await settings.saveSettings({ audioFormat: "flac", audioSaveDir: " ~/Music " }, storage);
  const expected = { ...DEFAULTS, videoFormat: "mkv", audioFormat: "flac", audioSaveDir: "~/Music" };
  assert.deepEqual(saved, expected);
  assert.deepEqual(storage.data[STORAGE_KEY], expected);
});

test("saveSettings rejects invalid patches without writing", async () => {
  const storage = fakeStorage({ [STORAGE_KEY]: { audioFormat: "opus" } });
  await assert.rejects(settings.saveSettings({ audioQuality: "192", audioFormat: "aac" }, storage), TypeError);
  await assert.rejects(settings.saveSettings({ extraArgs: "--exec x" }, storage), /Unknown setting/);
  await assert.rejects(settings.saveSettings({ mode: "audio" }, storage), /Unknown setting/);
  await assert.rejects(settings.saveSettings({ videoSaveDir: "relative" }, storage), /absolute path/);
  await assert.rejects(settings.saveSettings(null, storage), TypeError);
  assert.deepEqual(storage.data[STORAGE_KEY], { audioFormat: "opus" });
});

const PER_ACTION = {
  ...DEFAULTS,
  videoResolution: "1080",
  videoSaveDir: "~/Videos",
  videoPlaylist: true,
  audioQuality: "192",
  audioSaveDir: "~/Music",
  audioPlaylist: false,
};

test("toDownloadOptions uses the video action's save folder and playlist setting", () => {
  const options = settings.toDownloadOptions(PER_ACTION, "video");
  assert.deepEqual(options, {
    mode: "video",
    videoResolution: "1080",
    videoFormat: "mp4",
    audioQuality: "192",
    audioFormat: "mp3",
    saveDir: "~/Videos",
    playlist: true,
  });
  assert.deepEqual(Object.keys(options).sort(), [...settings.DOWNLOAD_OPTION_KEYS].sort());
});

test("toDownloadOptions uses the audio action's save folder and playlist setting", () => {
  const options = settings.toDownloadOptions(PER_ACTION, "audio");
  assert.equal(options.mode, "audio");
  assert.equal(options.saveDir, "~/Music");
  assert.equal(options.playlist, false);
  assert.equal(options.audioQuality, "192");
});

test("toDownloadOptions normalizes corrupt settings and rejects an invalid mode", () => {
  assert.equal(settings.toDownloadOptions("garbage", "audio").audioFormat, "mp3");
  for (const bad of [undefined, "both", "VIDEO", {}]) {
    assert.throws(() => settings.toDownloadOptions(DEFAULTS, bad), TypeError, String(bad));
  }
});

test("overlapping saveSettings calls keep every patch", async () => {
  const storage = fakeStorage();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const slow = {
    async get(key) { await tick(); return storage.get(key); },
    async set(items) { await tick(); return storage.set(items); },
  };
  await Promise.all([
    settings.saveSettings({ videoResolution: "720" }, slow),
    settings.saveSettings({ audioFormat: "opus" }, slow),
  ]);
  assert.equal(storage.data[STORAGE_KEY].videoResolution, "720");
  assert.equal(storage.data[STORAGE_KEY].audioFormat, "opus");
});

test("a rejected save does not block later saves", async () => {
  const storage = fakeStorage();
  await assert.rejects(settings.saveSettings({ audioFormat: "nope" }, storage), TypeError);
  await settings.saveSettings({ audioFormat: "flac" }, storage);
  assert.equal(storage.data[STORAGE_KEY].audioFormat, "flac");
});
