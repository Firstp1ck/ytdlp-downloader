#!/usr/bin/env bash
# Accept `sh setup.sh` as well when /bin/sh is dash. Piped setup requires bash.
if [ -z "${BASH_VERSION:-}" ]; then
    if [ -f "$0" ]; then exec bash "$0" "$@"; fi
    echo 'Setup needs bash: use curl … | bash.' >&2
    exit 1
fi
set -euo pipefail
RELEASE_VERSION=""
RELEASE_HOST_SHA256=""

host_name=dev.firstpick.ytdlp_downloader
install_dir="$HOME/.local/share/ytdlp-downloader"
host_file=""
target_dirs=()
assume_yes=false
no_deps=false
uninstall=false
dry_run=false
temp_dir=""
package_command=()
package_prepare=()
confirmed_flags=()
install_ytdlp=false
install_deno=false
ytdlp_base=https://github.com/yt-dlp/yt-dlp/releases/latest/download
deno_base=https://github.com/denoland/deno/releases/latest/download
ytdlp_asset=""
deno_asset=""

usage() {
    cat <<'HELP'
Usage: setup.sh [--host-file PATH] [--target-dir DIR ...] [--yes] [--no-deps]
                [--uninstall] [--dry-run] [--help]
Registers the helper for Firefox, Zen and other Firefox-based browsers in
~/.mozilla/native-messaging-hosts, the folder they all read; explicit --target-dir
values replace it.
--yes accepts dependency installs; --no-deps skips them. --uninstall removes only
the helper and its manifests. Warns about Flatpak/Snap browsers it finds.
Test overrides: YTDLP_SETUP_BASE_URL replaces the release download directory;
YTDLP_SETUP_OS_RELEASE replaces /etc/os-release; YTDLP_SETUP_TTY replaces /dev/tty.
Test-only: YTDLP_SETUP_TEST_EUID overrides the root check (never grants privileges).
HELP
}

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$temp_dir" ]]; then rm -rf -- "$temp_dir"; fi; }
trap cleanup EXIT


sandboxed_browsers() {
    # Print "Name (Flatpak|Snap)" for Firefox-based browsers installed sandboxed.
    local id name
    if command -v flatpak >/dev/null 2>&1; then
        while IFS=$'\t' read -r id name; do
            if [[ "$id $name" =~ [Ff]irefox|[Zz]en|[Ll]ibre[Ww]olf|[Ff]loorp|[Ww]aterfox ]]; then
                printf '%s (Flatpak)\n' "${name:-$id}"
            fi
        done < <(flatpak list --app --columns=application,name 2>/dev/null || true)
    fi
    if command -v snap >/dev/null 2>&1; then
        while read -r name _; do
            case "$name" in
                firefox|librewolf|floorp|waterfox|zen-browser) printf '%s (Snap)\n' "$name" ;;
            esac
        done < <(snap list 2>/dev/null || true)
    fi
}

has_native_messaging_proxy() {
    local candidate
    for candidate in /usr/libexec/xdg-native-messaging-proxy /usr/lib/xdg-native-messaging-proxy \
                     /usr/lib/xdg-native-messaging-proxy/xdg-native-messaging-proxy; do
        if [[ -x "$candidate" ]]; then return 0; fi
    done
    command -v xdg-native-messaging-proxy >/dev/null 2>&1
}

check_sandboxed_browsers() {
    # The setup page can't do this check: a sandboxed browser that can't reach
    # the helper can't report anything either. This script runs on the host.
    local browsers line
    browsers=$(sandboxed_browsers)
    [[ -n "$browsers" ]] || return 0
    while IFS= read -r line; do printf '⚠ Sandboxed browser found: %s\n' "$line"; done <<<"$browsers"
    echo '  Flatpak/Snap browsers can only start the helper through xdg-native-messaging-proxy'
    echo '  (browsers based on Firefox 157 or newer). Snap Firefox may use its portal instead.'
    if has_native_messaging_proxy; then
        echo '  ✓ xdg-native-messaging-proxy is installed. If the setup page stays red, use a non-sandboxed build.'
    else
        echo '  ✗ xdg-native-messaging-proxy is not installed. Install it from your package manager if available,'
        echo '    or use a non-sandboxed build of the browser (distro package, tarball or AppImage).'
    fi
}

