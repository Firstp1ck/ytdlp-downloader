# Changelog

All notable changes to this project. Versions match `extension/manifest.json`.

## [1.3.1] - 2026-10-26

### Added

- Setup displays all twelve required, recommended, optional and installer-only dependency checks.
  Missing or unconfirmed tools remain visible, with install/update guidance and automatic rechecks.
- The setup command uses wget when it is the available downloader, or offers browser-save
  instructions when neither curl nor wget is available.
- Setup offers missing Python 3.8+, coreutils, and a downloader needed for remote installation,
  then verifies required prerequisites before registering the helper. Distro detection no longer
  depends on Python.
- Setup offers optional folder-picker and XDG desktop tools, keeping any supported existing picker.
- For sandboxed browsers and RHEL multimedia, setup offers packages found in configured repository
  metadata without enabling repositories or using AUR helpers.

### Changed

- Helper and minimum helper version are now 1.2.0. Older helpers explicitly request an update so
  the extended dependency report cannot be silently skipped.
- Settings and toolbar status distinguish required failures, optional warnings and unconfirmed
  helper diagnostics.

### Fixed

- Check for ffprobe as well as ffmpeg, and offer the ffmpeg package when either is missing.
- Emit the finished-download event after staging cleanup, avoiding a race visible to consumers.
- Reconnect after Python repair and refresh default download directories when XDG detection becomes
  available, so successful setup changes take effect without restarting the browser.
- Preserve consent and no-op flags for prerequisite installs, with clear errors for missing sudo,
  unavailable package managers, or Python that remains unsupported after installation.

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
- Setup and settings page headers show the installed extension version.

### Changed

- Requires Firefox 140 or newer (Zen is on 158).
- Helper version 1.1.0: the setup page asks you to update an older helper (same command).
- The setup page reports a yt-dlp that is installed but doesn't run instead of showing "Ready".
- `install.sh` and `uninstall.sh` use the same setup script internally.
- Debian/Ubuntu: `apt-get update` runs before installing ffmpeg.
- Setup warns about Flatpak/Snap browsers and checks for `xdg-native-messaging-proxy` instead of
  calling them unsupported. One helper folder (`~/.mozilla`) serves Firefox, Zen, LibreWolf 140+
  and other forks.

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

[1.3.1]: https://github.com/Firstp1ck/ytdlp-downloader/releases/tag/v1.3.1
[1.3.0]: https://github.com/Firstp1ck/ytdlp-downloader/releases/tag/v1.3.0
[1.2.1]: https://github.com/Firstp1ck/ytdlp-downloader/releases/tag/v1.2.1
