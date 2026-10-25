# ytdlp-downloader

Right-click a YouTube video in Firefox or Zen and pick **Download Video**.
[yt-dlp](https://github.com/yt-dlp/yt-dlp) downloads it in the background with the defaults you set
on the settings page.

It has two parts:

- `extension/`: a WebExtension (context menu, settings page, toolbar popup with progress and cancel).
- `native-host/`: a small Python program the browser starts through
  [native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging).
  It runs yt-dlp, because an extension can't start local programs by itself.

A Zen "mod" can't do this: mods are CSS theme tweaks with no access to processes.

## Requirements

- Linux, with Firefox or Zen installed natively (not Flatpak or Snap)
- Python 3.8+
- `yt-dlp` on `PATH` or in `~/.local/bin`
- `ffmpeg`, used to merge video and audio and for every audio download
- Optional: `zenity`, `kdialog`, or `yad` for the **Browse…** folder picker

## Install

1. Register the native host:

   ```sh
   ./native-host/install.sh
   ```

   This copies the host to `~/.local/share/ytdlp-downloader/` and writes
   `~/.mozilla/native-messaging-hosts/dev.firstpick.ytdlp_downloader.json`. Firefox and Zen both read
   native hosts from `~/.mozilla` (Zen keeps profiles in `~/.zen` but not host manifests). For other
   forks, pass `--target-dir`, e.g. `--target-dir ~/.librewolf/native-messaging-hosts`. Add
   `--dry-run` to preview the changes.

2. Load the extension. Pick one:
   - **Temporary** (removed on restart): open `about:debugging#/runtime/this-firefox`, choose
     **Load Temporary Add-on…**, and select `extension/manifest.json`.
   - **Permanent, unsigned** (Zen, Firefox Developer Edition/Nightly, LibreWolf): set
     `xpinstall.signatures.required` to `false` in `about:config`, build the package with
     `cd extension && zip -r ../ytdlp-downloader.xpi .`, then open the `.xpi` in the browser.
     Regular Firefox release builds ignore that pref, so there you'd need to sign the add-on on AMO
     (it can stay unlisted).

3. Open the extension's settings and check the **Native host status** panel. It should show the
   yt-dlp version and that ffmpeg was found.

## Use

Right-click any of these:

- a YouTube video, Short, live, or playlist link on any page
- a YouTube watch, Shorts, or playlist page
- the player (YouTube shows its own menu there, so Shift+right-click to get the browser's menu)

Menu items:

- **Download Video**: uses your saved defaults, including the default action (video or audio).
- **Download Audio**: uses your audio settings, whatever the default action is.
- **yt-dlp Settings…**

The toolbar button shows how many downloads are running. Its popup lists downloads with progress,
**Cancel**, and **Open folder**.

## Settings

| Setting | Values | Default |
|---|---|---|
| Default action | Video / Audio | Video |
| Video resolution | Best, 2160p, 1440p, 1080p, 720p, 480p, 360p | Best |
| Preferred video format | Any, MP4, WebM, MKV | MP4 |
| Audio quality | Best (VBR), 320, 256, 192, 128, 96 kbps | Best |
| Preferred audio format | Original, MP3, M4A, Opus, FLAC, WAV | MP3 |
| Save path | absolute or `~/…`; empty = XDG Downloads folder | empty |
| Download playlists | on: playlist links and watch links with `list=` get every item | off |
| Notifications | start, finish, error | on |

Notes:

- **Resolution** is the highest you want. yt-dlp takes the best format at or below it. If a video has
  nothing that low, it takes the smallest one above.
- **Audio quality** only matters when the audio gets converted. If YouTube already serves your
  preferred format, or the format is Original, the stream is saved as-is.
- Files are named `Title [videoId].ext`. Playlists go into a subfolder: `Playlist/001 - Title [id].ext`.
  An existing file is never overwritten; the new one becomes `Title [videoId] (2).ext`.
- While a download runs, its partial files live in a hidden `.ytdlp-downloader-staging` folder inside
  the save path. The folder is removed when the download finishes or is cancelled.
- The host runs yt-dlp with `--ignore-config`, so your personal yt-dlp config file doesn't apply.
- At most two downloads run at once; the rest wait in a queue.

## Uninstall

```sh
./native-host/uninstall.sh   # same --target-dir flags as install
```

Then remove the add-on in `about:addons`.

## Troubleshooting

- **"Native host unavailable"**: run `install.sh`, then restart the browser. Check that the manifest
  exists and that its `path` points to an executable file.
- **Downloads fail after a YouTube change**: update yt-dlp (`yt-dlp -U`, or your package manager).
- **Host logs**: the host writes diagnostics to stderr, which shows up in the Browser Console
  (Ctrl+Shift+J).

## More

- [TECHNICAL.md](TECHNICAL.md): architecture, the native messaging protocol, yt-dlp mapping, security.
- [DEVELOPMENT.md](DEVELOPMENT.md): repository layout, tests, debugging, packaging.
