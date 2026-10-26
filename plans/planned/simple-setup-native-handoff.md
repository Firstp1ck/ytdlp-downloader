# Simple setup native handoff

Workstream: **W1 native/installer implementation**. Run: **W1-native-2026-10-26-01**, terminal evidence recorded at 2026-10-26T01:11:09Z. Status: **implementation complete, terminal, ready for parent inspection**. This is a bounded implementation outcome; it does not declare the integrated feature complete. No delegation occurred.

Canonical plan read in full: [simple-setup-command.md](simple-setup-command.md). The code-quality skill at `/home/firstpick/.pi/agent/skills/code-quality/SKILL.md` was read before permanent writes and applied throughout. Existing installer, native dispatch, release baking and relevant tests were inspected against the plan.

Repository: `/home/firstpick/Github/ytdlp-downloader` (physical checkout `/mnt/SSD_NVME_4TB/GitHub/ytdlp-downloader`). Branch: `main`. Base and current revision are both `3b5a5d32a85fb0dd864264c36d0d8f7d072da16a`. All W1 changes remain uncommitted. The initial dirty CHANGELOG, manifest, four prototype frontend files, untracked prototype test and existing plans were preserved.

## Actual write set

- `native-host/ytdlp_host.py`: HostVersion 1.3.0; CLI dispatch only for exact first argument `--setup`; bounded release fetch/run; canonical managed-launcher detection; additional `pong.setupLauncher` field.
- `native-host/setup.sh`: early launcher ownership refusal; safe generated launcher using the selected Python with `-I`; atomic replacement; dry-run reporting; owned-launcher removal without Python.
- `native-host/tests/test_ytdlp_host.py`: CLI/download/error/signal/redirect safeguards, launcher inspection and real framing compatibility tests; existing version expectations updated to 1.3.0.
- `native-host/tests/test_setup.py`: launcher lifecycle/ownership/quoting tests and CLI-to-loopback-installer terminal consent coverage; existing install assertions now require the launcher.
- `plans/planned/simple-setup-native-handoff.md`: this handoff.

`native-host/tests/test_install_scripts.py` required no changes; its eight tests pass unchanged. No frontend, manifest, documentation, other plan, report, release asset, installed helper or live browser profile was written. No commit, push, publication, service restart or real package installation was performed.

## Implemented contract

`python -I ytdlp_host.py --setup VERSION [--no-deps] [--dry-run]` accepts exactly three ASCII numeric components, **1–9 digits per component** (maximum 29 characters total). Leading zeroes remain numeric and are accepted. Other flags, including `--yes`, and invalid versions fail before download/execution. Ordinary Firefox manifest/add-on arguments, later `--setup` arguments and `--setup=...` retain native framing. Both `setup` and `--setup` native-message types remain rejected with `bad_request`.

Normal URL: `https://github.com/Firstp1ck/ytdlp-downloader/releases/download/vVERSION/setup.sh`. The standard verified HTTPS handler/context is retained; redirects may not downgrade HTTPS. Socket timeout is 30 seconds. Fetch reads at most 1 MiB + 1 sentinel byte, requires nonempty data no larger than 1 MiB, checks declared Content-Length for completeness, handles incomplete chunked responses, and closes the response before starting Bash. Expected network, HTTP, timeout, invalid response and missing-executable errors are friendly nonzero failures without tracebacks. HTTP error and rejected redirect responses are closed.

Bash argv is `bash -s --` plus explicit `--no-deps` when supplied. It receives the complete script on stdin, inherits the session/process group/stdout/stderr, and retains the installer's terminal dependency confirmation. Normal child exit status is returned unchanged; signal exits use the conventional 128 + signal status. Ctrl-C returns 130 with `Setup cancelled.` and stops the immediate Bash child. Dry-run validates and reports without building an opener, fetching, starting a child or changing the filesystem.

