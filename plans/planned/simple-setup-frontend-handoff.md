# Simple setup frontend handoff

Identity: **W2, bounded frontend implementation worker**, Codex gpt-6.1-sol/high. Run: **W2-frontend-2026-10-26-01**. Status: **implementation complete, terminal, ready for parent integration**. Final validation recorded at **2026-10-26T01:21:12Z**. This handoff covers only W2's frontend work; the integrated feature is not declared complete. No delegation occurred.

Repository: `/home/firstpick/Github/ytdlp-downloader` (physical checkout `/mnt/SSD_NVME_4TB/GitHub/ytdlp-downloader`), branch `main`. Base and current revision: **`3b5a5d32a85fb0dd864264c36d0d8f7d072da16a`**. All work remains uncommitted. The code-quality skill at `/home/firstpick/.pi/agent/skills/code-quality/SKILL.md`, the entire [canonical plan](simple-setup-command.md), and the entire [W1 native handoff](simple-setup-native-handoff.md) were read before coding. Relevant starting dirty hunks, callers, native safety tests and frontend tests were inspected.

## Actual changed files

- `extension/shared/setup-info.js`: minimum helper 1.3.0; strict release VERSION validation matching the native CLI; literal HOME-based launcher command; launcher capability validation and preference; thirteenth, setup-only checklist row; removal of inline Python generation, interpreter-path command state and shell-quoting helper.
- `extension/setup/setup.js`: actual short command display/copy, launcher/bootstrap explanations, explicit conditional guidance when downloaders cannot be checked, manual `bash ` prefix instructions and copy feedback.
- `extension/setup/setup.html`: `Download setup.sh` link before the command, with the manual download-first step before that link.
- `extension/tests/setup-info.test.js`: current/missing/old/unreachable/malformed launcher coverage, preference, future protocol minimum, 13 checks, strict version boundaries and removal of Python command state/source.
- `extension/tests/setup-page.test.js`: all 13 visible rows; warning/pending semantics; launcher display and exact clipboard contents; ignored host command text; old-helper bootstrap guidance; manual action order, trailing space, file drag and downloads-list/reveal-folder instructions; copy failure fallback; updated owned version fixtures.
- `extension/tests/setup-launcher-command.test.js`: new harmless launcher fixtures exercising the generated command through `/bin/sh` and `/bin/bash`, hostile-looking HOME names, exact version argv, exit 23 propagation and missing canonical launcher with a PATH substitute that must never execute.
- `extension/tests/setup-python-command.test.js`: removed the obsolete **untracked** prototype test after inspecting equivalent W1 safety coverage. W2 also reran that native safety coverage successfully; details below.
- `plans/planned/simple-setup-frontend-handoff.md`: this unique handoff.

`extension/setup/setup.css` needed no changes. No other files were written. Existing CHANGELOG/manifest/native work, canonical plan, W1 handoff, other consumers and fixtures were preserved. No commit, push, release, remote installer execution, real package installation, live helper/profile change or permission addition occurred. The native quoting test exercises only a throwaway fixture installation under temporary HOME/PATH.

## Implemented behavior and boundaries

`setupCommand(VERSION, "launcher")` returns exactly **`"$HOME/.local/bin/ytdlp-setup" VERSION`**, including the double quotes around the HOME-based executable. VERSION must have three ASCII numeric components, each 1–9 digits; no trimming, suffixes, prefixes, extra components, URL syntax, whitespace or trailing newline is accepted. Leading zeroes and the native maximum are accepted. All command methods and `setupScriptUrl` share this validation; permissive diagnostic version comparison remains unchanged.

Launcher selection requires an object with `found === true` and a bounded absolute path ending exactly in `/.local/bin/ytdlp-setup`, without controls, empty components or dot traversal. A root HOME is accepted. `found === false` requires `path === null` to be a confirmed warning; malformed/absent reports stay pending. Extra host properties cannot supply executable command text. The extension does no filesystem inspection or execution and never copies the reported path: ownership/executability remain the helper's responsibility.

Verified capability takes precedence over curl/wget, absent downloaders, incomplete Python diagnostics and a helper below a future protocol minimum. Required helper/tool rules still determine readiness. Missing or unknown launcher alone leaves downloads ready, surfaces assistance and continues polling; unknown reports trigger the existing guarded reconnect request. The background busy-port guard is untouched and passes its existing test in the full extension run. Hidden-tab polling, original 12 checks, repair advice, plain-text rendering and version badge are preserved.

Without verified capability, a known curl/wget report selects that bootstrap command. The existing unknown-downloader bootstrap state remains available for first installs, but the command label explicitly says **“If curl is installed”** and wget is offered only **“If wget is installed instead”**; it does not claim either tool or the launcher was found. The browser alternative is spelled out. Confirmed absence of both downloaders chooses the manual prefix, even when Python is reported usable; there is no Python execution branch.

