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
query = (name == "apt-cache" or (name == "pacman" and "-Si" in sys.argv)
         or (name == "dnf" and "list" in sys.argv) or (name == "zypper" and "search" in sys.argv))
if query:
    available = sys.argv[-1] in os.environ.get("FAKE_AVAILABLE_PACKAGES", "").split()
    if name == "zypper":
        entry = f'<solvable name="{sys.argv[-1]}"/>' if available else ""
        print(f"<stream><search-result><solvable-list>{entry}</solvable-list></search-result></stream>")
        sys.exit(0)
    if available:
        print("Package: " + sys.argv[-1])
        sys.exit(0)
    sys.exit(1)
with open(os.environ["ARGV_LOG"], "a") as stream:
    stream.write(json.dumps([name, *sys.argv[1:]]) + "\n")
if name == os.environ.get("FAKE_FAIL_TOOL"):
    sys.exit(23)
if name == "sudo":
    sys.exit(subprocess.call(sys.argv[1:]))
if name in ("pacman", "apt-get", "dnf", "zypper") and "update" not in sys.argv:
    for tool, target in json.loads(os.environ.get("FAKE_INSTALL_TOOLS", "{}")).items():
        path = pathlib.Path(os.environ["PATH"]) / tool
        path.unlink(missing_ok=True)
        path.symlink_to(target)
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
        self.launcher = self.home / ".local/bin/ytdlp-setup"
        self.release = self.root / "release"
        self.release.mkdir()
        bake_setup(self.release)
        for name in ("sudo", "pacman", "apt-get", "apt-cache", "dnf", "zypper", "curl", "uname", "deno",
                     "ffprobe", "zenity", "xdg-open", "xdg-user-dir"):
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
                                text=True, timeout=10, start_new_session=True, cwd=self.root)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def run_local(self, *args, **kwargs):
        return self.run_setup("--host-file", str(HOST), *args, **kwargs)

    def use_real_download(self, tool="curl"):
        if not shutil.which(tool):
            self.skipTest(f"{tool} is not installed")
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
        self.assertFalse(self.launcher.is_symlink())
        self.assertTrue(os.access(self.launcher, os.X_OK))
        self.assertEqual(self.launcher.read_text().splitlines()[:2],
                         ["#!/bin/sh", "# Managed by yt-dlp Downloader"])
        self.assertIn(' --setup "$@"', self.launcher.read_text())

    def test_launcher_executes_pinned_interpreter_isolated_with_safe_paths_and_arguments(self):
        # Both the interpreter and installed host path contain shell metacharacters.
        self.bin.rename(self.root / "Python's $(touch injected); tools")
        self.bin = self.root / "Python's $(touch injected); tools"
        self.home = self.root / "Home's $(touch injected); folder"
        self.home.mkdir()
        self.env.update(HOME=str(self.home), PATH=str(self.bin))
        launcher = self.home / ".local/bin/ytdlp-setup"
        recorded = self.root / "launcher-args.json"
        recorder = self.root / "recorder.py"
        recorder.write_text("import json, sys\nfrom pathlib import Path\n"
                            f"Path({str(recorded)!r}).write_text(json.dumps([sys.flags.isolated, sys.argv]))\n")
        self.run_setup("--host-file", str(recorder), "--no-deps")
        args = ["1.3.2", "--no-deps", "a b", "O'Brien", "$(touch injected)", "; exit 99", ""]
        # No python3 in PATH: the launcher uses the interpreter chosen at installation.
        result = subprocess.run([str(launcher), *args], env={**self.env, "PATH": "/nonexistent"},
                                cwd=self.root, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        isolated, argv = json.loads(recorded.read_text())
        self.assertEqual(isolated, 1)
        self.assertEqual(argv, [str(self.home / ".local/share/ytdlp-downloader/ytdlp_host.py"), "--setup", *args])
        self.assertFalse((self.root / "injected").exists())
        self.assertEqual(sorted(path.name for path in self.home.iterdir()), [".local", ".mozilla"])

    def test_unmanaged_collisions_refused_before_prerequisites_dependencies_or_host_writes(self):
        self.launcher.parent.mkdir(parents=True)
        target = self.root / "other-file"
        owned = "#!/bin/sh\n# Managed by yt-dlp Downloader\nexit 99\n"
        target.write_text(owned)
        target.chmod(0o755)
        (self.bin / "python3").unlink()
        self.os_release.write_text("ID=arch\n")
        for kind in ("file", "nul-header", "symlink", "dangling-symlink", "directory", "fifo"):
            with self.subTest(kind=kind):
                if kind == "file":
                    self.launcher.write_text("#!/bin/sh\n# Someone else's launcher\n")
                elif kind == "nul-header":
                    # Bash read drops NUL bytes; this must still not look managed.
                    self.launcher.write_bytes(b"#!/bin/sh\n# Managed by yt-dlp Down\x00loader\n")
                elif kind == "symlink":
                    self.launcher.symlink_to(target)
                elif kind == "dangling-symlink":
                    self.launcher.symlink_to(self.root / "missing")
                elif kind == "directory":
                    self.launcher.mkdir()
                else:
                    os.mkfifo(self.launcher)
                for flags in [("--yes",), ("--dry-run", "--yes")]:
                    result = self.run_local(*flags, expected=1)
                    self.assertIn("Refusing to overwrite unmanaged setup launcher", result.stderr)
                self.assertFalse(self.host.exists())
                self.assertFalse(self.manifest.parent.exists())
                self.assertEqual(self.calls(), [])
                self.assertEqual(target.read_text(), owned)
                if kind == "directory":
                    self.launcher.rmdir()
                else:
                    self.launcher.unlink()

    def test_owned_launcher_replaced_atomically_and_dry_run_preserves_it(self):
        self.run_local("--no-deps")
        self.launcher.write_text("#!/bin/sh\n# Managed by yt-dlp Downloader\nexit 99\n")
        self.launcher.chmod(0o644)
        before = self.launcher.read_bytes()
        inode = self.launcher.stat().st_ino
        result = self.run_local("--dry-run", "--no-deps")
        self.assertIn("Would install managed setup launcher", result.stdout)
        self.assertEqual(self.launcher.read_bytes(), before)
        self.assertEqual(self.launcher.stat().st_ino, inode)
        self.run_local("--no-deps")
        self.assert_installed()
        self.assertNotEqual(self.launcher.stat().st_ino, inode)
        self.assertEqual(list(self.launcher.parent.glob(".ytdlp-setup-*")), [])

    def test_python_free_uninstall_only_removes_owned_launcher(self):
        self.run_local("--no-deps")
        unrelated = self.launcher.parent / "keep.txt"
        unrelated.write_text("keep")
        (self.bin / "python3").unlink()
        result = self.run_setup("--uninstall", "--dry-run")
        self.assertIn("Would remove managed setup launcher", result.stdout)
        self.assertTrue(self.launcher.exists())
        self.launcher.chmod(0o644)
        self.run_setup("--uninstall")
        self.assertFalse(self.launcher.exists())
        self.assertEqual(unrelated.read_text(), "keep")
        self.assertFalse(self.host.exists())
        self.assertFalse(self.manifest.exists())

    def test_uninstall_preserves_unmanaged_launchers_and_symlink_targets_without_python(self):
        self.launcher.parent.mkdir(parents=True)
        (self.bin / "python3").unlink()
        target = self.root / "marked-target"
        target.write_text("#!/bin/sh\n# Managed by yt-dlp Downloader\nexit 0\n")
        for kind in ("file", "nul-header", "symlink", "dangling-symlink", "directory"):
            with self.subTest(kind=kind):
                if kind == "file":
                    self.launcher.write_text("unmanaged\n")
                elif kind == "nul-header":
                    self.launcher.write_bytes(b"#!/bin/sh\n# Managed by yt-dlp Down\x00loader\n")
                elif kind == "symlink":
                    self.launcher.symlink_to(target)
                elif kind == "dangling-symlink":
                    self.launcher.symlink_to(self.root / "missing")
                else:
                    self.launcher.mkdir()
                result = self.run_setup("--uninstall")
                self.assertIn("Preserving unmanaged setup launcher", result.stdout)
                self.assertTrue(os.path.lexists(self.launcher))
                self.assertTrue(target.exists())
                if kind == "directory":
                    self.launcher.rmdir()
                else:
                    self.launcher.unlink()

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

    def test_cli_loopback_setup_retains_dependency_consent_on_terminal(self):
        self.os_release.write_text("ID=arch\n")
        for answer, installs in ((b"n\n", False), (b"\n", True)):
            with self.subTest(answer=answer), release_server(self.release) as base:
                self.log.unlink(missing_ok=True)
                master, slave = pty.openpty()
                try:
                    os.write(master, answer)
                    result = subprocess.run([sys.executable, "-I", str(HOST), "--setup", "1.3.2"],
                                            env={**self.env, "YTDLP_SETUP_BASE_URL": base,
                                                 "YTDLP_SETUP_TTY": os.ttyname(slave)},
                                            stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                            cwd=self.root, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    commands = [call for call in self.calls() if call[0] == "pacman"]
                    self.assertEqual(bool(commands), installs)
                    self.assert_installed()
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
        self.assertIn("Would install managed setup launcher", result.stdout)
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
        self.assertFalse(self.launcher.exists())

    def test_missing_python_has_actionable_error(self):
        (self.bin / "python3").unlink()
        self.os_release.write_text("ID=arch\n")
        result = self.run_local("--no-deps", expected=1)
        self.assertIn("--no-deps forbids installing", result.stderr)
        self.assertIn("Run: sudo pacman -S --needed python", result.stdout)
        self.assertEqual(self.calls(), [])
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

    def test_only_the_shared_mozilla_folder_by_default(self):
        (self.home / ".librewolf").mkdir()
        self.run_local("--no-deps")
        self.assert_installed()
        self.assertFalse((self.home / ".librewolf/native-messaging-hosts").exists())

    def test_explicit_target_dir_replaces_the_default(self):
        target = self.root / "custom"
        self.run_local("--no-deps", "--target-dir", str(target))
        self.assert_installed(target / MANIFEST)
        self.assertFalse(self.manifest.exists())

    def test_sandboxed_browsers_are_reported(self):
        flatpak = self.bin / "flatpak"
        flatpak.write_text("#!/bin/sh\nprintf 'app.zen_browser.zen\\tZen\\norg.gnome.Calculator\\tCalculator\\n'\n")
        flatpak.chmod(0o755)
        snap = self.bin / "snap"
        snap.write_text("#!/bin/sh\nprintf 'Name Version Rev\\nfirefox 158.0 1\\ncore22 1 1\\n'\n")
        snap.chmod(0o755)
        result = self.run_local("--no-deps")
        self.assertIn("⚠ Sandboxed browser found: Zen (Flatpak)", result.stdout)
        self.assertIn("⚠ Sandboxed browser found: firefox (Snap)", result.stdout)
        self.assertNotIn("Calculator", result.stdout)
        proxy = self.bin / "xdg-native-messaging-proxy"
        if not any(Path(p).exists() for p in ("/usr/libexec/xdg-native-messaging-proxy",
                                               "/usr/lib/xdg-native-messaging-proxy")):
            self.assertIn("✗ xdg-native-messaging-proxy is not installed", result.stdout)
        proxy.write_text("#!/bin/sh\n")
        proxy.chmod(0o755)
        self.assertIn("✓ xdg-native-messaging-proxy is installed", self.run_local("--no-deps").stdout)
        self.assert_installed()

    def test_no_sandbox_warning_without_sandboxed_browsers(self):
        self.assertNotIn("Sandboxed", self.run_local("--no-deps").stdout)

    def test_python_bootstrap_per_distro_without_python_for_detection(self):
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        cases = [("arch", "pacman", "python"), ("ubuntu", "apt-get", "python3"),
                 ("fedora", "dnf", "python3"), ("opensuse-leap", "zypper", "python3"),
                 ("rocky", "dnf", "python3")]
        for distro, manager, package in cases:
            with self.subTest(distro=distro):
                (self.bin / "python3").unlink(missing_ok=True)
                self.log.unlink(missing_ok=True)
                self.os_release.write_text(f"ID={distro}\n")
                result = self.run_local("--yes", env={**self.env, "FAKE_INSTALL_TOOLS": json.dumps({"python3": sys.executable})})
                calls = [call for call in self.calls() if call[0] == manager]
                self.assertIn(package, calls[-1])
                self.assertEqual(len(calls), 2 if manager == "apt-get" else 1)
                self.assertIn("Python 3.8+ and setup prerequisites found", result.stdout)
                self.assert_installed()

    def test_missing_python_refusal_and_no_terminal_never_register(self):
        (self.bin / "python3").unlink()
        self.os_release.write_text("ID=arch\n")
        result = self.run_local(expected=1)
        self.assertIn("No terminal/answer", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(list(self.home.iterdir()), [])
        master, slave = pty.openpty()
        try:
            os.write(master, b"n\n")
            result = self.run_local(expected=1, env={**self.env, "YTDLP_SETUP_TTY": os.ttyname(slave)})
            self.assertIn("nothing was registered", result.stderr)
            self.assertEqual(self.calls(), [])
        finally:
            os.close(master)
            os.close(slave)

    def test_prerequisite_dry_run_needs_neither_python_nor_coreutils(self):
        for tool in ("python3", "mkdir", "mktemp", "install"):
            (self.bin / tool).unlink()
        self.os_release.write_text("ID=arch\n")
        result = self.run_local("--dry-run", "--yes")
        self.assertIn("sudo pacman -S --needed python coreutils", result.stdout)
        self.assertIn("Would write manifest", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertEqual(list(self.home.iterdir()), [])

    def test_prerequisites_rechecked_after_failed_or_ineffective_install(self):
        (self.bin / "python3").unlink()
        self.os_release.write_text("ID=arch\n")
        for overrides, error in [({}, "still missing or unsupported"), ({"FAKE_FAIL_TOOL": "pacman"}, "installation failed")]:
            with self.subTest(overrides=overrides):
                result = self.run_local("--yes", expected=1, env={**self.env, **overrides})
                self.assertIn(error, result.stderr)
                self.assertFalse(self.manifest.exists())
                self.assertEqual(list(self.home.iterdir()), [])

    def test_unsupported_or_broken_python_is_not_accepted(self):
        (self.bin / "python3").unlink()
        path = self.bin / "python3"
        self.os_release.write_text("ID=debian\n")
        for source in (f"#!{sys.executable}\nimport sys\nsys.version_info = (3, 7, 9)\nexec(sys.argv[2])\n",
                       "#!/bin/sh\nexit 1\n"):
            with self.subTest(source=source):
                path.write_text(source)
                path.chmod(0o755)
                result = self.run_local("--no-deps", expected=1)
                self.assertIn("Python must be 3.8+", result.stdout)
                self.assertFalse(self.manifest.exists())

    def test_missing_prerequisites_on_unknown_or_malicious_distro_are_manual(self):
        (self.bin / "python3").unlink()
        sentinel = self.home / "executed"
        for release in ("ID=unknown", f'ID="$(touch {sentinel})"\nID_LIKE="$(echo arch)"'):
            with self.subTest(release=release):
                self.os_release.write_text(release)
                result = self.run_local("--yes", expected=1)
                self.assertIn("Unknown distribution", result.stderr)
                self.assertEqual(self.calls(), [])
                self.assertEqual(list(self.home.iterdir()), [])

    def test_coreutils_bootstrap_only_when_missing(self):
        self.os_release.write_text("ID=arch\n")
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        (self.bin / "install").unlink()
        self.run_local("--yes", env={**self.env, "FAKE_INSTALL_TOOLS": json.dumps({"install": shutil.which("install")})})
        self.assertEqual(self.calls()[0], ["sudo", "pacman", "-S", "--needed", "coreutils", "--noconfirm"])
        self.assert_installed()

    def test_missing_sudo_or_package_manager_has_actionable_error(self):
        self.os_release.write_text("ID=arch\n")
        (self.bin / "python3").unlink()
        for tool in ("sudo", "pacman"):
            with self.subTest(tool=tool):
                (self.bin / tool).unlink()
                result = self.run_local("--yes", expected=1)
                self.assertIn("missing", result.stderr)
                self.assertIn("administrator", result.stderr)
                self.assertFalse(self.manifest.exists())
                self.fake(tool)

    def test_downloader_bootstrap_for_saved_release_script(self):
        self.os_release.write_text("ID=debian\n")
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        saved_curl = self.root / "saved-curl"
        saved_curl.write_bytes((self.bin / "curl").read_bytes())
        saved_curl.chmod(0o755)
        (self.bin / "curl").unlink()
        env = {**self.env, "FAKE_INSTALL_TOOLS": json.dumps({"curl": str(saved_curl)})}
        result = subprocess.run([str(self.bin / "bash"), str(self.release / "setup.sh"), "--yes"],
                                env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.calls()[2], ["sudo", "apt-get", "install", "-y", "curl"])
        self.assert_installed()

    def test_bootstrap_works_from_piped_script_without_swallowing_stdin(self):
        self.os_release.write_text("ID=arch\n")
        (self.bin / "python3").unlink()
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        received = self.root / "bootstrap-stdin"
        (self.bin / "pacman").write_text(
            f"#!{sys.executable}\nimport pathlib, sys\n"
            f"pathlib.Path({str(received)!r}).write_text(sys.stdin.read())\n"
            f"pathlib.Path({str(self.bin / 'python3')!r}).symlink_to({sys.executable!r})\n")
        result = subprocess.run([str(self.bin / "bash"), "-s", "--", "--yes", "--host-file", str(HOST)],
                                input=(NATIVE_HOST / "setup.sh").read_text(), env=self.env,
                                capture_output=True, text=True, timeout=10, start_new_session=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(received.read_text(), "")
        self.assert_installed()

    def test_runtime_download_offers_curl_if_both_downloaders_absent(self):
        self.os_release.write_text("ID=debian\n")
        self.fake("ffmpeg")
        (self.bin / "curl").unlink()
        result = self.run_local("--dry-run", "--yes")
        self.assertIn("Run: sudo apt-get install -y curl", result.stdout)
        self.assertIn("Download https://github.com/yt-dlp", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.manifest.exists())

    def test_saved_release_without_downloader_honors_no_deps(self):
        self.os_release.write_text("ID=debian\n")
        (self.bin / "curl").unlink()
        result = subprocess.run([str(self.bin / "bash"), str(self.release / "setup.sh"), "--no-deps"],
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn("--no-deps forbids installing", result.stderr)
        self.assertIn("install -y curl", result.stdout)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.manifest.exists())

    def test_python_bootstrap_root_needs_no_sudo(self):
        self.os_release.write_text("ID=arch\n")
        (self.bin / "sudo").unlink()
        (self.bin / "python3").unlink()
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        self.run_local("--yes", env={**self.env, "YTDLP_SETUP_TEST_EUID": "0",
                                     "FAKE_INSTALL_TOOLS": json.dumps({"python3": sys.executable})})
        self.assertEqual(self.calls(), [["pacman", "-S", "--needed", "python", "--noconfirm"]])
        self.assert_installed()

    def test_local_no_deps_needs_no_downloader(self):
        (self.bin / "curl").unlink()
        self.run_local("--no-deps")
        self.assertEqual(self.calls(), [])
        self.assert_installed()

    def test_optional_desktop_packages_per_distro(self):
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        for tool in ("zenity", "xdg-open", "xdg-user-dir"):
            (self.bin / tool).unlink()
        for distro, manager in [("arch", "pacman"), ("debian", "apt-get"), ("fedora", "dnf"),
                                ("opensuse-tumbleweed", "zypper"), ("rocky", "dnf")]:
            with self.subTest(distro=distro):
                self.os_release.write_text(f"ID={distro}\n")
                self.log.unlink(missing_ok=True)
                result = self.run_local("--yes")
                install = [call for call in self.calls() if call[0] == manager][-1]
                for package in ("zenity", "xdg-utils", "xdg-user-dirs"):
                    self.assertIn(package, install)
                self.assertIn("Optional folder picker", result.stdout)
                self.assert_installed()

    def test_optional_tools_refusal_failure_and_no_deps_are_nonfatal(self):
        self.os_release.write_text("ID=arch\n")
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        for tool in ("zenity", "xdg-open", "xdg-user-dir"):
            (self.bin / tool).unlink()
        self.run_local()
        self.assertEqual(self.calls(), [])
        self.assert_installed()
        self.run_local("--yes", "--no-deps")
        self.assertEqual(self.calls(), [])
        result = self.run_local("--yes", env={**self.env, "FAKE_FAIL_TOOL": "pacman"})
        self.assertIn("Dependency installation failed", result.stderr)
        self.assert_installed()

    def test_existing_alternative_picker_prevents_zenity_install(self):
        (self.bin / "zenity").unlink()
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        for tool in ("kdialog", "yad"):
            with self.subTest(tool=tool):
                self.fake(tool)
                self.run_local("--yes")
                self.assertEqual(self.calls(), [])
                (self.bin / tool).unlink()

    def test_missing_ffprobe_offers_ffmpeg_package(self):
        self.os_release.write_text("ID=arch\n")
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        (self.bin / "ffprobe").unlink()
        self.run_local("--yes")
        self.assertEqual(self.calls()[0], ["sudo", "pacman", "-S", "--needed", "ffmpeg", "--noconfirm"])

    def test_rhel_multimedia_only_from_enabled_repository_metadata(self):
        self.os_release.write_text('ID=rocky\nID_LIKE="rhel fedora"\n')
        self.fake("yt-dlp")
        for package in ("ffmpeg", "ffmpeg-free"):
            with self.subTest(package=package):
                self.log.unlink(missing_ok=True)
                self.run_local("--yes", env={**self.env, "FAKE_AVAILABLE_PACKAGES": package})
                self.assertEqual(self.calls()[0], ["sudo", "dnf", "install", "-y", package])
        self.log.unlink()
        result = self.run_local("--yes")
        self.assertIn("Enable EPEL/RPM Fusion yourself", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_proxy_only_for_sandboxed_browser_and_available_package(self):
        self.os_release.write_text("ID=debian\n")
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        env = {**self.env, "FAKE_AVAILABLE_PACKAGES": "xdg-native-messaging-proxy"}
        self.run_local("--yes", env=env)
        self.assertEqual(self.calls(), [])
        self.node_fake(self.bin / "flatpak", "org.mozilla.firefox Firefox")
        with_proxy = self.run_local("--yes", env=env)
        if "✗ xdg-native-messaging-proxy is not installed" not in with_proxy.stdout:
            self.skipTest("Host has a proxy at an absolute system path")
        self.assertIn("xdg-native-messaging-proxy", self.calls()[-1])
        self.log.unlink()
        self.run_local("--yes")
        self.assertEqual(self.calls(), [])
        self.run_local("--no-deps", "--yes", env=env)
        self.assertEqual(self.calls(), [])

    def test_proxy_repository_checks_across_package_managers(self):
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        self.node_fake(self.bin / "flatpak", "org.mozilla.firefox Firefox")
        for distro, manager in [("arch", "pacman"), ("debian", "apt-get"), ("fedora", "dnf"),
                                ("opensuse-tumbleweed", "zypper"), ("rocky", "dnf")]:
            with self.subTest(distro=distro):
                self.os_release.write_text(f"ID={distro}\n")
                self.log.unlink(missing_ok=True)
                result = self.run_local("--yes", env={**self.env, "FAKE_AVAILABLE_PACKAGES": "xdg-native-messaging-proxy"})
                if "✗ xdg-native-messaging-proxy is not installed" not in result.stdout:
                    self.skipTest("Host has a proxy at an absolute system path")
                install = [call for call in self.calls() if call[0] == manager][-1]
                self.assertIn("xdg-native-messaging-proxy", install)
                self.log.unlink()
                self.run_local("--yes")
                self.assertEqual(self.calls(), [], "No package available, even if zypper returns exit status 0")

    def test_satisfied_dependencies_on_unknown_distro_need_no_manual_install(self):
        self.fake("yt-dlp")
        self.fake("ffmpeg")
        result = self.run_local("--yes")
        self.assertNotIn("Install yt-dlp and ffmpeg", result.stdout)
        self.assertIn("desktop tools found", result.stdout)
        self.assertEqual(self.calls(), [])

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
