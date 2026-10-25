#!/usr/bin/env bash
set -euo pipefail

host_name=dev.firstpick.ytdlp_downloader
install_dir="$HOME/.local/share/ytdlp-downloader"
target_dirs=()
dry_run=false

usage() {
    echo "Usage: $0 [--target-dir DIR ...] [--dry-run]"
    echo 'Explicit target directories replace the default ~/.mozilla/native-messaging-hosts.'
}

while (($#)); do
    case "$1" in
        --target-dir)
            if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
            target_dirs+=("$2")
            shift 2
            ;;
        --dry-run) dry_run=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
if ((${#target_dirs[@]} == 0)); then
    target_dirs=("$HOME/.mozilla/native-messaging-hosts")
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
    if [[ -d "$install_dir" ]]; then
        rmdir -- "$install_dir" 2>/dev/null || true
    fi
fi