The manual flow first downloads using `Download setup.sh`, then copies/types exactly **`bash `** (one trailing space), then drags the actual downloaded file into the terminal to insert its full path, then presses Enter. Browser downloads-list and reveal-folder alternatives find that file without guessing `~/Downloads`. Copy feedback explicitly identifies the prefix/trailing space. Clipboard rejection selects the same displayed command/prefix for Ctrl+C. No automatic download/execution or new browser permission is introduced. The installer still owns dependency confirmation.

## Validation commands and exit codes

Working directory for every check: `/home/firstpick/Github/ytdlp-downloader`. Node: **v22.23.4**. Commands below were run directly or as the exact argv of a Python `subprocess.run` reporting wrapper. The wrapper prints each child exit code separately; its own exit 0 does **not** mean the full extension suite passed.

```sh
node --test extension/tests/setup-info.test.js extension/tests/setup-page.test.js extension/tests/setup-launcher-command.test.js
# exit 0: 56 tests, 56 passed, 0 failed/skipped; final duration 102.80642 ms

node --test extension/tests
# exit 1: 165 tests, 160 passed, 5 failed, 0 skipped; final duration 340.792243 ms

node --check extension/shared/setup-info.js
# exit 0
node --check extension/setup/setup.js
# exit 0
node --check extension/tests/setup-info.test.js
# exit 0
node --check extension/tests/setup-page.test.js
# exit 0
node --check extension/tests/setup-launcher-command.test.js
# exit 0
git diff --check
# exit 0
```

The focused suite passed both before and after final inspection. Three full extension runs consistently failed only the five parent-owned consumer cases below; the last run follows the final source/test changes. All other extension tests, including the busy-port guard, pass.

Equivalent former Python-bootstrap safety was inspected in W1's `SetupCliTests` and launcher quoting test, then verified with this exact isolated invocation (**exit 0, 11 tests, 3.842 seconds, no skips**):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
from pathlib import Path
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path('native-host/tests').resolve()))
with tempfile.TemporaryDirectory(prefix='ytdlp-w2-native-safety-') as directory:
    root = Path(directory)
    home = root / 'home'
    home.mkdir()
    tool_bin = root / 'bin'
    tool_bin.mkdir()
    for name in ('bash', 'sh', 'python3', 'cat', 'mkdir', 'install', 'rm', 'rmdir', 'mktemp', 'uname', 'dirname'):
        target = shutil.which(name)
        if not target:
            raise RuntimeError('Missing validation tool: ' + name)
        (tool_bin / name).symlink_to(target)
    os.environ.clear()
    os.environ.update(HOME=str(home), PATH=str(tool_bin), LANG='C.UTF-8', LC_ALL='C.UTF-8', PYTHONDONTWRITEBYTECODE='1', YTDLP_SETUP_TTY='/dev/null')
    suite = unittest.defaultTestLoader.loadTestsFromNames([
        'test_ytdlp_host.SetupCliTests',
        'test_setup.SetupTests.test_launcher_executes_pinned_interpreter_isolated_with_safe_paths_and_arguments',
    ])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
PY
```

That covers bounded complete fetch, empty/oversized/open/read/HTTP failure paths without Bash, exact size, pinned HTTPS/timeout, invalid versions/flags, unsafe overrides/redirects, fake-Bash exit status, Ctrl-C and hostile-looking interpreter/HOME/argument paths. The native tests and installer source were not edited by W2.

## Integration follow-up, assumptions and omissions

Five failures are in **`extension/tests/setup-consumers.test.js`**, which is explicitly parent-owned and remains untouched:

1. `settings and popup do not warn for a healthy host with unknown proxy applicability` (line 95): READY still reports host 1.2.0 and no launcher; actual summary is `warn` rather than expected `ok`.
2. `old helper versions request an update in settings and popup` (line 106): assertion expects minimum 1.2.0; actual text correctly requires 1.3.0.
3. `settings and popup surface missing ffprobe instead of claiming full readiness` (line 115): old READY version causes the popup's helper-update explanation to take precedence.
4. `optional desktop tool warnings link both consumers to setup without blocking downloads` (line 126): old READY version causes helper-update guidance.
5. `incomplete current-helper diagnostics are not described as an older helper version` (line 137): READY 1.2.0 is now actually below the minimum.

Parent should update its healthy fixture to host 1.3.0 with a valid `setupLauncher` capability and adjust the old minimum assertion, then rerun full integration checks. This handoff does not assert that fixture changes alone prove all consumer behavior correct. Options/popup source and any other integration corrections remain parent-owned.

No unresolved W2 contract/security/ownership decision or intentional deviation is known. Diagnostic capability is trusted as a report from the native helper; frontend path-shape validation cannot independently prove file existence, ownership or agreement between native HOME and a separately opened terminal HOME. Parent owns real-browser desktop/mobile/layout/clipboard checks, integrated launcher-to-CLI fixtures, full native/shell/lint/build checks, packaging, release-asset verification, reviews and final documentation/report work. W2 did not repeat W1's full native suite or shellcheck because native source was unchanged; the focused native rerun specifically validates replacement safety coverage. Browser tests here use the existing VM/fake-DOM harness; no live browser/profile was used.

Release 1.3.2 remains unpublished, and no real release asset was fetched. The running user helper has not received this source change. Parent remains sole integration owner.
