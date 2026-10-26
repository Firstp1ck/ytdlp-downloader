# addons.mozilla.org submission

Text to paste into the AMO submission form. Keep it in sync with each release: replace the version
in URLs and tags. Submit as **Listed**, compatible with **Firefox (desktop) only**. Firefox for Android
has no native messaging, so the add-on can't work there. Answer **No** to "Do you need to submit
source code?" (there is no build step).

## Summary

> Right-click any YouTube video and download it as video or audio with yt-dlp, right on your
> computer. Linux only; a one-command setup installs the small helper program it needs.

## Description

> Right-click any YouTube video and download it as video or audio with yt-dlp, right on your
> computer. Separate defaults for video and audio. Requires Linux, yt-dlp, ffmpeg and a small helper
> program that lets Firefox run yt-dlp (one-command setup).
>
> Features:
> • "Download Video" and "Download Audio" in the right-click menu on YouTube videos, Shorts, live streams and playlist links
> • Also in YouTube's own player menu (right-click the video), including YouTube players embedded on other sites
> • Separate defaults per action: resolution and format (MP4, WebM, MKV) for video; quality and format (MP3, M4A, Opus, FLAC, WAV or original) for audio
> • Own save folder and playlist on/off switch for each action
> • Toolbar popup with progress, speed, cancel and "open folder"
> • Optional notifications when downloads start, finish or fail
> • Never overwrites existing files; two downloads at once, the rest queue
> • No tracking, no data collection, no accounts; everything runs locally
>
> Setup: after installing, a setup page opens and shows one command to paste into a terminal. It
> installs the helper program and, if you agree, yt-dlp and ffmpeg. The page turns green by itself
> when everything is ready. Source and manual install: https://github.com/Firstp1ck/ytdlp-downloader
>
> Linux only, Firefox desktop (and Zen). Download only content you have the right to download.

## Other fields

- **Categories:** Download Management (plus Photos, Music & Videos)
- **Support site:** https://github.com/Firstp1ck/ytdlp-downloader/issues
- **Homepage:** https://github.com/Firstp1ck/ytdlp-downloader
- **License:** MIT
- **Privacy policy:** not required (no data collected; `data_collection_permissions: none`)
- **Experimental:** tick it while the add-on is in beta

## Notes to Reviewer

These notes target v1.3.1 with helper 1.2.0. The setup page shows all dependency checks and asks
older helpers to update. Missing prerequisites can be installed by the consent-based setup script.

> **What it does**
> Adds "Download Video" / "Download Audio" to the context menu on YouTube links and pages, and to
> YouTube's own player menu. Downloads run through yt-dlp on the user's computer via native
> messaging. The extension itself downloads nothing.
>
> **Native host required (Linux only)**
> The extension talks to a companion program (Python 3, stdlib only) through
> `runtime.connectNative("dev.firstpick.ytdlp_downloader")`. Without it, a setup page explains how
> to install it; that is expected, not a bug.
>
> **Test setup** (Linux; setup offers Python 3.8+, download tools, yt-dlp, ffmpeg and Deno):
> 1. Install the add-on. A setup page opens automatically.
> 2. Paste the command it shows into a terminal:
>    `curl -fsSL https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v1.3.1/setup.sh | bash`
>    It downloads `ytdlp_host.py` from the same GitHub release, verifies its SHA-256, copies it to
>    `~/.local/share/ytdlp-downloader/`, and writes the host manifest to
>    `~/.mozilla/native-messaging-hosts/`. It asks before installing yt-dlp/ffmpeg via the package
>    manager. It also offers optional desktop tools. Add `-s -- --no-deps` to prohibit dependency
>    installs; required bootstrap prerequisites must then already be present. If neither curl nor
>    wget is available, save setup.sh in the browser and run `bash setup.sh` in its folder.
>    Undo: same command with `-s -- --uninstall`.
>    Script source: https://github.com/Firstp1ck/ytdlp-downloader/blob/v1.3.1/native-host/setup.sh
> 3. Required checks switch to "Ready" on their own. Optional or setup-only warnings remain visible
>    with install guidance and do not block downloads.
> 4. On youtube.com, right-click a video thumbnail → yt-dlp Downloader → Download Video. Progress
>    appears in the toolbar popup; the file lands in ~/Downloads. Right-clicking the playing video
>    shows the same two entries at the top of YouTube's player menu.
>
> **Permissions**
> - `nativeMessaging`: the yt-dlp helper (the add-on's only purpose)
> - `menus`: right-click entries
> - `storage`: user settings, local only
> - `notifications`: download started/finished/failed (can be turned off)
> - Content script on `www.youtube.com` and `youtube-nocookie.com/embed`: adds the two player-menu
>   rows. It reads only `location.href` on click and accepts only trusted (user) events. Content
>   scripts may send only one message type (`downloadFromPage`), and the background page
>   re-validates the URL as a YouTube video before anything reaches the host.
>
> **Security and privacy**
> - No remote code, no data collection (`data_collection_permissions: none`), no network requests
>   from the extension.
> - The host builds yt-dlp's arguments from fixed, validated option values only (no free-form
>   arguments), passes the URL after `--`, uses `--ignore-config`, and never uses a shell.
>
> **Build process / source code**
> No build step: no minification, bundling, transpiling or generated code. The `.xpi` is a plain zip
> of the `extension/` folder without `extension/tests/`. To reproduce it byte for byte:
> ```
> git clone --branch v1.3.1 https://github.com/Firstp1ck/ytdlp-downloader.git
> cd ytdlp-downloader
> python3 native-host/build_xpi.py extension ytdlp-downloader.xpi
> ```
> The result matches `ytdlp-downloader-1.3.1.xpi` from the GitHub release.
