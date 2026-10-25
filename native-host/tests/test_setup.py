"""Standalone release setup, dependency consent, and removal in isolated homes."""

from contextlib import contextmanager
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest

NATIVE_HOST = Path(__file__).resolve().parents[1]
HOST = NATIVE_HOST / "ytdlp_host.py"
MANIFEST = "dev.firstpick.ytdlp_downloader.json"


FAKE_TOOL = r'''import hashlib, io, json, os, pathlib, subprocess, sys, zipfile
name = pathlib.Path(sys.argv[0]).name
if name == "uname":
    print(os.environ.get("FAKE_ARCH", "x86_64"))
    sys.exit(0)
with open(os.environ["ARGV_LOG"], "a") as stream:
    stream.write(json.dumps([name, *sys.argv[1:]]) + "\n")
if name == os.environ.get("FAKE_FAIL_TOOL"):
    sys.exit(23)
if name == "sudo":
    sys.exit(subprocess.call(sys.argv[1:]))
if name == "curl":
    asset = sys.argv[-1].rsplit("/", 1)[-1]
    if os.environ.get("FAKE_DOWNLOAD_FAIL") == asset:
        sys.exit(22)
    binary = (f"#!{sys.executable}\nimport sys\nprint('fake-1.0')\nsys.exit({os.environ.get('FAKE_PROBE_FAIL', '0')})\n").encode()
    if asset == "ytdlp_host.py":
        data = pathlib.Path(os.environ["FAKE_HOST"]).read_bytes()
    elif asset.endswith(".zip") or asset.endswith(".zip.sha256sum"):
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, "w") as archive:
            archive.writestr(zipfile.ZipInfo("deno"), binary)
        data = zipped.getvalue()
    else:
        data = binary
    if asset == "SHA2-256SUMS" or asset.endswith(".sha256sum"):
        digest = hashlib.sha256(data).hexdigest()
        if os.environ.get("FAKE_BAD_SUM"):
            digest = "0" * 64
        names = ["yt-dlp_linux", "yt-dlp_linux_aarch64"] if asset == "SHA2-256SUMS" else [asset.removesuffix(".sha256sum")]
        if os.environ.get("FAKE_MISSING_SUM"):
            names = ["wrong-asset"]
        data = "".join(f"{digest}  {item}\n" for item in names).encode()
    pathlib.Path(sys.argv[sys.argv.index("--output") + 1]).write_bytes(data)
'''


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


