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

## Install

**1. Add the extension:** download `ytdlp-downloader-<version>.xpi` from the
[latest release](https://github.com/Firstp1ck/ytdlp-downloader/releases/latest) and open it in
Firefox or Zen. (It isn't on addons.mozilla.org yet; until then see
[unsigned add-ons](#unsigned-add-ons) below.)

**2. Follow the setup page that opens.** It checks what's missing and shows one command to paste
into a terminal:

```sh
curl -fsSL https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v1.3.2/setup.sh | bash
```

Once the helper is installed, later updates show a shorter command that uses the setup launcher
described below:

```sh
"$HOME/.local/bin/ytdlp-setup" 1.3.2
```

The setup page lists all thirteen checks and distinguishes required failures from optional,
setup-only or installer-only warnings. It keeps install guidance visible when anything needs
attention. If curl is missing, it can use wget. If neither is installed, use **Download setup.sh**
on the page, type `bash ` (with a trailing space) in a terminal, drag the downloaded file into the
terminal and press Enter. A saved script can offer to install a downloader.

The command (the setup page shows the one matching your installed version) does two things:

1. **Installs the helper**, a small program that lets the browser run yt-dlp (Firefox doesn't let
   extensions start programs themselves). It's downloaded from the same GitHub release and checked
   against a SHA-256 checksum baked into the script. It goes to `~/.local/share/ytdlp-downloader/`
   and is registered in `~/.mozilla/native-messaging-hosts/`. Setup also writes a small managed
   launcher, `~/.local/bin/ytdlp-setup`, which downloads and runs the setup script of the release you
   name. It does not edit shell profiles, and it refuses to replace a file or symlink it didn't create.
2. **Offers to install what's missing**: Python 3.8+, setup utilities, yt-dlp, ffmpeg/ffprobe,
   and a JavaScript runtime. Python is checked and installed first when needed, because the helper
   and checksum verification depend on it. Deno is the default runtime; an existing Node 22+ also
   satisfies the check. Setup shows each plan and asks first; `sudo` asks for your password when
   needed. It also offers optional desktop tools: `zenity` for Browse when no supported picker is
   installed, `xdg-utils` for Open folder, and `xdg-user-dirs` for your configured Downloads folder.
   An existing zenity, kdialog or yad picker is kept.

   | Distro | yt-dlp | ffmpeg | Deno |
   |---|---|---|---|
   | Arch and derivatives | `pacman` | `pacman` | `pacman` |
   | Fedora | `dnf` | `dnf` (`ffmpeg-free`) | official build in `~/.local/bin` |
   | openSUSE | `zypper` | `zypper` | official build in `~/.local/bin` |
   | Debian, Ubuntu | official standalone build in `~/.local/bin` (apt's is usually too old for YouTube) | `apt-get` (after `apt-get update`) | official build in `~/.local/bin` |
   | RHEL, Rocky, Alma | official standalone build in `~/.local/bin` | enabled-repository package if available; otherwise EPEL/RPM Fusion instructions | official build in `~/.local/bin` |
   | others | instructions only | instructions only | official build in `~/.local/bin` |

   Downloaded builds are checked against the SHA-256 list their project publishes and test-run
   before setup reports success. Missing Python, coreutils, or a required downloader must be
   resolved before the helper can be installed. For the other tools, declining or failing an
   installation does not block helper registration. The setup page shows missing desktop tools as
   optional warnings; terminal output explains package-installation failures.

   Sandboxed browsers are checked separately. Setup offers `xdg-native-messaging-proxy` only when
   it is listed in existing repository metadata. It never adds repositories or installs AUR tools.
   Bash, a working package manager, and administrative access are required for package installs;
   missing sudo produces instructions for an administrator rather than an attempted privilege change.

The setup page notices helper 1.3.0 by itself and switches to **Ready** when required checks pass.
Optional warnings do not block downloads, but keep their install guidance and automatic rechecks
visible. An old helper or incomplete required report asks for an update instead of claiming Ready.
No browser restart needed. You can open it again any time: extension settings → **Helper program** → **Setup page**.

[Read the script first](https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v1.3.2/setup.sh)
if you like (that's the exact file the command runs). Options (add them after `bash -s --`):
`--no-deps` skips all dependency installations but still checks required setup prerequisites;
`--yes` accepts the displayed dependency plans without asking; `--dry-run` only shows what would
happen; `--uninstall` removes the helper and its managed launcher without requiring Python. The
launcher accepts only `--no-deps` and `--dry-run` after the version.

### Requirements

- Linux, with a Firefox-based browser (Firefox 140+, Zen, LibreWolf, …), preferably installed
  natively (see [Browsers](#browsers))
- Python 3.8+ for the helper; setup offers the distro's Python package and verifies it meets this minimum
- yt-dlp, ffmpeg/ffprobe, and a JavaScript runtime (Deno, or Node 22+); setup can install them
- Optional desktop tools, offered by setup when missing: `zenity` for **Browse…**, `xdg-utils` for
  **Open folder**, and `xdg-user-dirs` for Downloads-folder detection. Existing `kdialog` or `yad`
  also satisfy the picker requirement. Without xdg-user-dirs the helper falls back to `~/Downloads`.

### Browsers

| Browser | Status |
|---|---|
| Zen (distro package, tarball, AppImage) | tested |
| Firefox 140+ (release, ESR, Developer Edition, Nightly) | expected to work |
| LibreWolf 140+, Waterfox, Floorp, other forks | expected to work |
| Flatpak or Snap builds of any of these | only under conditions: they reach the helper through `xdg-native-messaging-proxy` (browsers based on Firefox 157+, plus the proxy service on your system); Snap Firefox may use its portal. **The setup command checks for sandboxed browsers and tells you what applies.** If it doesn't work, use a non-sandboxed build. |

They all read the helper registration from one folder, `~/.mozilla/native-messaging-hosts`: the
name is hard-coded in Firefox's code, and LibreWolf reads it too since version 140. Before the
extension is on addons.mozilla.org, browsers that enforce add-on signing need the unsigned-add-on
setting below.

### From a git checkout

For local helper testing without package installs, run
`bash native-host/setup.sh --host-file native-host/ytdlp_host.py --no-deps` from the checkout.
This updates helper registration in your user account and installs `~/.local/bin/ytdlp-setup`;
it refuses to run if an unmanaged file or symlink already uses that name, and
`bash native-host/setup.sh --uninstall` removes only the managed launcher. Development validation
uses temporary HOME rather than changing the running browser's helper.

```sh
git clone https://github.com/Firstp1ck/ytdlp-downloader.git
cd ytdlp-downloader
./native-host/install.sh
```

`install.sh` runs the same setup with the helper from your checkout, then builds
`dist/ytdlp-downloader.xpi` and offers to open it in the browser. Flags: `--target-dir DIR` for
other Firefox forks (e.g. `~/.librewolf/native-messaging-hosts`), `--browser CMD`, `--yes`,
`--no-deps`, `--dry-run`. If you installed the extension some other way (store or release `.xpi`),
add `--no-install-extension --no-allow-unsigned`.

### Unsigned add-ons

Until the extension is on addons.mozilla.org, the `.xpi` isn't signed by Mozilla. Zen, Firefox
Developer Edition/Nightly and LibreWolf accept it when `xpinstall.signatures.required` is `false`
in `about:config`. `install.sh --allow-unsigned` sets that in each Zen profile's `user.js` so it
can't get switched back (this allows **any** unsigned add-on). Regular Firefox release ignores the
pref; use **Load Temporary Add-on…** in `about:debugging` there (removed on restart).

### Updating

Extension updates come with each release (or automatically from the store, once listed). When an
update needs a newer helper, the setup page says so and shows the command again.

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
curl -fsSL https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v1.3.2/setup.sh | bash -s -- --uninstall
```

or `./native-host/uninstall.sh` from a checkout (which also removes the `user.js` line that
`--allow-unsigned` added; the pref stays `false` until you change it in `about:config`). Then remove
the add-on in `about:addons`.

## Troubleshooting

- **"yt-dlp: native host unavailable" / setup page stays red**: run the setup command again and read its
  output. Check that `~/.mozilla/native-messaging-hosts/dev.firstpick.ytdlp_downloader.json` exists
  and its `path` points to an executable file. For Flatpak/Snap browsers, read the setup command's
  "Sandboxed browser found" note.
- **Downloads fail after a YouTube change**: update yt-dlp (your package manager, or `yt-dlp -U` for
  the build in `~/.local/bin`).
- **Setup page says yt-dlp "doesn't run"**: the installed yt-dlp fails `yt-dlp --version`, usually
  because it needs a newer Python. Update it, or remove it and run the setup command again.
- **"JavaScript runtime" warning**: without Deno (or Node 22+) YouTube may hide some formats or
  videos. Run the setup command again to install Deno. Bun isn't used: yt-dlp deprecated it and it
  runs YouTube's script without a sandbox.
- **Host logs**: the host writes diagnostics to stderr, which shows up in the Browser Console
  (Ctrl+Shift+J).

## More

- [TECHNICAL.md](TECHNICAL.md): architecture, the native messaging protocol, yt-dlp mapping, security.
- [DEVELOPMENT.md](DEVELOPMENT.md): repository layout, tests, debugging, packaging.
- [CHANGELOG.md](CHANGELOG.md): release history.
- [docs/AMO.md](docs/AMO.md): addons.mozilla.org listing text and reviewer notes.

## License

[MIT](LICENSE). This project only drives [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense)
and [ffmpeg](https://ffmpeg.org/), which you install separately. Download only content you have
the right to download, and respect YouTube's terms of service.
