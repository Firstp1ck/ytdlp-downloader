"""install.sh / uninstall.sh end to end in an isolated HOME (stdlib only)."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

NATIVE_HOST = Path(__file__).resolve().parents[1]
PREF_LINE = 'user_pref("xpinstall.signatures.required", false);'


class InstallScriptTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="ytdlp-install-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        zen = self.home / ".zen"
        (zen / "a.Default").mkdir(parents=True)
        (zen / "b.Other").mkdir()
        (zen / "b.Other" / "user.js").write_text('user_pref("browser.startup.page", 3);\n')
        (zen / "profiles.ini").write_text(
            "[Profile0]\nName=A\nIsRelative=1\nPath=a.Default\n\n"
            "[Profile1]\nName=B\nIsRelative=1\nPath=b.Other\n\n[General]\nVersion=2\n")
        self.profiles = [zen / "a.Default", zen / "b.Other"]
        self.xpi = self.home / "out" / "ytdlp-downloader.xpi"
        # Fake pgrep and browser: tests must not depend on (or launch) a real Zen.
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.opened = self.home / "opened.txt"
        self.fake("pgrep", "exit 1")
        self.fake("fake-browser", f'printf "%s\\n" "$@" > "{self.opened}"')

    def fake(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\n" + body + "\n")
        path.chmod(0o755)

    def run_script(self, name, *args):
        env = {**os.environ, "HOME": str(self.home), "PATH": f"{self.bin}:{os.environ['PATH']}",
               "YTDLP_SETUP_TTY": "/dev/null"}
        if name == "install.sh":
            args = ("--xpi-out", str(self.xpi), "--browser", str(self.bin / "fake-browser"), *args)
        result = subprocess.run(["bash", str(NATIVE_HOST / name), *args], env=env,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def user_js(self, profile):
        path = profile / "user.js"
        return path.read_text() if path.exists() else None

    def test_install_without_flag_and_no_terminal_leaves_profiles_alone(self):
        self.run_script("install.sh")
        manifest = json.loads((self.home / ".mozilla/native-messaging-hosts/dev.firstpick.ytdlp_downloader.json").read_text())
        self.assertTrue(os.access(manifest["path"], os.X_OK))
        self.assertIsNone(self.user_js(self.profiles[0]))
        self.assertNotIn(PREF_LINE, self.user_js(self.profiles[1]))

    def test_allow_unsigned_is_idempotent_and_uninstall_restores_user_js(self):
        self.run_script("install.sh", "--allow-unsigned")
        out = self.run_script("install.sh", "--allow-unsigned")
        self.assertIn("Already allowed", out)
        for profile in self.profiles:
            self.assertEqual(self.user_js(profile).count(PREF_LINE), 1, profile)
        self.assertIn("browser.startup.page", self.user_js(self.profiles[1]))

        self.run_script("uninstall.sh")
        self.assertIsNone(self.user_js(self.profiles[0]), "a user.js we created is removed")
        self.assertEqual(self.user_js(self.profiles[1]), 'user_pref("browser.startup.page", 3);\n')
        self.assertFalse((self.home / ".local/share/ytdlp-downloader").exists())

    def test_user_written_pref_line_is_never_removed(self):
        (self.profiles[0] / "user.js").write_text(PREF_LINE + "\n")
        self.run_script("uninstall.sh")
        self.assertEqual(self.user_js(self.profiles[0]), PREF_LINE + "\n")

    def wait_opened(self):
        for _ in range(100):
            if self.opened.exists():
                return self.opened.read_text().strip()
            __import__("time").sleep(0.02)
        return None

    def test_install_always_builds_a_valid_xpi_without_tests(self):
        self.run_script("install.sh")
        with zipfile.ZipFile(self.xpi) as archive:
            names = archive.namelist()
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["browser_specific_settings"]["gecko"]["id"], "ytdlp-downloader@firstpick.dev")
        self.assertIn("background.js", names)
        self.assertFalse([n for n in names if n.startswith("tests/")])
        self.assertIsNone(self.wait_opened(), "not opened without --install-extension or a terminal")

    def test_install_extension_opens_the_xpi(self):
        self.run_script("install.sh", "--install-extension")
        self.assertEqual(self.wait_opened(), str(self.xpi))

    def test_running_zen_without_the_pref_active_is_not_handed_the_xpi(self):
        self.fake("pgrep", "exit 0")
        out = self.run_script("install.sh", "--allow-unsigned", "--install-extension")
        self.assertIn("Restart Zen", out)
        self.assertIsNone(self.wait_opened())

    def test_pref_already_active_in_prefs_js_opens_immediately(self):
        self.fake("pgrep", "exit 0")
        (self.profiles[0] / "prefs.js").write_text(PREF_LINE + "\n")
        self.run_script("install.sh", "--allow-unsigned", "--install-extension")
        self.assertEqual(self.wait_opened(), str(self.xpi))

    def test_dry_run_changes_nothing(self):
        out = self.run_script("install.sh", "--allow-unsigned", "--dry-run")
        self.assertIn("Would update", out)
        self.assertIsNone(self.user_js(self.profiles[0]))
        self.assertFalse((self.home / ".mozilla").exists())
        self.assertFalse(self.xpi.exists())


if __name__ == "__main__":
    unittest.main()
