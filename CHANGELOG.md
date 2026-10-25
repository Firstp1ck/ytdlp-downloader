# Changelog

All notable changes to this project. Versions match `extension/manifest.json`.

## [1.3.0] - 2026-10-25

### Added

- One-command setup: `curl -fsSL https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v1.3.0/setup.sh | bash`
  installs the helper (checksum-verified, pinned to the release) and offers to install yt-dlp,
  ffmpeg, and Deno (pacman, dnf, zypper, apt, or checksum-verified official builds in `~/.local/bin`).
- JavaScript runtime support: the helper passes Deno (default) or Node 22+ (fallback) to yt-dlp
  explicitly, which YouTube needs; the setup page warns when neither is installed. Bun is not used
  (deprecated in yt-dlp, unsandboxed).
- RHEL, Rocky and Alma: standalone yt-dlp plus ffmpeg instructions (their repositories have neither).
- Setup page that opens after installing the extension: shows what's missing, the command with a
  Copy button, and switches to "Ready" by itself once the helper answers.
- The settings page's "Helper program" card (formerly "Native host") has a **Setup page** button;
  the popup shows "Set up the helper" when it's missing, and the "native host unavailable"
  notification leads there too.

### Changed

- Requires Firefox 140 or newer (Zen is on 158).
- Helper version 1.1.0: the setup page asks you to update an older helper (same command).
- The setup page reports a yt-dlp that is installed but doesn't run instead of showing "Ready".
- `install.sh` and `uninstall.sh` use the same setup script internally.
- Debian/Ubuntu: `apt-get update` runs before installing ffmpeg.
- The helper is also registered for LibreWolf (`~/.librewolf`), and for Waterfox/Floorp folders if
  present. Setup warns about Flatpak/Snap browsers and checks for `xdg-native-messaging-proxy`
  instead of calling them unsupported.

## [1.2.1] - 2026-10-25

First public release.

### Added

- Right-click menu entries **Download Video** and **Download Audio** on YouTube video, Short,
  live, and playlist links, and on watch/Shorts/playlist pages.
- The same two entries in YouTube's own player menu (right-click on the video), including
  YouTube players embedded on other sites.
- Separate defaults for each action: resolution and format (video), quality and format (audio),
  save folder, and playlist handling; shared notifications setting.
- Toolbar popup with progress, cancel, and open folder; badge with the number of running downloads.
- Native messaging host (Python, stdlib only) that runs yt-dlp: two downloads at a time with a
  queue, per-job staging folders, never overwrites existing files.
- `native-host/install.sh`: registers the host, builds and opens the `.xpi`, and can opt in to
  unsigned add-ons through `user.js`. `uninstall.sh` reverses it.

[1.3.0]: https://github.com/Firstp1ck/ytdlp-downloader/releases/tag/v1.3.0
[1.2.1]: https://github.com/Firstp1ck/ytdlp-downloader/releases/tag/v1.2.1