remove_host() {
    local target_dir
    for target_dir in "${target_dirs[@]}"; do
        if "$dry_run"; then
            printf 'Would remove: %s/%s.json\n' "$target_dir" "$host_name"
        else
            rm -f -- "$target_dir/$host_name.json"
        fi
    done
    if "$dry_run"; then
        printf 'Would remove: %s/ytdlp_host.py\n' "$install_dir"
    else
        rm -f -- "$install_dir/ytdlp_host.py"
        if [[ -d "$install_dir" ]]; then rmdir -- "$install_dir" 2>/dev/null || true; fi
        echo '✓ Helper removed.'
    fi
}

ensure_temp() {
    if [[ -z "$temp_dir" ]]; then temp_dir=$(mktemp -d); fi
}

download() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --output "$2" -- "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" -- "$1"
    else
        echo 'Download needs curl or wget. Install one, then run setup again.' >&2
        return 1
    fi
}

distro_family() {
    # Parse data rather than sourcing an externally supplied os-release file.
    python3 - "${YTDLP_SETUP_OS_RELEASE:-/etc/os-release}" <<'PY'
import shlex
import sys

values = {}
try:
    with open(sys.argv[1], encoding="utf-8") as stream:
        for line in stream:
            key, sep, value = line.strip().partition("=")
            if sep and key in ("ID", "ID_LIKE"):
                try:
                    values[key] = " ".join(shlex.split(value))
                except ValueError:
                    pass
except OSError:
    pass
# RHEL rebuilds list "rhel" before "fedora" in ID_LIKE, so they map to "rhel":
# their repositories lack yt-dlp and ffmpeg (needs EPEL + RPM Fusion).
families = {"arch": "arch", "manjaro": "arch", "fedora": "fedora",
            "rhel": "rhel", "centos": "rhel", "rocky": "rhel", "almalinux": "rhel",
            "opensuse": "suse",
            "opensuse-leap": "suse", "opensuse-tumbleweed": "suse", "suse": "suse",
            "debian": "debian", "ubuntu": "debian"}
for name in (values.get("ID", "") + " " + values.get("ID_LIKE", "")).split():
    if name in families:
        print(families[name])
        break
PY
}