@contextmanager
def release_server(directory):
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(directory)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def bake_setup(directory):
    source = (NATIVE_HOST / "setup.sh").read_text()
    digest = hashlib.sha256(HOST.read_bytes()).hexdigest()
    for key, value in (("RELEASE_VERSION", "1.3.0"), ("RELEASE_HOST_SHA256", digest)):
        placeholder = f'{key}=""'
        assert source.splitlines().count(placeholder) == 1
        source = source.replace(placeholder, f'{key}="{value}"', 1)
    (directory / "setup.sh").write_text(source)
    shutil.copyfile(HOST, directory / "ytdlp_host.py")


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ytdlp-setup-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # Deliberately exclude real yt-dlp, ffmpeg, sudo, and package managers.
        for tool in ("bash", "python3", "cat", "mkdir", "install", "rm", "rmdir", "mktemp"):
            (self.bin / tool).symlink_to(shutil.which(tool))
        self.log = self.root / "argv.jsonl"
        self.os_release = self.root / "os-release"
        self.os_release.write_text('ID="unknown"\n')
        self.env = {**os.environ, "HOME": str(self.home), "PATH": str(self.bin),
                    "YTDLP_SETUP_OS_RELEASE": str(self.os_release),
                    "YTDLP_SETUP_TTY": "/dev/null", "ARGV_LOG": str(self.log),
                    "YTDLP_SETUP_TEST_EUID": "1000", "FAKE_HOST": str(HOST)}
        self.env.pop("YTDLP_SETUP_BASE_URL", None)
        self.manifest = self.home / ".mozilla/native-messaging-hosts" / MANIFEST
        self.host = self.home / ".local/share/ytdlp-downloader/ytdlp_host.py"
        self.release = self.root / "release"
        self.release.mkdir()
        bake_setup(self.release)
        for name in ("sudo", "pacman", "apt-get", "dnf", "zypper", "curl", "uname", "deno"):
            self.fake(name)

    def fake(self, name):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + FAKE_TOOL)
        path.chmod(0o755)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def run_setup(self, *args, expected=0, env=None):
        result = subprocess.run([str(self.bin / "bash"), str(NATIVE_HOST / "setup.sh"), *args],
                                env=env or self.env, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=10, start_new_session=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def run_local(self, *args, **kwargs):
        return self.run_setup("--host-file", str(HOST), *args, **kwargs)

    def use_real_download(self, tool="curl"):
        (self.bin / "curl").unlink()
        (self.bin / tool).symlink_to(shutil.which(tool))

    def run_pipeline(self, base_url, *args, expected=0):
        command = f"curl -fsSL {shlex.quote(base_url + '/setup.sh')} | bash -s -- "
        command += shlex.join(args)
        env = {**self.env, "YTDLP_SETUP_BASE_URL": base_url}
        result = subprocess.run(["bash", "-o", "pipefail", "-c", command], env=env,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=10, start_new_session=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def assert_installed(self, manifest=None):
        data = json.loads((manifest or self.manifest).read_text())
        self.assertEqual(data, {
            "name": "dev.firstpick.ytdlp_downloader",
            "description": "Download videos and audio with yt-dlp from Firefox or Zen",
            "path": str(self.host), "type": "stdio",
            "allowed_extensions": ["ytdlp-downloader@firstpick.dev"],
        })
        self.assertTrue(os.access(self.host, os.X_OK))
        self.assertEqual(self.host.read_bytes(), HOST.read_bytes())

    def test_piped_release_installs_verified_host(self):
        self.use_real_download()
        with release_server(self.release) as base:
            result = self.run_pipeline(base, "--no-deps")
        self.assertIn("checksum verified", result.stdout)
        self.assert_installed()

    def test_tampered_host_rejected_without_installing(self):
        self.use_real_download()
        (self.release / "ytdlp_host.py").write_text("tampered\n")
        with release_server(self.release) as base:
            result = self.run_pipeline(base, "--no-deps", expected=1)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_unbaked_script_refuses_download_mode(self):
        result = self.run_setup("--no-deps", expected=1)
        self.assertIn("no release host checksum", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(list(self.home.iterdir()), [])

    def test_wget_fallback(self):
        self.use_real_download("wget")
        with release_server(self.release) as base:
            result = subprocess.run(["bash", str(self.release / "setup.sh"), "--no-deps"],
                                    env={**self.env, "YTDLP_SETUP_BASE_URL": base},
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_installed()

    def test_piped_package_manager_never_reads_the_script(self):
        # Under `curl … | bash` stdin is the script; a package manager reading it
        # would swallow the rest of setup.sh and nothing would get registered.
        self.os_release.write_text("ID=arch\n")
        swallowed = self.root / "pacman-stdin"
        (self.bin / "pacman").write_text(f"#!{sys.executable}\nimport sys, pathlib\n"
                                         f"pathlib.Path({str(swallowed)!r}).write_text(sys.stdin.read())\n")
        command = f"cat {shlex.quote(str(NATIVE_HOST / 'setup.sh'))} | bash -s -- --yes --host-file {shlex.quote(str(HOST))}"
        result = subprocess.run(["bash", "-o", "pipefail", "-c", command], env=self.env,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=10, start_new_session=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(swallowed.read_text(), "", "pacman must not receive the piped script")
        self.assertIn("Done!", result.stdout)
        self.assert_installed()

    def test_dependency_commands_per_distro_and_like(self):
        ytdlp_urls = ["https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
                      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS"]
        pacman = ["pacman", "-S", "--needed", "yt-dlp", "ffmpeg"]
        dnf = ["dnf", "install", "-y", "yt-dlp", "ffmpeg-free"]
        zypper = ["zypper", "install", "-y", "yt-dlp", "ffmpeg"]
        apt_update, apt_install = ["apt-get", "update"], ["apt-get", "install", "-y", "ffmpeg"]
        # (os-release, privileged commands in order, standalone yt-dlp downloaded?)
        cases = [
            ('ID=arch', [pacman], False),
            ('ID=derivative\nID_LIKE="arch linux"', [pacman], False),
            ('ID=fedora\nID_LIKE=debian', [dnf], False),
            ('ID=nobara\nID_LIKE=fedora', [dnf], False),
            ('ID=opensuse-tumbleweed', [zypper], False),
            ('ID=derivative\nID_LIKE="suse"', [zypper], False),
            # apt-get update first: a clean Debian 13 container had no package lists.
            ('ID=debian', [apt_update, apt_install], True),
            ('ID=ubuntu\nID_LIKE=debian', [apt_update, apt_install], True),
            # RHEL rebuilds: no yt-dlp/ffmpeg in their repos, so no dnf call at all.
            ('ID=rocky\nID_LIKE="rhel centos fedora"', [], True),
            ('ID=almalinux\nID_LIKE="rhel centos fedora"', [], True),
            ('ID=centos\nID_LIKE="rhel fedora"', [], True),
        ]
        for release, commands, standalone in cases:
            with self.subTest(release=release):
                self.log.unlink(missing_ok=True)
                shutil.rmtree(self.home / ".local", ignore_errors=True)
                self.os_release.write_text(release + "\n")
                result = self.run_local("--yes")
                calls = self.calls()
                expected = []
                for command in commands:
                    # pacman gets --noconfirm only when run after consent; the shown command stays interactive.
                    executed = command + (["--noconfirm"] if command[0] == "pacman" else [])
                    expected += [["sudo", *executed], executed]
                    self.assertIn("Run: " + " ".join(["sudo", *command]) + "\n", result.stdout)
                self.assertEqual(calls[:len(expected)], expected)
                downloads = [call[-1] for call in calls[len(expected):]]
                self.assertEqual(downloads, ytdlp_urls if standalone else [])
                if standalone:
                    self.assertTrue(os.access(self.home / ".local/bin/yt-dlp", os.X_OK))
                if "rhel" in release:
                    self.assertIn("RPM Fusion", result.stdout)

    def test_no_controlling_tty_never_installs_or_hangs(self):
        self.os_release.write_text("ID=arch\n")
        env = dict(self.env)
        env.pop("YTDLP_SETUP_TTY")
        result = self.run_local(env=env)
        self.assertIn("No terminal/answer", result.stderr)
        self.assertIn("sudo pacman -S --needed yt-dlp ffmpeg", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assert_installed()

    def test_tty_consent_accepts_default_and_honors_no(self):
        self.os_release.write_text("ID=arch\n")
        for answer, installs in ((b"n\n", False), (b"\n", True)):
            with self.subTest(answer=answer):
                self.log.unlink(missing_ok=True)
                master, slave = pty.openpty()
                try:
                    os.write(master, answer)
                    self.run_local(env={**self.env, "YTDLP_SETUP_TTY": os.ttyname(slave)})
                    self.assertEqual(bool(self.calls()), installs)
                finally:
                    os.close(master)
                    os.close(slave)

    def test_unknown_distro_is_manual_even_with_yes(self):
        result = self.run_local("--yes")
        self.assertIn("Unknown distribution", result.stdout)
        self.assertIn("Install yt-dlp and ffmpeg", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assert_installed()

    def test_os_release_is_data_never_shell_code(self):
        sentinel = self.home / "executed"
        self.os_release.write_text(f'ID=unknown\nID_LIKE="$(touch {sentinel})"\n')
        self.run_local("--yes")
        self.assertFalse(sentinel.exists())

    def test_dependencies_already_found_including_local_bin(self):
        local_bin = self.home / ".local/bin"
        local_bin.mkdir(parents=True)
        (local_bin / "yt-dlp").write_text("#!/bin/sh\nexit 0\n")
        (local_bin / "yt-dlp").chmod(0o755)
        self.fake("ffmpeg")
        result = self.run_local("--yes")
        self.assertIn("yt-dlp and ffmpeg found", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_debian_installs_only_missing_part(self):
        self.os_release.write_text("ID=debian\n")
        self.fake("yt-dlp")
        self.run_local("--yes")
        self.assertEqual(self.calls(), [["sudo", "apt-get", "update"], ["apt-get", "update"],
                                        ["sudo", "apt-get", "install", "-y", "ffmpeg"],
                                        ["apt-get", "install", "-y", "ffmpeg"]])
        (self.bin / "yt-dlp").unlink()
        self.fake("ffmpeg")
        self.log.unlink()
        self.run_local("--yes")
        self.assertEqual([c[0] for c in self.calls()], ["curl", "curl"])

    def test_no_deps_skips_every_dependency_command(self):
        self.os_release.write_text("ID=arch\n")
        self.run_local("--no-deps", "--yes")
        self.assertEqual(self.calls(), [])

    def test_dry_run_changes_nothing_including_dependencies_and_downloads(self):
        self.use_real_download()
        self.os_release.write_text("ID=arch\n")
        with release_server(self.release) as base:
            result = self.run_pipeline(base, "--yes", "--dry-run")
        self.assertIn("Would download and verify", result.stdout)
        self.assertIn("Would write manifest", result.stdout)
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual(self.calls(), [])

    def test_repeatable_targets_and_uninstall_preserve_unrelated_files(self):
        targets = [self.home / 'custom "one"', self.home / "custom two"]
        args = [part for target in targets for part in ("--target-dir", str(target))]
        self.run_local("--no-deps", *args)
        for target in targets:
            self.assert_installed(target / MANIFEST)
        self.assertFalse(self.manifest.exists())
        keep = self.host.parent / "keep.txt"
        keep.write_text("keep")
        result = self.run_setup("--uninstall", "--dry-run", *args)
        self.assertIn("Would remove", result.stdout)
        self.assertTrue(self.host.exists())
        self.run_setup("--uninstall", *args)
        self.assertFalse(self.host.exists())
        self.assertTrue(keep.exists())
        for target in targets:
            self.assertFalse((target / MANIFEST).exists())

    def test_uninstall_default_removes_empty_host_dir(self):
        self.run_local("--no-deps")
        self.run_setup("--uninstall")
        self.assertFalse(self.manifest.exists())
        self.assertFalse(self.host.parent.exists())

    def test_missing_python_has_actionable_error(self):
        (self.bin / "python3").unlink()
        result = self.run_local("--no-deps", expected=1)
        self.assertIn("Python 3 is required", result.stderr)
        self.assertIn("Install python3", result.stderr)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_every_truncation_of_baked_tail_never_writes_home(self):
        source = (self.release / "setup.sh").read_bytes()
        # Exercise every byte boundary, including inside the final invocation.
        for cut in range(len(source) - 256, len(source) + 1):
            with self.subTest(bytes_missing=len(source) - cut):
                result = subprocess.run(
                    [str(self.bin / "bash"), "-s", "--", "--dry-run", "--no-deps",
                     "--host-file", str(HOST)], input=source[:cut], env=self.env,
                    capture_output=True, timeout=10, start_new_session=True)
                self.assertEqual(list(self.home.rglob("*")), [], result.stdout + result.stderr)
                if cut == len(source):
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(b"Would write manifest", result.stdout)

    def test_failed_sudo_or_package_manager_still_registers(self):
        self.os_release.write_text("ID=arch\n")
        for tool in ("sudo", "pacman"):
            with self.subTest(tool=tool):
                result = self.run_local("--yes", env={**self.env, "FAKE_FAIL_TOOL": tool})
                self.assertIn("Dependency installation failed: sudo pacman", result.stderr)
                self.assertIn("the helper is installed anyway, the setup page shows what's missing", result.stderr)
                self.assert_installed()

    def test_root_omits_sudo(self):
        self.os_release.write_text("ID=arch\n")
        result = self.run_local("--yes", env={**self.env, "YTDLP_SETUP_TEST_EUID": "0"})
        self.assertEqual(self.calls(), [["pacman", "-S", "--needed", "yt-dlp", "ffmpeg", "--noconfirm"]])
        self.assertIn("Run: pacman -S --needed yt-dlp ffmpeg\n", result.stdout)
        self.assert_installed()

    def test_posix_bash_and_sh_without_tty_register(self):
        self.os_release.write_text("ID=arch\n")
        env = dict(self.env)
        env.pop("YTDLP_SETUP_TTY")
        # start_new_session is Python's setsid; also exercise the actual setsid utility.
        for shell in ([shutil.which("bash"), "--posix"], [shutil.which("sh")]):
            with self.subTest(shell=shell):
                result = subprocess.run(
                    [shutil.which("setsid"), *shell, str(NATIVE_HOST / "setup.sh"), "--host-file", str(HOST)],
                    env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("No terminal/answer", result.stderr)
                self.assertEqual(self.calls(), [])
                self.assert_installed()
        result = subprocess.run(
            [shutil.which("setsid"), str(self.bin / "bash"), "--posix", "-s", "--", "--host-file", str(HOST)],
            input=(NATIVE_HOST / "setup.sh").read_text(), env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("No terminal/answer", result.stderr)
        self.assert_installed()

    def test_uninstall_without_python(self):
        self.run_local("--no-deps")
        (self.bin / "python3").unlink()
        self.run_setup("--uninstall")
        self.assertFalse(self.host.exists())
        self.assertFalse(self.manifest.exists())

    def test_standalone_assets_and_deno_on_both_architectures(self):
        (self.bin / "deno").unlink()
        self.os_release.write_text("ID=debian\n")
        for arch, ytdlp_asset in (("x86_64", "yt-dlp_linux"), ("aarch64", "yt-dlp_linux_aarch64")):
            with self.subTest(arch=arch):
                self.log.unlink(missing_ok=True)
                shutil.rmtree(self.home / ".local", ignore_errors=True)
                result = self.run_local("--yes", env={**self.env, "FAKE_ARCH": arch})
                assets = [c[-1].rsplit("/", 1)[-1] for c in self.calls() if c[0] == "curl"]
                deno_asset = f"deno-{arch}-unknown-linux-gnu.zip"
                self.assertEqual(assets, [ytdlp_asset, "SHA2-256SUMS", deno_asset, deno_asset + ".sha256sum"])
                self.assertIn("SHA-256 before installing", result.stdout)
                self.assertIn("SHA-256 before extracting", result.stdout)
                self.assertIn("Python zipfile", result.stdout)
                self.assertNotIn("Dependency installation failed", result.stderr)
                for binary in ("yt-dlp", "deno"):
                    path = self.home / ".local/bin" / binary
                    self.assertTrue(os.access(path, os.X_OK))
                    self.assertIn("fake-1.0", subprocess.check_output([str(path), "--version"], text=True))
                self.assert_installed()

    def test_bad_missing_checksums_and_failed_download_never_install_binary(self):
        self.os_release.write_text("ID=debian\n")
        self.fake("ffmpeg")
        for overrides in ({"FAKE_BAD_SUM": "1"}, {"FAKE_MISSING_SUM": "1"},
                          {"FAKE_DOWNLOAD_FAIL": "yt-dlp_linux"}, {"FAKE_DOWNLOAD_FAIL": "SHA2-256SUMS"}):
            with self.subTest(overrides=overrides):
                result = self.run_local("--yes", env={**self.env, **overrides})
                self.assertIn("Dependency installation failed: yt-dlp", result.stderr)
                self.assertFalse((self.home / ".local/bin/yt-dlp").exists())
                self.assert_installed()

    def test_version_probe_failure_warns_and_registers(self):
        self.os_release.write_text("ID=debian\n")
        (self.bin / "deno").unlink()
        result = self.run_local("--yes", env={**self.env, "FAKE_PROBE_FAIL": "7"})
        self.assertIn("Dependency installation failed: yt-dlp", result.stderr)
        self.assertIn("Dependency installation failed: Deno", result.stderr)
        self.assertIn("--version probe", result.stderr)
        self.assert_installed()

    def test_deno_bad_checksum_or_download_failure_does_not_extract(self):
        (self.bin / "deno").unlink()
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        asset = "deno-x86_64-unknown-linux-gnu.zip"
        for overrides in ({"FAKE_BAD_SUM": "1"}, {"FAKE_MISSING_SUM": "1"},
                          {"FAKE_DOWNLOAD_FAIL": asset}, {"FAKE_DOWNLOAD_FAIL": asset + ".sha256sum"}):
            with self.subTest(overrides=overrides):
                result = self.run_local("--yes", env={**self.env, **overrides})
                self.assertIn("Dependency installation failed: Deno", result.stderr)
                self.assertFalse((self.home / ".local/bin/deno").exists())
                self.assert_installed()

    def test_unsupported_architecture_prints_manual_instructions(self):
        self.os_release.write_text("ID=debian\n")
        self.fake("ffmpeg")
        (self.bin / "deno").unlink()
        result = self.run_local("--yes", env={**self.env, "FAKE_ARCH": "riscv64"})
        self.assertIn("No automatic standalone builds for riscv64", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assert_installed()

    def test_arch_deno_plan_is_consented_and_interactive(self):
        (self.bin / "deno").unlink()
        self.os_release.write_text("ID=arch\n")
        result = self.run_local()
        self.assertIn("Run: sudo pacman -S --needed yt-dlp ffmpeg deno\n", result.stdout)
        self.assertNotIn("--noconfirm", result.stdout)
        self.assertEqual(self.calls(), [])
        self.run_local("--yes")
        self.assertEqual(self.calls()[0], ["sudo", "pacman", "-S", "--needed", "yt-dlp", "ffmpeg", "deno", "--noconfirm"])

    def node_fake(self, path, version):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!/bin/sh\necho {version}\n")
        path.chmod(0o755)

    def test_runtime_discovery_avoids_deno_install(self):
        (self.bin / "deno").unlink()
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        found = [(self.home / ".deno/bin/deno", "v2.9.8"), (self.bin / "node", "v22.1.0"),
                 (self.home / ".local/bin/node", "v24.0.0"), (self.home / ".volta/bin/node", "v22.0.0"),
                 (self.home / ".nvm/versions/node/v23.1.0/bin/node", "v23.1.0")]
        for path, version in found:
            with self.subTest(path=str(path)):
                self.node_fake(path, version)
                result = self.run_local("--yes")
                self.assertIn("JavaScript runtime found", result.stdout)
                self.assertEqual(self.calls(), [])
                path.unlink()

    def test_old_node_and_bun_do_not_count_as_runtime(self):
        (self.bin / "deno").unlink()
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        self.os_release.write_text("ID=arch\n")
        self.node_fake(self.bin / "node", "v20.19.0")
        self.node_fake(self.home / ".local/bin/bun", "1.3.14")
        result = self.run_local("--yes")
        self.assertIn("JavaScript runtime is missing (Deno, or Node 22 or newer)", result.stdout)
        self.assertEqual(self.calls()[0], ["sudo", "pacman", "-S", "--needed", "deno", "--noconfirm"])

    def test_missing_option_values_and_unknown_flags(self):
        for flag in ("--host-file", "--target-dir", "--unknown"):
            with self.subTest(flag=flag):
                self.run_setup(flag, expected=2)


class ReleaseWorkflowTests(unittest.TestCase):
    def test_bake_accepts_only_three_numeric_version_parts(self):
        workflow = (NATIVE_HOST.parent / ".github/workflows/release.yml").read_text()
        code = textwrap.dedent(workflow.split("python3 - <<'PY'\n", 1)[1].split("          PY\n", 1)[0])
        with tempfile.TemporaryDirectory(prefix="ytdlp-bake-") as directory:
            root = Path(directory)
            (root / "native-host").mkdir()
            (root / "dist").mkdir()
            for name in ("setup.sh", "ytdlp_host.py"):
                shutil.copyfile(NATIVE_HOST / name, root / "native-host" / name)
            for version in ("1.3.0", "0.0.0", "123.45.678", "1", "1.3", "1.3.0.1", "1.3.x", "v1.3.0", "1.3.0\n"):
                with self.subTest(version=version):
                    result = subprocess.run([sys.executable, "-c", code], cwd=root,
                                            env={**os.environ, "VERSION": version}, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0 if version in ("1.3.0", "0.0.0", "123.45.678") else 1,
                                     result.stdout + result.stderr)
                    if result.returncode == 0:
                        self.assertIn(f'RELEASE_VERSION="{version}"', (root / "dist/setup.sh").read_text())

    def test_tag_check_still_rejects_mismatched_tag(self):
        workflow = (NATIVE_HOST.parent / ".github/workflows/release.yml").read_text()
        check = textwrap.dedent(workflow.split("      - name: Check tag matches manifest version\n        run: |\n", 1)[1].split("      - name: Tests", 1)[0])
        version = json.loads((NATIVE_HOST.parent / "extension/manifest.json").read_text())["version"]
        with tempfile.TemporaryDirectory(prefix="ytdlp-tag-") as directory:
            for tag, expected in ((f"v{version}", 0), ("v0.0.0", 1), (f"v{version}.1", 1)):
                with self.subTest(tag=tag):
                    result = subprocess.run(["bash", "-e", "-c", check], cwd=NATIVE_HOST.parent,
                                            env={**os.environ, "GITHUB_REF_NAME": tag,
                                                 "GITHUB_ENV": str(Path(directory) / "env")},
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
