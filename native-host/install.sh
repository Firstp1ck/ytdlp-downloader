#!/usr/bin/env bash
set -euo pipefail

host_name=dev.firstpick.ytdlp_downloader
install_dir="$HOME/.local/share/ytdlp-downloader"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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

for tool in yt-dlp ffmpeg; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Warning: $tool was not found in PATH." >&2
    fi
done

if "$dry_run"; then
    printf 'Would install executable: %s/ytdlp_host.py\n' "$install_dir"
    for target_dir in "${target_dirs[@]}"; do
        printf 'Would write manifest: %s/%s.json\n' "$target_dir" "$host_name"
    done
    exit 0
fi

mkdir -p -- "$install_dir"
install -m 755 -- "$source_dir/ytdlp_host.py" "$install_dir/ytdlp_host.py"
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
    printf 'Installed manifest: %s/%s.json\n' "$target_dir" "$host_name"
done
printf 'Installed host: %s/ytdlp_host.py\n' "$install_dir"