show_dependency_plan() {
    if ((${#package_prepare[@]})); then printf '→ Run: %s\n' "${package_prepare[*]}"; fi
    if ((${#package_command[@]})); then printf '→ Run: %s\n' "${package_command[*]}"; fi
    if "$install_ytdlp"; then
        printf '→ Download %s/%s and %s/SHA2-256SUMS; verify the asset SHA-256 before installing.\n' "$ytdlp_base" "$ytdlp_asset" "$ytdlp_base"
        printf '→ Create %s/.local/bin, install executable yt-dlp there, then probe yt-dlp --version (no sudo).\n' "$HOME"
    fi
    if "$install_deno"; then
        printf '→ Download %s/%s and its .sha256sum; verify the asset SHA-256 before extracting.\n' "$deno_base" "$deno_asset"
        printf '→ Extract deno with Python zipfile, create %s/.local/bin, install deno there with chmod +x, then probe deno --version (no sudo).\n' "$HOME"
    fi
}

consent() {
    local tty_fd answer tty="${YTDLP_SETUP_TTY:-/dev/tty}"
    if "$assume_yes"; then return 0; fi
    # stdin may still contain the script when setup is piped into bash.
    # A failed exec redirection is fatal in POSIX-mode bash, even in `if`.
    # Probe in a subshell first: even `:` redirection can exit POSIX-mode bash.
    if [[ -c "$tty" ]] && ( : <>"$tty" ) 2>/dev/null && { exec {tty_fd}<>"$tty"; } 2>/dev/null; then
        if [[ -t "$tty_fd" ]]; then
            printf 'Install missing dependencies? [Y/n] ' >&"$tty_fd"
            if IFS= read -r answer <&"$tty_fd"; then
                exec {tty_fd}>&-
                [[ -z "$answer" || "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
                return
            fi
        fi
        exec {tty_fd}>&-
    fi
    echo '→ No terminal/answer; dependencies were not installed. Run the plan above yourself, or rerun with --yes.' >&2
    return 1
}

run_with_terminal_input() {
    # stdin is the script itself under `curl … | bash`; give tools the terminal
    # (for sudo's password prompt and any question) or nothing at all.
    local tty="${YTDLP_SETUP_TTY:-/dev/tty}"
    if [[ -c "$tty" ]] && ( : <>"$tty" ) 2>/dev/null; then
        "$@" <"$tty"
    else
        "$@" </dev/null
    fi
}

dependency_failed() {
    printf "→ Dependency installation failed: %s; the helper is installed anyway, the setup page shows what's missing\n" "$*" >&2
}

runtime_candidates() {
    # Same search as the helper's runtime_candidates(): PATH, then per-user dirs.
    local name=$1 candidate
    command -v "$name" 2>/dev/null || true
    for candidate in "$HOME/.local/bin/$name" "$HOME/.deno/bin/$name" "$HOME/.volta/bin/$name" \
                     "$HOME"/.nvm/versions/node/*/bin/"$name"; do
        if [[ -f "$candidate" && -x "$candidate" ]]; then printf '%s\n' "$candidate"; fi
    done
}

has_js_runtime() {
    # Deno (yt-dlp's default), or Node 22+ as fallback. Bun doesn't count: yt-dlp
    # deprecated it and it runs YouTube's script unsandboxed.
    local candidate version major
    if [[ -n "$(runtime_candidates deno)" ]]; then return 0; fi
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] || continue
        version=$("$candidate" --version 2>/dev/null) || continue
        major=${version#v}; major=${major%%.*}
        if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)); then return 0; fi
    done < <(runtime_candidates node)
    return 1
}

verify_asset() {
    # Both upstreams publish standard sha256sum lines: HEX  filename.
    # Require exactly one line for this asset, never an unrelated digest.
    python3 - "$1" "$2" "$3" <<'CHECKSUM'
import hashlib
from pathlib import Path
import re
import sys

asset, sums, name = sys.argv[1:]
try:
    matches = []
    for line in Path(sums).read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *](.+)", line)
        if match and match[2] == name:
            matches.append(match[1].lower())
    actual = hashlib.sha256(Path(asset).read_bytes()).hexdigest()
    if matches != [actual]:
        raise ValueError("SHA-256 mismatch or missing/duplicate asset checksum")
except (OSError, ValueError) as exc:
    print(f"Checksum verification failed for {name}: {exc}", file=sys.stderr)
    sys.exit(1)
CHECKSUM
}

install_standalone_ytdlp() {
    ensure_temp || return
    download "$ytdlp_base/$ytdlp_asset" "$temp_dir/$ytdlp_asset" || return
    download "$ytdlp_base/SHA2-256SUMS" "$temp_dir/SHA2-256SUMS" || return
    verify_asset "$temp_dir/$ytdlp_asset" "$temp_dir/SHA2-256SUMS" "$ytdlp_asset" || return
    mkdir -p -- "$HOME/.local/bin" || return
    install -m 755 -- "$temp_dir/$ytdlp_asset" "$HOME/.local/bin/yt-dlp" || return
    "$HOME/.local/bin/yt-dlp" --version || return
}

install_standalone_deno() {
    ensure_temp || return
    download "$deno_base/$deno_asset" "$temp_dir/$deno_asset" || return
    download "$deno_base/$deno_asset.sha256sum" "$temp_dir/deno.sha256sum" || return
    verify_asset "$temp_dir/$deno_asset" "$temp_dir/deno.sha256sum" "$deno_asset" || return
    # Read only the named binary; archive paths cannot write outside temp_dir.
    python3 - "$temp_dir/$deno_asset" "$temp_dir/deno" <<'DENO' || return
from pathlib import Path
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    Path(sys.argv[2]).write_bytes(archive.read("deno"))
DENO
    mkdir -p -- "$HOME/.local/bin" || return
    install -m 755 -- "$temp_dir/deno" "$HOME/.local/bin/deno" || return
    "$HOME/.local/bin/deno" --version || return
}

check_dependencies() {
    local missing_ytdlp=false missing_ffmpeg=false missing_js=false family arch
    local failed=false privilege=() packages=()
    if ! command -v yt-dlp >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/yt-dlp" ]]; then missing_ytdlp=true; fi
    if ! command -v ffmpeg >/dev/null 2>&1; then missing_ffmpeg=true; fi
    if ! has_js_runtime; then missing_js=true; fi
    if ! "$missing_ytdlp" && ! "$missing_ffmpeg" && ! "$missing_js"; then
        echo '✓ yt-dlp and ffmpeg found; JavaScript runtime found.'
        return
    fi
    if "$missing_ytdlp"; then echo '→ yt-dlp is missing.'; fi
    if "$missing_ffmpeg"; then echo '→ ffmpeg is missing.'; fi
    if "$missing_js"; then echo '→ JavaScript runtime is missing (Deno, or Node 22 or newer).'; fi
    # Test-only override lets unprivileged tests exercise the root command shape.
    if [[ "${YTDLP_SETUP_TEST_EUID:-$EUID}" != 0 ]]; then privilege=(sudo); fi
    family=$(distro_family)
    case "$family" in
        arch)
            if "$missing_ytdlp"; then packages+=(yt-dlp); fi
            if "$missing_ffmpeg"; then packages+=(ffmpeg); fi
            if "$missing_js"; then packages+=(deno); fi
            package_command=("${privilege[@]}" pacman -S --needed "${packages[@]}")
            # Only add --noconfirm after consent; the displayed plan stays interactive.
            confirmed_flags=(--noconfirm) ;;
        fedora|suse)
            if "$missing_ytdlp"; then packages+=(yt-dlp); fi
            if "$missing_ffmpeg"; then
                if [[ "$family" == fedora ]]; then packages+=(ffmpeg-free); else packages+=(ffmpeg); fi
            fi
            if ((${#packages[@]})); then
                if [[ "$family" == fedora ]]; then
                    package_command=("${privilege[@]}" dnf install -y "${packages[@]}")
                else
                    package_command=("${privilege[@]}" zypper install -y "${packages[@]}")
                fi
            fi ;;
        debian)
            if "$missing_ffmpeg"; then
                # Fresh or stale package lists make `apt-get install` fail with
                # "Unable to locate package" (seen in a clean Debian 13 container).
                package_prepare=("${privilege[@]}" apt-get update)
                package_command=("${privilege[@]}" apt-get install -y ffmpeg)
            fi
            install_ytdlp="$missing_ytdlp" ;;
        rhel)
            install_ytdlp="$missing_ytdlp"
            if "$missing_ffmpeg"; then
                echo "→ ffmpeg isn't in RHEL/Rocky/Alma's repositories. Enable EPEL and RPM Fusion"
                echo '  (https://rpmfusion.org/Configuration), run: sudo dnf install ffmpeg, then run setup again.'
            fi ;;
        *)
            echo '→ Unknown distribution. Install yt-dlp and ffmpeg with your package manager; then run setup again.' ;;
    esac
    if [[ "$family" != arch ]]; then install_deno="$missing_js"; fi
    if "$install_ytdlp" || "$install_deno"; then
        arch=$(uname -m)
        case "$arch" in
            x86_64) ytdlp_asset=yt-dlp_linux; deno_asset=deno-x86_64-unknown-linux-gnu.zip ;;
            aarch64) ytdlp_asset=yt-dlp_linux_aarch64; deno_asset=deno-aarch64-unknown-linux-gnu.zip ;;
            *)
                printf '→ No automatic standalone builds for %s. Install yt-dlp and a JavaScript runtime (Deno, or Node 22 or newer) manually from their official releases.\n' "$arch"
                install_ytdlp=false; install_deno=false ;;
        esac
    fi
    show_dependency_plan
    if "$dry_run"; then return; fi
    if ((${#package_command[@]} == 0)) && ! "$install_ytdlp" && ! "$install_deno"; then return; fi
    if ! consent; then echo '→ Skipping dependency installation.'; return; fi
    if ((${#package_prepare[@]})) && ! run_with_terminal_input "${package_prepare[@]}"; then
        # Not fatal by itself: existing lists may still be good enough for the install.
        printf '→ %s failed; trying the install anyway.\n' "${package_prepare[*]}" >&2
    fi
    if ((${#package_command[@]})); then
        if ! run_with_terminal_input "${package_command[@]}" "${confirmed_flags[@]}"; then
            dependency_failed "${package_command[*]}"; failed=true
        fi
    fi
    if "$install_ytdlp"; then
        if ! install_standalone_ytdlp; then
            dependency_failed 'yt-dlp download/checksum/install/--version probe'; failed=true
        fi
    fi
    if "$install_deno"; then
        if ! install_standalone_deno; then
            dependency_failed 'Deno download/checksum/extract/install/--version probe'; failed=true
        fi
    fi
    if ! "$failed"; then echo '✓ Dependency installation finished.'; fi
}

obtain_host() {
    local base_url
    if [[ -n "$host_file" ]]; then
        [[ -f "$host_file" ]] || fail "Host file not found: $host_file"
        return
    fi
    [[ -n "$RELEASE_HOST_SHA256" ]] || fail 'This setup script has no release host checksum. Use a released setup.sh or pass --host-file PATH from a checkout.'
    [[ -n "$RELEASE_VERSION" ]] || fail 'This setup script has no release version. Use a released setup.sh or pass --host-file PATH.'
    base_url="${YTDLP_SETUP_BASE_URL:-https://github.com/Firstp1ck/ytdlp-downloader/releases/download/v${RELEASE_VERSION}}"
    if "$dry_run"; then printf 'Would download and verify: %s/ytdlp_host.py\n' "${base_url%/}"; return; fi
    echo '→ Downloading helper…'
    ensure_temp
    host_file="$temp_dir/ytdlp_host.py"
    download "${base_url%/}/ytdlp_host.py" "$host_file"
    if ! python3 - "$host_file" "$RELEASE_HOST_SHA256" <<'PY'
import hashlib
import sys

with open(sys.argv[1], "rb") as stream:
    actual = hashlib.sha256(stream.read()).hexdigest()
sys.exit(0 if actual == sys.argv[2] else 1)
PY
    then
        fail 'Helper SHA-256 checksum mismatch; nothing was registered. Download a fresh released setup.sh and try again.'
    fi
    echo '✓ Helper checksum verified.'
}

register_host() {
    local target_dir
    if "$dry_run"; then
        printf 'Would install executable: %s/ytdlp_host.py\n' "$install_dir"
        for target_dir in "${target_dirs[@]}"; do printf 'Would write manifest: %s/%s.json\n' "$target_dir" "$host_name"; done
        return
    fi
    mkdir -p -- "$install_dir"
    install -m 755 -- "$host_file" "$install_dir/ytdlp_host.py"
    for target_dir in "${target_dirs[@]}"; do
        mkdir -p -- "$target_dir"
        python3 - "$install_dir/ytdlp_host.py" "$target_dir/$host_name.json" <<'PY'
import json
import os
import sys

manifest = {
    "name": "dev.firstpick.ytdlp_downloader",
    "description": "Download videos and audio with yt-dlp from Firefox or Zen",
    "path": os.path.abspath(sys.argv[1]),
    "type": "stdio",
    "allowed_extensions": ["ytdlp-downloader@firstpick.dev"],
}
with open(sys.argv[2], "w", encoding="utf-8") as stream:
    json.dump(manifest, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
PY
        printf '✓ Installed manifest: %s/%s.json\n' "$target_dir" "$host_name"
    done
    printf '✓ Installed host: %s/ytdlp_host.py\n' "$install_dir"
}

parse_args() {
    while (($#)); do
        case "$1" in
            --host-file|--target-dir)
                if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
                if [[ "$1" == --host-file ]]; then host_file="$2"; else target_dirs+=("$2"); fi
                shift 2 ;;
            --yes) assume_yes=true; shift ;;
            --no-deps) no_deps=true; shift ;;
            --uninstall) uninstall=true; shift ;;
            --dry-run) dry_run=true; shift ;;
            --help|-h) usage; exit 0 ;;
            *) usage >&2; exit 2 ;;
        esac
    done
    # One folder for all: Firefox's code hard-codes ~/.mozilla, so Zen and other forks
    # read it, and LibreWolf reads it too since 140 (our minimum version).
    if ((${#target_dirs[@]} == 0)); then target_dirs=("$HOME/.mozilla/native-messaging-hosts"); fi
}

main() {
    parse_args "$@"
    if "$uninstall"; then remove_host; exit 0; fi
    command -v python3 >/dev/null 2>&1 || fail 'Python 3 is required. Install python3 with your distribution package manager, then run setup again.'
    echo '✓ Python 3 found.'
    check_sandboxed_browsers
    if ! "$no_deps"; then check_dependencies; fi
    obtain_host
    register_host
    if ! "$dry_run"; then echo '✓ Done! Go back to the browser; the setup page detects the helper automatically.'; fi
}

# Everything runs from this final compound command: with `curl … | bash`, a
# download truncated inside the invocation cannot execute main without its flags.
{ main "$@"; }