For CLI tests, `YTDLP_SETUP_BASE_URL` replaces the **release directory**, so `http://127.0.0.1:PORT/release` fetches `/release/setup.sh`; no extra version component is appended. The override requires HTTP, a literal loopback IP and an explicit port 1–65535. DNS names (including `localhost`), credentials, whitespace/control characters, query strings/fragments, non-loopback hosts and other schemes are rejected. IPv4 loopback and IPv6 `::1` are accepted; fixture redirects must satisfy the same rule. Ambient proxies are disabled only for fixture fetches. The inherited override remains available to the existing installer fixture mechanism to obtain the checksum-matched host from that release directory.

The installer checks `$HOME/.local/bin/ytdlp-setup` before prerequisite/dependency installation, downloading or registration. Unmanaged regular files, directories, FIFOs, live symlinks (including links to marked files) and dangling symlinks are preserved and cause refusal. Owned regular files can be replaced even if their executable bit was lost. The generated file starts exactly with:

```sh
#!/bin/sh
# Managed by yt-dlp Downloader
```

Its exec line safely quotes `sys.executable` from the selected installation Python and the installed host path, uses `-I`, passes `--setup`, then quoted `"$@"`. It needs no runtime PATH lookup of Python. Generation occurs after host acquisition/checksum verification and host installation; there is no extra release asset or checksum placeholder. A same-directory temporary file with mode 0755 is atomically replaced into place. No profile or PATH edits are added. Python-free `setup.sh --uninstall` removes only regular non-symlink files with the owned two-line header, including non-executable owned files, and preserves unrelated files and symlink targets. Dry-run leaves the launcher bytes and inode unchanged.

`pong.setupLauncher` is `{found: true, path: "<HOME>/.local/bin/ytdlp-setup"}` only for the canonical executable regular non-symlink file with the exact managed header; otherwise it is `{found: false, path: null}`. Detection uses a bounded read with `O_NOFOLLOW`/`O_NONBLOCK` and an fd regular-file check. It never searches PATH for an alternative or executes a probe. All existing pong fields remain present.

## Validation commands and results

Working directory for every command below: `/home/firstpick/Github/ytdlp-downloader`. Runtime: Python **3.14.8**, ShellCheck **0.11.0**. The final validation invocation below exited **0**. It ran the complete suite with an isolated temporary HOME, a restricted PATH containing only the listed tools, bytecode writes disabled and no live package manager/sudo/browser in that PATH. Individual suites further use temporary HOME/PATH, fake package/download tools, harmless recorders and HTTP loopback servers.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix='ytdlp-w1-validation-') as directory:
    root = Path(directory)
    home = root / 'home'
    home.mkdir()
    tool_bin = root / 'bin'
    tool_bin.mkdir()
    for name in ('bash', 'sh', 'python3', 'cat', 'mkdir', 'install', 'rm', 'rmdir', 'mktemp', 'uname', 'dirname', 'setsid', 'curl', 'wget', 'shellcheck', 'git'):
        target = shutil.which(name)
        if not target:
            raise RuntimeError('Missing validation tool: ' + name)
        (tool_bin / name).symlink_to(target)
    env = {'HOME': str(home), 'PATH': str(tool_bin), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
           'PYTHONDONTWRITEBYTECODE': '1', 'YTDLP_SETUP_TTY': '/dev/null'}
    commands = [[sys.executable, '-m', 'unittest', 'discover', '-s', 'native-host/tests', '-v'],
                ['shellcheck', *map(str, sorted(Path('native-host').glob('*.sh')))],
                *[['bash', '-n', str(path)] for path in sorted(Path('native-host').glob('*.sh'))],
                ['git', 'diff', '--check']]
    for command in commands:
        result = subprocess.run(command, env=env, check=False)
        print('CHECK', repr(command), 'EXIT', result.returncode, flush=True)
        if result.returncode:
            sys.exit(result.returncode)
    for path in sorted(Path('native-host').rglob('*.py')):
        compile(path.read_bytes(), str(path), 'exec')
        print('COMPILE', path, 'EXIT 0', flush=True)
    print('ALL W1 FINAL CHECKS PASSED', flush=True)
