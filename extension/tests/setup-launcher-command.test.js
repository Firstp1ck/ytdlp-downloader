"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { setupCommand } = require("../shared/setup-info.js");
const VERSION = require("../manifest.json").version;

test("the actual short command safely expands HOME as one launcher path under sh and bash", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-launcher-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "Home's $(touch injected); `touch injected` $USER & folder");
  const launcher = path.join(home, ".local/bin/ytdlp-setup");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  // Only a recorder: no helper, installer, remote request or package manager.
  fs.writeFileSync(launcher, '#!/bin/sh\n# Managed by yt-dlp Downloader\nprintf \'%s\\n\' "$#" "$@" > "$ARGV_LOG"\nexit "$FIXTURE_EXIT"\n', { mode: 0o755 });
  for (const shell of ["/bin/sh", "/bin/bash"]) {
    for (const version of [VERSION, "0.0.0", "01.002.0003", "999999999.999999999.999999999"]) {
      const log = path.join(root, "argv.log");
      const command = setupCommand(version, "launcher");
      assert.equal(command, `"$HOME/.local/bin/ytdlp-setup" ${version}`);
      const result = spawnSync(shell, ["-c", command], {
        cwd: root,
        env: { HOME: home, PATH: "/nonexistent", ARGV_LOG: log, FIXTURE_EXIT: "23" },
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 23, result.stderr);
      assert.equal(fs.readFileSync(log, "utf8"), `1\n${version}\n`);
      assert.deepEqual(fs.readdirSync(root).sort(), [path.basename(home), "argv.log"].sort());
      assert.deepEqual(fs.readdirSync(home), [".local"]);
    }
  }
});

test("a nonexistent HOME launcher fails without executing a PATH substitute", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-missing-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "ytdlp-setup"), '#!/bin/sh\nprintf unsafe > "$HOME/unsafe"\n', { mode: 0o755 });
  const result = spawnSync("/bin/sh", ["-c", setupCommand(VERSION, "launcher")], {
    env: { HOME: root, PATH: root }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(root, "unsafe")), false);
});
