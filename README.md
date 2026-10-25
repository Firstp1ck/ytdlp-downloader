# ytdlp-downloader

[![CI](https://github.com/Firstp1ck/ytdlp-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/Firstp1ck/ytdlp-downloader/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Firstp1ck/ytdlp-downloader)](https://github.com/Firstp1ck/ytdlp-downloader/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Right-click a YouTube video in Firefox or Zen and pick **Download Video** or **Download Audio**.
[yt-dlp](https://github.com/yt-dlp/yt-dlp) downloads it in the background. Each of the two actions
has its own defaults on the settings page.

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

1. Get the code and run the installer:

   ```sh
   git clone https://github.com/Firstp1ck/ytdlp-downloader.git
   cd ytdlp-downloader
   ./native-host/install.sh
   ```

   No git? Download *Source code* from the [latest release](https://github.com/Firstp1ck/ytdlp-downloader/releases/latest)
   and unpack it. Each release also has the packaged `ytdlp-downloader-<version>.xpi` attached,
   but the extension can't download anything without the helper that `install.sh` registers.

   It does three things:

   - **Registers the helper.** It copies the host to `~/.local/share/ytdlp-downloader/` and writes
     `~/.mozilla/native-messaging-hosts/dev.firstpick.ytdlp_downloader.json`. Firefox and Zen both
     read native hosts from `~/.mozilla` (Zen keeps profiles in `~/.zen` but not host manifests).
   - **Optionally allows unsigned add-ons** (it asks; default no). This extension isn't signed by
     Mozilla, so Zen only keeps it enabled while `xpinstall.signatures.required` is `false`. If you
     say yes, or pass `--allow-unsigned`, the script adds that pref to `user.js` in every profile in
     `~/.zen/profiles.ini`. Zen applies `user.js` at every start, so the extension can't get disabled
     later. This allows **any** unsigned add-on, not only this one.
   - **Builds `dist/ytdlp-downloader.xpi` and offers to open it** in Zen (it asks; default yes).
     Zen then shows its own "Add yt-dlp Downloader?" dialog; click **Add**. If the script has just
     written the pref while Zen is running, it skips this step and tells you to restart Zen first;
     then open the `.xpi` (drag it onto the window, or ⚙️ → *Install Add-on From File…* in
     `about:addons`).

   Non-interactive form: `./native-host/install.sh --allow-unsigned --install-extension`.
   `--dry-run` previews everything. Other browsers: `--target-dir ~/.librewolf/native-messaging-hosts`,
   `--profiles-ini ~/.librewolf/profiles.ini`, `--browser librewolf`. Regular Firefox release
   ignores the signing pref, so there the add-on has to be signed on AMO (it can stay unlisted), or
   loaded temporarily.

2. Open the extension's settings and check the **Native host status** panel. It should show the
   yt-dlp version and that ffmpeg was found.

**Temporary alternative** (removed when the browser restarts, no signing pref needed): open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select
`extension/manifest.json`.

**Updating:** `git pull` (or download the new release), then run `install.sh` again. It rebuilds the `.xpi` and
reinstalls it over the old version; your settings stay.

## Use

Right-click any of these:

- a YouTube video, Short, live, or playlist link on any page
- a YouTube watch, Shorts, or playlist page
- **the video player itself**: YouTube's own black player menu gets **Download Video** and
  **Download Audio** at the top. This also works in YouTube players embedded on other sites.
  (Shift+right-click on the player still opens the browser's menu with the items below.)

Browser menu items (Zen groups them under **yt-dlp Downloader ▸**):

- **Download Video**: saves the video with the Download Video defaults.
- **Download Audio**: saves only the audio with the Download Audio defaults.
- **yt-dlp Settings…**

Nothing pops up when you click; the download starts in the background. The toolbar button shows
how many downloads are running (in Zen it may sit in the extensions menu; pin it). Its popup lists downloads with progress,
**Cancel**, and **Open folder**.

## Settings

**Download Video**

| Setting | Values | Default |
|---|---|---|
| Resolution | Best, 2160p, 1440p, 1080p, 720p, 480p, 360p | Best |
| Preferred format | Any, MP4, WebM, MKV | MP4 |
| Save folder | absolute or `~/…`; empty = XDG Downloads folder | empty |
| Download playlists | on: playlist links and watch links with `list=` get every item | off |

**Download Audio**

| Setting | Values | Default |
|---|---|---|
| Quality | Best (VBR), 320, 256, 192, 128, 96 kbps | Best |
| Preferred format | Original, MP3, M4A, Opus, FLAC, WAV | MP3 |
| Save folder | absolute or `~/…`; empty = XDG Downloads folder | empty |
| Download playlists | on: playlist links and watch links with `list=` get every item | off |

**Shared**: notifications on start, finish, and error (default on).

Notes:

- **Resolution** is the highest you want. yt-dlp takes the best format at or below it. If a video has
  nothing that low, it takes the smallest one above.
- **Audio quality** only matters when the audio gets converted. If YouTube already serves your
  preferred format, or the format is Original, the stream is saved as-is.
- Files are named `Title [videoId].ext`. Playlists go into a subfolder: `Playlist/001 - Title [id].ext`.
  An existing file is never overwritten; the new one becomes `Title [videoId] (2).ext`.
- While a download runs, its partial files live in a hidden `.ytdlp-downloader-staging` folder inside
  the save folder. The folder is removed when the download finishes or is cancelled.
- The host runs yt-dlp with `--ignore-config`, so your personal yt-dlp config file doesn't apply.
- At most two downloads run at once; the rest wait in a queue.

## Uninstall

```sh
./native-host/uninstall.sh   # same --target-dir / --profiles-ini flags as install
```

This also removes the `user.js` line that `--allow-unsigned` added. The pref itself stays `false`
until you set it back to `true` in `about:config`.

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
- [CHANGELOG.md](CHANGELOG.md): release history.

## License

[MIT](LICENSE). This project only drives [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense)
and [ffmpeg](https://ffmpeg.org/), which you install separately. Download only content you have
the right to download, and respect YouTube's terms of service.
