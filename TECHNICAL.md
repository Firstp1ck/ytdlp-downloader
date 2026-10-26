# Technical notes

How ytdlp-downloader works, what crosses the boundary between the browser and the local machine,
and why it is built this way. Usage is in [README.md](README.md); working on the code is in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Architecture

```
 YouTube tab ── right-click ──► background.js ──── native port (stdio, JSON) ────► ytdlp_host.py
                                 │  ▲                                              │  ▲
               storage.local ◄───┘  │ runtime messages                    argv     ▼  │ stdout/stderr
              (settings)            ▼                                          yt-dlp (+ ffmpeg)
                          options page · popup                                     │
                                                                   <saveDir>/.ytdlp-downloader-staging/<job>/
                                                                                   │ move, no overwrite
                                                                                   ▼
                                                                               <saveDir>/
```

- **Extension** (`extension/`, Manifest V2, plain ES2022, no build step)
  - `background.js`: context menus, the one native port, the in-memory download list, toolbar
    badge, notifications, and request/reply handling for the options page and popup.
  - `shared/settings.js`: the single source for defaults, allowed values, validation, and
    `toDownloadOptions(settings, mode)`. "Download Video" and "Download Audio" each have their own
    keys (`video*` and `audio*`, including save folder and playlist); only `notifications` is shared.
    Settings saved by 1.0 (one `saveDir`/`playlist`, plus a `mode` default action) are carried over to
    both actions when loaded. The options page builds its controls from this module.
  - `shared/youtube.js`: classifies YouTube URLs (watch, youtu.be, Shorts, live, playlist, embeds,
    `m.`, `music.`) and rebuilds a clean URL from the validated video/list ids.
  - `shared/downloads.js`: pure state transitions for download entries driven by host events.
  - `content/player-menu.js`: content script on `www.youtube.com` and `youtube-nocookie.com/embed`
    that adds **Download Video**/**Download Audio** rows to YouTube's own player menu
    (`.ytp-contextmenu`), which the menus API can't reach. It inserts the rows in a capture-phase
    `contextmenu` listener, before YouTube measures the menu. On the very first right-click
    YouTube builds the popup (appended to `<body>`) and measures it during the event; a one-shot
    `MutationObserver` then adds the rows and grows the inline heights before the next paint. A
    click sends `{type: "downloadFromPage", action, url: location.href}`; synthetic clicks
    (`!event.isTrusted`) are ignored. If YouTube changes its markup, the rows just don't appear.
  - `options/`, `popup/`: UI pages. All network-derived text goes through `textContent`.
- **Native host** (`native-host/ytdlp_host.py`, Python 3.8+, stdlib only): validates requests, maps
  options to a yt-dlp argv, runs up to two jobs at once with a FIFO queue, streams progress, and
  publishes finished files.

## Setup flow

```
install extension ──► runtime.onInstalled(reason "install") ──► setup/setup.html
                                                                   │ ping every 2.5 s while visible
user pastes:  curl -fsSL …/releases/download/v<version>/setup.sh | bash
                 │                                                 │
                 ├─ Python 3.8+ / setup utilities missing → ask → distro package manager
                 ├─ download / desktop tools missing → distro plan → ask (/dev/tty) → package manager
                 ├─ download ytdlp_host.py from the same release, check baked SHA-256
                 └─ install host + write native-messaging manifest ──► next ping: pong ──► "Ready"
```

- **One source per concern.** `extension/shared/setup-info.js` builds the command from the
  extension's own manifest version and derives the page state from a ping result
  (`deriveSetupState`). `native-host/setup.sh` owns host registration, removal, and dependency
  handling; `install.sh`/`uninstall.sh` (checkout use) delegate to it and add the `.xpi` and
  unsigned-pref extras.
- **Pinned and verified.** The release workflow bakes `RELEASE_VERSION` and `RELEASE_HOST_SHA256`
  into the published `setup.sh`. The script downloads the helper from that same release only and
  refuses to install it on a checksum mismatch. An unbaked `setup.sh` (from the repo) only works
  with `--host-file`, never by fetching a moving branch.
- **Safe to pipe.** Everything runs from `{ main "$@"; }` on the last line, so a download cut off
  anywhere executes nothing (a cut inside the braces is a syntax error; a bare `main` would have run
  without its flags). Tests cut the script at every byte of its last 256. Prompts read `/dev/tty` because stdin is the script itself;
  package managers get the terminal (or `/dev/null`) as stdin, and pacman gets `--noconfirm` only
  after the user agreed. Without a terminal and without `--yes`, no dependency is installed.
  The helper is still registered if its required bootstrap prerequisites are already available.
- **Distros and tools.** Detected from `ID`/`ID_LIKE` in `/etc/os-release` (parsed as data, not
  sourced), using a restricted Bash parser so detection works before Python is installed. Python
  must execute successfully and report 3.8 or newer; missing or unsupported Python, coreutils,
  and a downloader needed for remote helper installation get a separate consented bootstrap plan.
  Those prerequisites are rechecked after installation and stop setup if still unusable.
  `--no-deps` never installs them; `--dry-run` can show plans without Python; uninstall needs no Python.
  One package-plan/execution path serves both setup phases. Missing sudo or the distro package
  manager gets administrator guidance, never an attempt to grant privileges. Arch family:
  `pacman -S --needed yt-dlp ffmpeg deno`. Fedora: `dnf install yt-dlp ffmpeg-free`. openSUSE: `zypper install yt-dlp ffmpeg`. RHEL/Rocky/Alma (`ID_LIKE` lists `rhel`
  before `fedora`): standalone yt-dlp and instructions for ffmpeg (EPEL + RPM Fusion), because
  their base repositories have neither. If cached metadata from enabled repositories already lists
  ffmpeg or ffmpeg-free, setup offers that package instead; it never enables repositories.
  Debian/Ubuntu: `apt-get update`, then `apt-get install ffmpeg`
  plus yt-dlp's standalone `yt-dlp_linux`/`yt-dlp_linux_aarch64` in `~/.local/bin` (no Python
  needed; apt's yt-dlp lags behind YouTube). Outside Arch, Deno is the official
  `deno-<arch>-unknown-linux-gnu.zip`, extracted with Python's `zipfile` to `~/.local/bin`. Only
  missing tools and unsupported Python are offered for installation. Supported existing tools
  are kept. The ffmpeg check
  includes ffprobe. Optional offers cover zenity only when no zenity/kdialog/yad exists, xdg-utils
  for xdg-open, and xdg-user-dirs for configured Downloads-folder detection. The sandbox proxy is
  offered only for a detected sandboxed browser and a package found in existing repository metadata.
  Downloads come from each project's `releases/latest`, are checked against that release's published SHA-256 list
  (integrity, not a signature), and are test-run (`--version`). Failures warn and continue: the
  helper is registered regardless once bootstrap prerequisites are satisfied. As root, package
  managers run without `sudo`. Standalone downloads support x86_64 and aarch64 only; other
  architectures get manual instructions.
- **JavaScript runtime.** yt-dlp runs JavaScript downloaded from YouTube to solve its challenges.
  The helper uses **Deno** first (yt-dlp's default and recommendation: its sandbox blocks file and
  network access), then **Node 22 or newer** (yt-dlp's minimum; partly sandboxed). It searches
  `PATH`, `~/.local/bin`, `~/.deno/bin`, `~/.volta/bin` and nvm's newest version, because the
  browser may start the helper with a short `PATH`, passes the result explicitly as
  `--js-runtimes <name>:<path>`, and reports it as `pong.jsRuntime`. **Bun is not used**: yt-dlp
  deprecated it and it runs the script with full file and network access. Setup installs Deno only
  when neither runtime is present. A missing runtime is a warning on the setup page, not a blocker.
  **Deno's development ends around October 2027** (announced 2026-10-09 after Cloudflare's
  acquisition; monthly security releases until then). yt-dlp hasn't picked a successor yet
  ([yt-dlp#17799](https://github.com/yt-dlp/yt-dlp/issues/17799)). When it does, change the order
  in `find_js_runtime()` (helper) and `has_js_runtime()`/the Deno install step (`setup.sh`).
- **Helper version.** `MIN_HOST_VERSION` in `setup-info.js`; an older `pong.hostVersion` makes the
  setup page ask for an update with the same command. `ping` with `reconnect: true` drops an idle
  port first, so an updated helper is picked up without a browser restart. Version 1.2.0 adds the
  extended dependency report, and this extension requires it. The setup page always renders twelve
  checks, leaves unreported values pending, and distinguishes required failures from recommended,
  optional and installer-only warnings. Warnings and actionable unknowns keep installation guidance
  and visible-tab polling active; a fully healthy page stops polling. Unsupported-Python repair
  also requests a guarded idle reconnection so the new interpreter is used. When xdg-user-dir
  availability changes, the host refreshes its default directory with a one-second lookup; existing
  jobs retain their selected paths and future default-directory downloads use the refreshed value.

## Unreleased short setup command

Extension 1.3.2 requires helper 1.3.0. The installer generates the marked executable
`$HOME/.local/bin/ytdlp-setup`, which invokes the installed helper's explicit `--setup VERSION`
CLI in isolated Python. The setup page prefers the fixed HOME-based short command only when the
helper reports a verified owned launcher. It never copies a command string supplied by the host.
A thirteenth setup-only row covers the launcher; missing/unknown capability remains warning/pending
and falls back to curl/wget or an explicit download-and-drag `bash ` prefix.

Setup CLI validates three numeric version components before I/O, fetches only the fixed matching
HTTPS release script with verified TLS, a 30-second socket timeout and a 1 MiB limit, rejects empty
or incomplete bodies, then passes the bytes to Bash while preserving terminal confirmation and
child failure status. `--dry-run` performs no fetch or execution; only `--no-deps` is otherwise
forwarded. The existing `YTDLP_SETUP_BASE_URL` test override is limited in the CLI to literal HTTP
loopback IPs with explicit ports. No native-message operation runs setup. Firefox's ordinary
manifest-path/add-on-ID startup arguments retain the framed protocol.

The installer refuses unmanaged files and symlinks at the launcher location, atomically replaces
owned launchers, and removes only the owned marker on Python-free uninstall. No extra release
asset, checksum placeholder, shell-profile edit or browser permission is introduced. Installed
version 1.3.1 does not have this CLI; local tests must use the updated checkout helper or fixtures.

## Design decisions

| Decision | Why |
|---|---|
| WebExtension + native messaging, not a Zen mod or userChrome.js | Mods are CSS only. userChrome.js loaders are unsupported and break on browser updates. Native messaging is the supported way to run a local program. |
| Manifest V2 with a persistent background page | Firefox keeps supporting MV2. A persistent page keeps the native port and progress tracking alive for the whole download; MV3 event pages can be suspended. |
| Long-lived `runtime.connectNative` port | `sendNativeMessage` stops the host after the first reply, which would kill yt-dlp. |
| Python host, stdlib only | Setup offers Python 3.8+ when missing. The host has no pip dependencies. |
| No "extra yt-dlp arguments" setting; `--ignore-config` | Only enumerated values reach the command line, and a user config can't add `--exec` hooks or break the output templates the host parses. |
| Per-job staging directory | Two jobs with the same title would share `.part` files, and `-x` deletes its source after extraction, which could be a finished video with the same name. Staging isolates each job; the host then moves files into place without overwriting. |
| Manifest in `~/.mozilla/native-messaging-hosts` | Firefox and Zen both read it there; Zen's `libxul.so` only knows the `.mozilla` directory. |

IDs: extension `ytdlp-downloader@firstpick.dev`, native host `dev.firstpick.ytdlp_downloader`.

## Native messaging protocol

Framing is the standard WebExtension one: a uint32 length in native byte order, then UTF-8 JSON, on
stdin/stdout. The host writes nothing else to stdout; logs go to stderr (the Browser Console shows
them). Inbound frames are capped at 1 MiB. A malformed frame gets a `bad_request` and the host
closes, because the next frame boundary can't be trusted.

### Extension pages → background page

Only the extension's own pages (`moz-extension://…`) may send these; web pages and the YouTube
content script may only send `downloadFromPage`.

```jsonc
{"type": "getState"}                       // download list + host status (popup)
{"type": "ping", "reconnect": true}        // host pong; reconnect drops an idle port first, so an
                                           // updated helper is used without a browser restart
                                           // (never while downloads or dialogs are active)
{"type": "pickDirectory", "start": "~/Videos"}
{"type": "cancel", "id": "<uuid>"}
{"type": "openFolder", "id": "<uuid>"}
{"type": "clearInactive"}
{"type": "openSetup"}                      // opens setup/setup.html
// from the YouTube content script only:
{"type": "downloadFromPage", "action": "video" | "audio", "url": "<page URL>"}
```

### Extension → host

```jsonc
{"type": "ping"}
{"type": "download", "id": "<uuid>", "url": "https://www.youtube.com/watch?v=...", "options": {
  "mode": "video" | "audio",
  "videoResolution": "best" | "2160" | "1440" | "1080" | "720" | "480" | "360",
  "videoFormat": "any" | "mp4" | "webm" | "mkv",
  "audioQuality": "best" | "320" | "256" | "192" | "128" | "96",     // kbps; "best" = VBR 0
  "audioFormat": "best" | "mp3" | "m4a" | "opus" | "flac" | "wav",  // "best" = keep the source codec
  "saveDir": "",          // the clicked action's save folder; "" = host default; "~" expanded
  "playlist": false       // the clicked action's setting, sent as true only for URLs with a list id
}}
{"type": "cancel", "id": "<uuid>"}
{"type": "pickDirectory", "requestId": "<uuid>", "start": "~/Videos"}
{"type": "openPath", "path": "/abs/folder"}                              // folders only
```

Missing option keys get host defaults; unknown keys and invalid values are rejected, never repaired.

### Host → extension

```jsonc
{"type": "pong", "hostVersion": "1.3.0",
 "ytDlp": {"found": true, "path": "/usr/bin/yt-dlp", "version": "2026.10.21"},  // version null = doesn't run
 "ffmpeg": {"found": true, "path": "/usr/bin/ffmpeg"},
 "setupLauncher": {"found": true, "path": "/home/u/.local/bin/ytdlp-setup"},  // since 1.3.0
 "python": {"found": true, "path": "/usr/bin/python3", "version": "3.12.0", "supported": true},
 "ffprobe": {"found": true, "path": "/usr/bin/ffprobe"},
 "downloader": {"found": true, "name": "curl", "path": "/usr/bin/curl"},
 "coreutils": {"found": true, "missing": []},
 "opener": {"found": true, "path": "/usr/bin/xdg-open"},
 "userDirs": {"found": true, "path": "/usr/bin/xdg-user-dir"},
 "nativeMessagingProxy": {"found": false, "path": null, "applicable": null},
 "jsRuntime": {"name": "deno" | "node", "path": "/usr/bin/deno"} | null,   // since 1.1.0
 "defaultSaveDir": "/home/u/Downloads", "picker": "zenity" | "kdialog" | "yad" | null}
{"type": "queued",    "id": "..."}                          // both slots busy
{"type": "started",   "id": "...", "saveDir": "/abs"}
{"type": "progress",  "id": "...", "status": "downloading" | "processing",
 "percent": 42.1 | null, "speed": "3.2MiB/s" | null, "eta": "00:12" | null,
 "title": "..." | null, "playlistIndex": 3 | null, "playlistCount": 10 | null}
{"type": "finished",  "id": "...", "files": ["/abs/file.mp4"], "fileCount": 1}
{"type": "cancelled", "id": "..."}
{"type": "error",     "id": "..." | null, "code": "<code>", "message": "...", "requestId": "..."}
{"type": "directory", "requestId": "...", "path": "/abs" | null}       // null = dialog cancelled
```

- `setupLauncher` is added in helper 1.3.0. Found requires the canonical executable regular non-symlink
  file with the exact two-line managed header; detection is a bounded no-follow read, not execution.
- Other extended dependency fields are reported since helper 1.2.0. Python describes the running interpreter.
  Coreutils covers cat, mkdir, install, rm, rmdir, mktemp and uname. A downloader may be curl or wget.
  Proxy applicability is true only with explicit sandbox environment markers; otherwise it is null,
  not a claim that no proxy is needed. These status fields use executable discovery; an XDG
  availability change also refreshes the cached directory. No package-manager probes are added.
- `finished.files` lists at most 100 paths; `fileCount` is the real total. Firefox drops host
  messages over 1 MB, and a long playlist's paths could exceed that.
- `error.requestId` is present when the error answers a `pickDirectory`.
- Error codes: `bad_request`, `ytdlp_missing`, `ffmpeg_missing`, `invalid_url`, `invalid_path`,
  `ytdlp_failed` (message = yt-dlp's `ERROR` lines, or its last stderr lines), `unknown_id`,
  `no_picker`, `internal`.
- `cancel` on a job whose process already exited answers `unknown_id`; its `finished` is on the way.

### Host lifecycle

- Two download slots; extra jobs are `queued` and start in order.
- Each yt-dlp runs in its own session (`start_new_session=True`). Cancel sends SIGTERM to the
  process group (yt-dlp and ffmpeg), then SIGKILL after one second.
- On stdin EOF (the browser closed the port) the host kills every job and dialog, drops the queue,
  and exits 0.
- stdout writes share one lock. `ping` runs on a worker thread so a slow `yt-dlp --version` doesn't
  hold up a `cancel`.
- yt-dlp lookup: `YTDLP_HOST_YTDLP` (tests), then `PATH`, then `~/.local/bin/yt-dlp` (the browser may
  start with a short `PATH`).
- Default save dir: `xdg-user-dir DOWNLOAD`, falling back to `~/Downloads`.

## yt-dlp command

Every job:

```
yt-dlp --ignore-config --newline --progress --color never --no-simulate
       -P <saveDir>/.ytdlp-downloader-staging/<random>
       -o "%(title)s [%(id)s].%(ext)s"                      # playlist: "%(playlist_title)s/%(playlist_index)03d - …"
       --progress-template "download:__YTDLP_PROGRESS__{…}"
       --progress-template "postprocess:__YTDLP_PROGRESS__{…}"
       --print "after_move:__YTDLP_FILE__%(filepath)j"
       --yes-playlist | --no-playlist
       [--js-runtimes deno:/usr/bin/deno]                   # Deno, else Node 22+, if found
       <mode args> -- <url>
```

The progress template is JSON built with yt-dlp's `j` conversion, so titles with quotes, newlines,
or Unicode survive intact. Absent fields need explicit `|null` defaults; without them yt-dlp prints a
bare `NA`. Download progress arrives on stdout and postprocessor progress on stderr, so the host
parses both.

| Option | Arguments |
|---|---|
| video | `-f "bv*+ba/b"` |
| resolution H | `-S res:H` (best at or below H; the smallest above if nothing qualifies) |
| video format mp4 / webm | adds `ext:mp4:m4a` / `ext:webm:webm` to `-S`, `--merge-output-format mp4` / `webm` |
| video format mkv | `--merge-output-format mkv` |
| audio | `-f "ba/b" -x` |
| audio format F | `--audio-format F` (omitted for Original) |
| audio quality | `--audio-quality 0` for Best, else `--audio-quality NK` |

`--audio-quality` only applies when yt-dlp converts. If the source codec already matches, yt-dlp
copies the stream. Every job needs ffmpeg: video merges streams, and `-x` probes with ffprobe even
when it only copies. The host checks for both ffmpeg and ffprobe before it starts a job.

After yt-dlp exits 0, the host moves each reported file from staging into `saveDir`, keeping the
playlist subfolder. If the target exists it picks `name (2).ext`, `name (3).ext`, and so on. The
staging directory is deleted whatever the outcome.

## Security

Trust boundary: only the extension listed in the host manifest's `allowed_extensions` can start the
host. Web pages can't talk to it. Inside that boundary:

- **URLs**: the extension rebuilds the URL from validated YouTube id characters. The host accepts only
  `http`/`https` URLs with a host and passes them after `--`, so they can never be read as options.
- **argv**: built as a list, never through a shell. Every option is checked against an enum, and
  `--ignore-config` shuts out ambient config.
- **Paths**: `saveDir` must be absolute after `~` expansion and can't contain control characters.
  `openPath` only opens existing directories, because `xdg-open` on a `.desktop` file may run it.
- **DOM**: titles and URLs come from the network and are only written with `textContent`. A test
  rejects `innerHTML`, inline scripts, and inline handlers in the extension.
- **Setup script**: see [Setup flow](#setup-flow): pinned release URL, SHA-256-verified helper,
  consent before any `sudo`, guard against truncated downloads. Standalone yt-dlp and Deno come
  from those projects' `releases/latest` (not pinned, by design: yt-dlp has to keep up with
  YouTube) and are checked against their published SHA-256 lists.
- **Permissions**: `menus`, `nativeMessaging`, `storage`, `notifications`, plus the content script
  on YouTube player pages (shown at install as access to youtube.com). No other host access.
- **Messages from web pages**: content scripts share the extension id, so the background page
  checks `sender.url`. Only the extension's own pages (`moz-extension://…`) get the full message
  set; anything else may only send `downloadFromPage`, whose URL goes through the same
  `classifyYouTubeUrl` check as a menu click. A compromised YouTube page could at most start a
  download of a YouTube video.

## Known limits

- Linux only. Flatpak/Snap browsers can only start the helper through `xdg-native-messaging-proxy`
  (Firefox 157+, [bug 1955255](https://bugzilla.mozilla.org/show_bug.cgi?id=1955255); the proxy
  service must be installed on the host) or, for Snap Firefox, its WebExtensions portal. `setup.sh`
  detects sandboxed Firefox-based browsers (`flatpak list`, `snap list`), reports whether the
  proxy is installed, and offers an available package from configured repository metadata. It does
  not configure portals or guarantee a particular sandboxed browser works. This hasn't been tested
  with a real sandboxed browser.
- One helper folder for all browsers: `~/.mozilla/native-messaging-hosts`. Firefox hard-codes the
  name (Zen keeps it, verified in its `libxul.so`), and LibreWolf reads it in addition to its own
  folder since 140 ([LibreWolf #2308](https://codeberg.org/librewolf/issues/issues/2308)), which is
  also this extension's minimum version.
- The download list lives in the background page's memory and is gone after a browser restart.
- Login-gated or age-restricted videos need cookies, which aren't supported.
- A cancelled download's partial files are deleted with its staging folder, so it can't resume.
