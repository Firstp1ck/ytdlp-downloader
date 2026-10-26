#!/usr/bin/env bash
# Accept `sh setup.sh` as well when /bin/sh is dash. Piped setup requires bash.
if [ -z "${BASH_VERSION:-}" ]; then
    if [ -f "$0" ] && command -v bash >/dev/null 2>&1; then exec bash "$0" "$@"; fi
    echo 'Setup needs bash. Install bash with your package manager, then run bash setup.sh or curl … | bash.' >&2
    exit 1
fi
set -euo pipefail
RELEASE_VERSION=""
RELEASE_HOST_SHA256=""

host_name=dev.firstpick.ytdlp_downloader
install_dir="$HOME/.local/share/ytdlp-downloader"
setup_launcher="$HOME/.local/bin/ytdlp-setup"
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
package_manager=""
sandboxed_browser_found=false
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
the helper, its managed setup launcher and its manifests. Python 3.8+, coreutils and a downloader are
required prerequisites; setup stops if they cannot be installed. Other offers
include ffmpeg/ffprobe, a folder picker and XDG desktop tools. Warns about
Flatpak/Snap browsers and offers their proxy only from configured repositories.
Test overrides: YTDLP_SETUP_BASE_URL replaces the release download directory;
YTDLP_SETUP_OS_RELEASE replaces /etc/os-release; YTDLP_SETUP_TTY replaces /dev/tty.
Test-only: YTDLP_SETUP_TEST_EUID overrides the root check (never grants privileges).
HELP
}

fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$temp_dir" ]]; then rm -rf -- "$temp_dir"; fi; }
trap cleanup EXIT


owns_setup_launcher() {
    local first second
    [[ -f "$setup_launcher" && ! -L "$setup_launcher" && -r "$setup_launcher" ]] || return 1
    { IFS= read -r first && IFS= read -r second; } <"$setup_launcher" || return 1
    [[ "$first" == '#!/bin/sh' && "$second" == '# Managed by yt-dlp Downloader' ]]
}

check_setup_launcher() {
    if [[ -e "$setup_launcher" || -L "$setup_launcher" ]] && ! owns_setup_launcher; then
        fail "Refusing to overwrite unmanaged setup launcher: $setup_launcher"
    fi
}

install_setup_launcher() {
    if "$dry_run"; then
        printf 'Would install managed setup launcher: %s\n' "$setup_launcher"
        return
    fi
    check_setup_launcher
    # Generate from the installed (release-checksummed) host, with no new asset.
    # shlex.quote handles spaces, apostrophes and shell metacharacters in both paths.
    python3 -I - "$setup_launcher" "$install_dir/ytdlp_host.py" <<'LAUNCHER'
import os
from pathlib import Path
import shlex
import sys
import tempfile

launcher, host = map(Path, sys.argv[1:])
launcher.parent.mkdir(parents=True, exist_ok=True)
script = ("#!/bin/sh\n# Managed by yt-dlp Downloader\nexec " + shlex.quote(sys.executable)
          + " -I " + shlex.quote(str(host)) + ' --setup "$@"\n')
fd, temporary = tempfile.mkstemp(prefix=".ytdlp-setup-", dir=launcher.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(script)
        os.fchmod(stream.fileno(), 0o755)
    os.replace(temporary, launcher)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
LAUNCHER
    printf '✓ Installed setup launcher: %s\n' "$setup_launcher"
}

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
    sandboxed_browser_found=true
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
    if owns_setup_launcher; then
        if "$dry_run"; then
            printf 'Would remove managed setup launcher: %s\n' "$setup_launcher"
        else
            rm -f -- "$setup_launcher"
        fi
    elif [[ -e "$setup_launcher" || -L "$setup_launcher" ]]; then
        printf 'Preserving unmanaged setup launcher: %s\n' "$setup_launcher"
    fi
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
    # Bootstrap must work without Python; never execute os-release as shell code.
    local release="${YTDLP_SETUP_OS_RELEASE:-/etc/os-release}" key value name id="" like="" names=()
    if [[ -r "$release" ]]; then
        while IFS='=' read -r key value || [[ -n "$key" ]]; do
            [[ "$key" == ID || "$key" == ID_LIKE ]] || continue
            if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value=${value:1:${#value}-2}; fi
            [[ "$value" =~ ^[a-zA-Z0-9._\ -]*$ ]] || continue
            if [[ "$key" == ID ]]; then id=$value; else like=$value; fi
        done <"$release"
    fi
    read -r -a names <<<"$id $like"
    for name in "${names[@]}"; do
        case "$name" in
            arch|manjaro) echo arch; return ;;
            fedora) echo fedora; return ;;
            rhel|centos|rocky|almalinux) echo rhel; return ;;
            opensuse|opensuse-leap|opensuse-tumbleweed|suse) echo suse; return ;;
            debian|ubuntu) echo debian; return ;;
        esac
    done
    return 0
}

