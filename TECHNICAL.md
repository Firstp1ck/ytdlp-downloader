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
    `toDownloadOptions()`. The options page builds its controls from it.
  - `shared/youtube.js`: classifies YouTube URLs (watch, youtu.be, Shorts, live, playlist, `m.`,
    `music.`) and rebuilds a clean URL from the validated video/list ids.
  - `shared/downloads.js`: pure state transitions for download entries driven by host events.
  - `options/`, `popup/`: UI pages. All network-derived text goes through `textContent`.
- **Native host** (`native-host/ytdlp_host.py`, Python 3.8+, stdlib only): validates requests, maps
  options to a yt-dlp argv, runs up to two jobs at once with a FIFO queue, streams progress, and
  publishes finished files.

## Design decisions

| Decision | Why |
|---|---|
| WebExtension + native messaging, not a Zen mod or userChrome.js | Mods are CSS only. userChrome.js loaders are unsupported and break on browser updates. Native messaging is the supported way to run a local program. |
| Manifest V2 with a persistent background page | Firefox keeps supporting MV2. A persistent page keeps the native port and progress tracking alive for the whole download; MV3 event pages can be suspended. |
| Long-lived `runtime.connectNative` port | `sendNativeMessage` stops the host after the first reply, which would kill yt-dlp. |
| Python host, stdlib only | yt-dlp is Python, so Python is already there. No pip dependencies to install. |
| No "extra yt-dlp arguments" setting; `--ignore-config` | Only enumerated values reach the command line, and a user config can't add `--exec` hooks or break the output templates the host parses. |
| Per-job staging directory | Two jobs with the same title would share `.part` files, and `-x` deletes its source after extraction, which could be a finished video with the same name. Staging isolates each job; the host then moves files into place without overwriting. |
| Manifest in `~/.mozilla/native-messaging-hosts` | Firefox and Zen both read it there; Zen's `libxul.so` only knows the `.mozilla` directory. |

IDs: extension `ytdlp-downloader@firstpick.dev`, native host `dev.firstpick.ytdlp_downloader`.

## Native messaging protocol

Framing is the standard WebExtension one: a uint32 length in native byte order, then UTF-8 JSON, on
stdin/stdout. The host writes nothing else to stdout; logs go to stderr (the Browser Console shows
them). Inbound frames are capped at 1 MiB. A malformed frame gets a `bad_request` and the host
closes, because the next frame boundary can't be trusted.

### Extension → host

```jsonc
{"type": "ping"}
{"type": "download", "id": "<uuid>", "url": "https://www.youtube.com/watch?v=...", "options": {
  "mode": "video" | "audio",
  "videoResolution": "best" | "2160" | "1440" | "1080" | "720" | "480" | "360",
  "videoFormat": "any" | "mp4" | "webm" | "mkv",
  "audioQuality": "best" | "320" | "256" | "192" | "128" | "96",     // kbps; "best" = VBR 0
  "audioFormat": "best" | "mp3" | "m4a" | "opus" | "flac" | "wav",  // "best" = keep the source codec
  "saveDir": "",          // "" = host default; "~" expanded; must be absolute afterwards
  "playlist": false       // the extension only sends true for URLs that carry a list id
}}
{"type": "cancel", "id": "<uuid>"}
{"type": "pickDirectory", "requestId": "<uuid>", "start": "~/Videos"}
{"type": "openPath", "path": "/abs/folder"}                              // folders only
```

Missing option keys get host defaults; unknown keys and invalid values are rejected, never repaired.

### Host → extension

```jsonc
{"type": "pong", "hostVersion": "1.0.0",
 "ytDlp": {"found": true, "path": "/usr/bin/yt-dlp", "version": "2026.10.21"},
 "ffmpeg": {"found": true, "path": "/usr/bin/ffmpeg"},
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
when it only copies. The host checks for ffmpeg before it starts a job.

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
- **Permissions**: `menus`, `nativeMessaging`, `storage`, `notifications`. No host permissions.

## Known limits

- Linux only. Flatpak/Snap browsers need the native-messaging portal, which isn't supported.
- The download list lives in the background page's memory and is gone after a browser restart.
- Login-gated or age-restricted videos need cookies, which aren't supported.
- A cancelled download's partial files are deleted with its staging folder, so it can't resume.