PY
```

Observed individual results:

- `/usr/bin/python3 -m unittest discover -s native-host/tests -v`: **exit 0**, **135 tests**, **22.509 seconds**, no skipped tests. Breakdown: host 62, setup/release 65, install/uninstall wrappers 8.
- `shellcheck native-host/install.sh native-host/setup.sh native-host/uninstall.sh`: **exit 0**.
- `bash -n native-host/install.sh`: **exit 0**.
- `bash -n native-host/setup.sh`: **exit 0**.
- `bash -n native-host/uninstall.sh`: **exit 0**.
- `git diff --check`: **exit 0**.
- In-memory `compile(path.read_bytes(), str(path), 'exec')` for all six native Python files (host, build_xpi, unsigned_pref, and three test modules): **exit 0** for each. No `.pyc` generation.

Additional focused commands were run during implementation, both with exit **0**: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s native-host/tests -p 'test_ytdlp_host.py' -v` (latest focused run 62 tests) and the equivalent `-p 'test_setup.py'` command (latest focused run 65 tests). The final full run above follows the last source/test changes and supersedes the focused evidence.

Coverage includes valid/invalid bounded versions and flags; no opener/child/filesystem change on CLI dry-run; default pinned HTTPS and 30-second timeout arguments; exact 1 MiB acceptance; empty/oversized/HTTP/network/open-timeout/read-timeout/truncated/chunk failures with no Bash; response closure before child launch; unsafe overrides and redirects; real loopback/fake-Bash exit 23; inherited session/group/stdout/stderr; real SIGINT yielding 130 and stopping the child; managed capability present/missing/malformed/non-executable/directory/FIFO/symlink; framed Firefox startup and rejected setup RPCs; safe interpreter/HOME/argument quoting under `/bin/sh` with `-I`; ownership collisions before side effects; atomic update and dry-run preservation; Python-free owned/unowned/symlink uninstall; existing checksum/dependency/prerequisite and checkout-wrapper lifecycle tests.

## Assumptions, omissions and integration notes

There are no known unresolved W1 blockers or deviations requiring an ownership/interface/security decision outside the approved plan. The 1–9 digit component bound and explicit literal-IP/port fixture convention are concrete choices within the plan's bounded-version and explicit-loopback requirements. Ownership follows the exact two-line marker convention; it is not a cryptographic ownership claim. Like existing installer operations, updates assume no hostile concurrent writer to the user's own installation directories; the launcher is rechecked before replacement but the complete installation is not a filesystem transaction.

The new no-follow launcher inspection is for the project's Linux host environment. Python 3.8 runtime execution and IPv6 network binding were not available/necessary for this run: supported-version reporting and IPv6 URL validation are covered, but execution used Python 3.14.8 and real HTTP fixtures bound IPv4 loopback. Open/read timeouts are injected; tests do not wait 30 seconds. Default TLS behavior is preserved and inspected through the actual opener construction rather than contacting a real release. Real distro/package installation, real remote installers, release availability, live-profile behavior and installed-user-helper changes were intentionally omitted. Source checkout release placeholders remain unbaked as before.

W2 may remove the superseded `extension/tests/setup-python-command.test.js` prototype after parent inspection. Equivalent bounded download, empty/size/timeout/failure and exit-status coverage now lives in `SetupCliTests`; path/argument shell-quoting coverage lives in `test_launcher_executes_pinned_interpreter_isolated_with_safe_paths_and_arguments`. W2 should consume only `pong.setupLauncher.found === true` with a valid capability shape, generate the literal safe HOME launcher command itself, and preserve its planned fallback states. Missing launchers report `path: null`; no raw command string is sent by the host.

Parent retains extension version/minimum-helper metadata, frontend behavior, docs, integrated launcher-to-CLI/browser verification, artifacts, independent reviews and final completion/report ownership. The existing frontend still contains the rejected prototype at this handoff; no integrated frontend or overall-feature claim is made. The running user's helper has **not** received this source fix. Native helper version 1.3.0 is available only in this dirty checkout until a later authorized install/release.