plan_packages() {
    local family=$1 privilege=()
    shift
    package_command=(); package_prepare=(); confirmed_flags=(); package_manager=""
    (($#)) || return 0
    if [[ "${YTDLP_SETUP_TEST_EUID:-$EUID}" != 0 ]]; then privilege=(sudo); fi
    case "$family" in
        arch)
            package_manager=pacman
            package_command=("${privilege[@]}" pacman -S --needed "$@")
            confirmed_flags=(--noconfirm) ;;
        fedora|rhel)
            package_manager=dnf
            package_command=("${privilege[@]}" dnf install -y "$@") ;;
        suse)
            package_manager=zypper
            package_command=("${privilege[@]}" zypper install -y "$@") ;;
        debian)
            package_manager=apt-get
            package_prepare=("${privilege[@]}" apt-get update)
            package_command=("${privilege[@]}" apt-get install -y "$@") ;;
        *) return 1 ;;
    esac
}

run_package_plan() {
    ((${#package_command[@]})) || return 0
    if ! command -v "$package_manager" >/dev/null 2>&1; then
        printf '→ Package manager %s is missing; ask your administrator to install the listed packages.\n' "$package_manager" >&2
        return 1
    fi
    if [[ "${package_command[0]}" == sudo ]] && ! command -v sudo >/dev/null 2>&1; then
        echo '→ sudo is missing; ask your administrator to run the package-manager commands. Setup cannot grant itself privileges.' >&2
        return 1
    fi
    if ((${#package_prepare[@]})) && ! run_with_terminal_input "${package_prepare[@]}"; then
        printf '→ %s failed; trying the install anyway.\n' "${package_prepare[*]}" >&2
    fi
    run_with_terminal_input "${package_command[@]}" "${confirmed_flags[@]}"
}

package_available() {
    # Use existing metadata only: planning must not refresh repositories or add them.
    case "$1" in
        arch) pacman -Si -- "$2" >/dev/null 2>&1 ;;
        fedora|rhel) dnf --cacheonly -q list --available "$2" >/dev/null 2>&1 ;;
        suse)
            # zypper can exit successfully for a missing package; inspect exact XML results.
            zypper --xmlout --no-refresh --non-interactive search --match-exact --type package "$2" 2>/dev/null |
                python3 -c 'import sys, xml.etree.ElementTree as ET; sys.exit(not any(item.get("name") == sys.argv[1] for item in ET.parse(sys.stdin).iter("solvable")))' "$2" 2>/dev/null ;;
        debian) [[ -n "$(apt-cache show -- "$2" 2>/dev/null)" ]] ;;
        *) return 1 ;;
    esac
}

has_downloader() { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; }

prerequisite_packages() {
    local family=$1 tool
    if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
        if [[ "$family" == arch ]]; then echo python; else echo python3; fi
    fi
    for tool in cat mkdir install rm rmdir mktemp uname; do
        if ! command -v "$tool" >/dev/null 2>&1; then echo coreutils; break; fi
    done
    if [[ -z "$host_file" ]] && ! has_downloader; then echo curl; fi
}

check_prerequisites() {
    local family package packages=() remaining
    family=$(distro_family)
    while IFS= read -r package; do packages+=("$package"); done < <(prerequisite_packages "$family")
    if ((${#packages[@]} == 0)); then echo '✓ Python 3.8+ and setup prerequisites found.'; return; fi
    printf '→ Missing or unsupported setup prerequisites: %s (Python must be 3.8+).\n' "${packages[*]}"
    plan_packages "$family" "${packages[@]}" || fail 'Unknown distribution. Install Python 3.8+ (python3), coreutils and curl or wget with your package manager, then rerun setup.'
    show_dependency_plan
    if "$dry_run"; then return; fi
    if "$no_deps"; then fail 'Required setup prerequisites are missing; --no-deps forbids installing them. Run the plan above manually, then rerun setup.'; fi
    consent || fail 'Required setup prerequisites were not installed; nothing was registered.'
    run_package_plan || fail 'Required setup prerequisite installation failed; nothing was registered.'
    remaining=$(prerequisite_packages "$family")
    [[ -z "$remaining" ]] || fail "Setup prerequisites are still missing or unsupported: $remaining. Python 3.8+ must run as python3; nothing was registered."
    echo '✓ Python 3.8+ and setup prerequisites found.'
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
    local failed=false packages=()
    if ! command -v yt-dlp >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/yt-dlp" ]]; then missing_ytdlp=true; fi
    if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then missing_ffmpeg=true; fi
    if ! has_js_runtime; then missing_js=true; fi
    if "$missing_ytdlp"; then echo '→ yt-dlp is missing.'; fi
    if "$missing_ffmpeg"; then echo '→ ffmpeg or ffprobe is missing (both come from the ffmpeg package).'; fi
    if "$missing_js"; then echo '→ JavaScript runtime is missing (Deno, or Node 22 or newer).'; fi
    family=$(distro_family)
    case "$family" in
        arch)
            if "$missing_ytdlp"; then packages+=(yt-dlp); fi
            if "$missing_ffmpeg"; then packages+=(ffmpeg); fi
            if "$missing_js"; then packages+=(deno); fi
            ;;
        fedora|suse)
            if "$missing_ytdlp"; then packages+=(yt-dlp); fi
            if "$missing_ffmpeg"; then
                if [[ "$family" == fedora ]]; then packages+=(ffmpeg-free); else packages+=(ffmpeg); fi
            fi
            ;;
        debian)
            if "$missing_ffmpeg"; then packages+=(ffmpeg); fi
            install_ytdlp="$missing_ytdlp" ;;
        rhel)
            install_ytdlp="$missing_ytdlp"
            if "$missing_ffmpeg"; then
                if package_available "$family" ffmpeg; then packages+=(ffmpeg)
                elif package_available "$family" ffmpeg-free; then packages+=(ffmpeg-free)
                else
                    echo '→ No ffmpeg package found in enabled RHEL/Rocky/Alma repositories. Enable EPEL/RPM Fusion yourself if needed, then rerun setup.'
                fi
            fi ;;
        *)
            if "$missing_ytdlp" || "$missing_ffmpeg"; then
                echo '→ Unknown distribution. Install yt-dlp and ffmpeg with your package manager; then run setup again.'
            fi ;;
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
    if ! command -v zenity >/dev/null 2>&1 && ! command -v kdialog >/dev/null 2>&1 && ! command -v yad >/dev/null 2>&1; then
        echo '→ Optional folder picker is missing; offer zenity for Browse….'
        packages+=(zenity)
    fi
    if ! command -v xdg-open >/dev/null 2>&1; then
        echo '→ Optional xdg-open is missing; offer xdg-utils for Open folder.'
        packages+=(xdg-utils)
    fi
    if ! command -v xdg-user-dir >/dev/null 2>&1; then
        echo '→ Optional xdg-user-dir is missing; offer xdg-user-dirs for the configured Downloads folder.'
        packages+=(xdg-user-dirs)
    fi
    if "$sandboxed_browser_found" && ! has_native_messaging_proxy && package_available "$family" xdg-native-messaging-proxy; then
        packages+=(xdg-native-messaging-proxy)
    fi
    if { "$install_ytdlp" || "$install_deno"; } && ! has_downloader; then packages+=(curl); fi
    if ! plan_packages "$family" "${packages[@]}"; then
        printf '→ Install these packages manually: %s (unknown distribution).\n' "${packages[*]}"
    fi
    if ((${#package_command[@]} == 0)) && ! "$install_ytdlp" && ! "$install_deno"; then
        if ! "$missing_ytdlp" && ! "$missing_ffmpeg" && ! "$missing_js" && ((${#packages[@]} == 0)); then
            echo '✓ yt-dlp and ffmpeg found; JavaScript runtime found; desktop tools found.'
        fi
        return
    fi
    show_dependency_plan
    if "$dry_run"; then return; fi
    if ! consent; then echo '→ Skipping dependency installation.'; return; fi
    if ! run_package_plan; then dependency_failed "${package_command[*]}"; failed=true; fi
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
        install_setup_launcher
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
    install_setup_launcher
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
    # Refuse collisions before prerequisite/dependency installs or downloads.
    check_setup_launcher
    check_prerequisites
    check_sandboxed_browsers
    if ! "$no_deps"; then check_dependencies; fi
    obtain_host
    register_host
    if ! "$dry_run"; then echo '✓ Done! Go back to the browser; the setup page detects the helper automatically.'; fi
}

# Everything runs from this final compound command: with `curl … | bash`, a
# download truncated inside the invocation cannot execute main without its flags.
{ main "$@"; }
