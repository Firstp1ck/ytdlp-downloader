#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dirs=()
dry_run=false
setup_flags=()
# unset = ask when run in a terminal; yes/no = decided by flag
allow_unsigned=""
install_extension=""
browser=""
profiles_ini="$HOME/.zen/profiles.ini"
repo_dir="$(dirname -- "$source_dir")"
xpi="$repo_dir/dist/ytdlp-downloader.xpi"

usage() {
    echo "Usage: $0 [--target-dir DIR ...] [--allow-unsigned | --no-allow-unsigned] [--profiles-ini FILE]"
    echo "          [--install-extension | --no-install-extension] [--browser CMD] [--xpi-out FILE] [--dry-run] [--yes] [--no-deps]"
    echo 'Explicit target directories replace the default ~/.mozilla/native-messaging-hosts.'
    echo '--allow-unsigned writes xpinstall.signatures.required=false into user.js of every profile'
    echo 'listed in --profiles-ini (default ~/.zen/profiles.ini), so the unsigned .xpi stays enabled.'
    echo 'Always builds dist/ytdlp-downloader.xpi. --install-extension opens it in the browser'
    echo '(default: zen-browser, else firefox), which asks you to confirm the install.'
    echo 'Without the yes/no flags the script asks when run in a terminal.'
    echo '--yes accepts dependency installs only; --no-deps skips dependency checks and installs.'
}

while (($#)); do
    case "$1" in
        --target-dir)
            if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
            target_dirs+=("$2")
            shift 2
            ;;
        --allow-unsigned) allow_unsigned=yes; shift ;;
        --no-allow-unsigned) allow_unsigned=no; shift ;;
        --profiles-ini)
            if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
            profiles_ini="$2"
            shift 2
            ;;
        --install-extension) install_extension=yes; shift ;;
        --no-install-extension) install_extension=no; shift ;;
        --browser)
            if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
            browser="$2"
            shift 2
            ;;
        --xpi-out)
            if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
            xpi="$2"
            shift 2
            ;;
        --yes|--no-deps) setup_flags+=("$1"); shift ;;
        --dry-run) dry_run=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
for target_dir in "${target_dirs[@]}"; do
    setup_flags+=(--target-dir "$target_dir")
done
if "$dry_run"; then setup_flags+=(--dry-run); fi
bash "$source_dir/setup.sh" --host-file "$source_dir/ytdlp_host.py" "${setup_flags[@]}"

if [[ -z "$allow_unsigned" ]]; then
    allow_unsigned=no
    if [[ -t 0 && -f "$profiles_ini" ]]; then
        echo "The extension is not signed by Mozilla. Zen only keeps it enabled while"
        echo "xpinstall.signatures.required is false, which allows unsigned add-ons in general."
        read -r -p "Set it in user.js of the profiles in $profiles_ini? [y/N] " answer
        [[ "$answer" =~ ^[Yy] ]] && allow_unsigned=yes
    fi
fi

if [[ -z "$browser" ]]; then
    for candidate in zen-browser zen firefox; do
        if command -v "$candidate" >/dev/null 2>&1; then browser="$candidate"; break; fi
    done
fi
if [[ -z "$install_extension" ]]; then
    install_extension=no
    if [[ -t 0 && -n "$browser" ]]; then
        read -r -p "Open the extension in $browser to install it now? [Y/n] " answer
        [[ "$answer" =~ ^[Nn] ]] || install_extension=yes
    fi
fi

if "$dry_run"; then
    printf 'Would build extension: %s\n' "$xpi"
    if [[ "$install_extension" == yes ]]; then
        printf 'Would open in %s: %s\n' "${browser:-<no browser found>}" "$xpi"
    fi
    if [[ "$allow_unsigned" == yes ]]; then
        python3 "$source_dir/unsigned_pref.py" add "$profiles_ini" --dry-run
    fi
    exit 0
fi

restart_needed=false
if [[ "$allow_unsigned" == yes ]]; then
    status=0
    python3 "$source_dir/unsigned_pref.py" add "$profiles_ini" || status=$?
    case "$status" in
        0) ;;
        3) restart_needed=true ;;
        *) exit "$status" ;;
    esac
fi

python3 "$source_dir/build_xpi.py" "$repo_dir/extension" "$xpi"
if [[ "$install_extension" == yes ]]; then
    if [[ -z "$browser" ]]; then
        echo "No browser found; open $xpi in your browser to install it." >&2
    elif "$restart_needed" && pgrep -x zen-bin >/dev/null 2>&1; then
        # A running Zen has not read the new user.js and would reject the unsigned file.
        echo "Zen is running and has not applied the new user.js yet."
        echo "Restart Zen, then open: $xpi"
    else
        "$browser" "$xpi" >/dev/null 2>&1 &
        disown
        echo "Opened $xpi in $browser; confirm the install there."
    fi
else
    echo "To install the extension, open $xpi in your browser."
fi
