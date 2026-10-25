# Changelog

All notable changes to this project. Versions match `extension/manifest.json`.

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

[1.2.1]: https://github.com/Firstp1ck/ytdlp-downloader/releases/tag/v1.2.1
