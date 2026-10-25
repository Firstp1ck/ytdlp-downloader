# Development

How to work on ytdlp-downloader. For what the parts do and how they talk to each other, read
[TECHNICAL.md](TECHNICAL.md) first.

## Layout

```
extension/
  manifest.json            MV2 manifest (id ytdlp-downloader@firstpick.dev)
  background.js            menus, native port, download list, badge, notifications
  shared/settings.js       defaults, allowed values, validation (the only copy)
  shared/youtube.js        YouTube URL classification and context-menu URL resolution
  shared/downloads.js      download entry state transitions
  shared/theme.css         colours and light/dark tokens
  content/player-menu.js   adds rows to YouTube's own player menu (content script)
  options/                 settings page
  popup/                   toolbar popup
  icons/icon.svg
  tests/                   node:test suites (index.js loads all *.test.js)
native-host/
  ytdlp_host.py            the native messaging host
  install.sh, uninstall.sh
  unsigned_pref.py         adds/removes the marked user.js line (install.sh --allow-unsigned)
  build_xpi.py             packages extension/ into dist/ytdlp-downloader.xpi
  tests/test_ytdlp_host.py stdlib unittest suite for the host
  tests/test_install_scripts.py  install/uninstall end to end in a throwaway HOME
reports/                   build report (HTML)
```

There's no build step and there are no dependencies. Node is only used to run the extension tests.

## Tests

```sh
python3 -m unittest discover -s native-host/tests -v
node --test extension/tests
```

- The host suite covers framing, validation, argv mapping for every option combination, progress
  parsing, file publishing, and real subprocess runs over pipes. Those runs use a fake yt-dlp
  (selected with `YTDLP_HOST_YTDLP`) to test queueing, cancel, SIGTERM-resistant children, and EOF
  cleanup.
- The extension suite runs the real background scripts in a `vm` context against a fake `browser`
  API, and checks settings, URL handling, download state, and manifest/page hygiene (no inline
  scripts, no `innerHTML`).

Optional extra checks:

```sh
shellcheck native-host/*.sh
for f in $(git ls-files 'extension/*.js'); do node --check "$f"; done
npx web-ext lint --source-dir extension     # needs a one-time npm download
```

## Running it locally

1. Install from your working copy: `./native-host/install.sh`. It copies `ytdlp_host.py` and
   rebuilds the `.xpi`, so run it again after host changes. For quick extension iterations, the
   temporary add-on below reloads faster.
2. Load `extension/manifest.json` from `about:debugging#/runtime/this-firefox` and press **Reload**
   there after extension changes.
3. Logs:
   - Background page: **Inspect** next to the add-on in `about:debugging`.
   - Host stderr: Browser Console (Ctrl+Shift+J).

To test the host without a browser, start it and write framed JSON to its stdin:

```python
import json, struct, subprocess
p = subprocess.Popen(["native-host/ytdlp_host.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
msg = json.dumps({"type": "ping"}).encode()
p.stdin.write(struct.pack("=I", len(msg)) + msg); p.stdin.flush()
size = struct.unpack("=I", p.stdout.read(4))[0]
print(json.loads(p.stdout.read(size)))
p.stdin.close(); p.wait()
```

To install into a scratch location instead of your real profile:

```sh
HOME=$(mktemp -d) ./native-host/install.sh --target-dir "$(mktemp -d)"
```

## Changing things

- **A new setting or option value**: add it to `CHOICES`/`DEFAULTS` in `extension/shared/settings.js`
  and to `ENUMS`/`DEFAULT_OPTIONS` plus `build_argv` in `native-host/ytdlp_host.py`, then update the
  protocol section of TECHNICAL.md. A test checks that the extension's values match the protocol, so
  if you update only one side the suites fail.
- **Protocol messages**: change both sides in the same commit and bump `HOST_VERSION` when the change
  isn't backwards compatible. The options page shows the host version.
- **YouTube's player menu**: `content/player-menu.js` depends on YouTube markup
  (`.ytp-contextmenu .ytp-panel-menu`, `.ytp-menuitem*`, inline heights). If the rows stop
  appearing, inspect the menu on a watch page and update the selectors and the notes at the top of
  that file. Don't test it in an unmuted automated tab; YouTube autoplays.
- **yt-dlp output parsing**: the templates are in `PROGRESS_TEMPLATE` and `FILE_TEMPLATE`. Check
  changes against real yt-dlp output, not only the fake. Absent fields must default to `null`.

## Packaging

`install.sh` builds the package on every run. To build it on its own:

```sh
python3 native-host/build_xpi.py extension dist/ytdlp-downloader.xpi
```

The builder leaves out `tests/`, adds files in sorted order with a fixed timestamp (same sources,
same archive), and writes atomically. `dist/` is git-ignored.

The `.xpi` installs unsigned in Zen, Firefox Developer Edition/Nightly, and LibreWolf when
`xpinstall.signatures.required` is `false` (`install.sh --allow-unsigned` sets it via `user.js`).
Firefox release needs it signed through AMO (unlisted is fine): `npx web-ext sign --channel unlisted`
with AMO API credentials.
