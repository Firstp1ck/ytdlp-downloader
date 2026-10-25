#!/usr/bin/env bash
set -euo pipefail

target_dirs=()
dry_run=false
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
profiles_ini="$HOME/.zen/profiles.ini"

usage() {
    echo "Usage: $0 [--target-dir DIR ...] [--profiles-ini FILE] [--dry-run]"
    echo 'Explicit target directories replace the defaults: ~/.mozilla/native-messaging-hosts, plus'
    echo 'native-messaging-hosts in ~/.librewolf, ~/.waterfox and ~/.floorp when those folders exist.'
    echo 'Also removes the user.js line written by install.sh --allow-unsigned.'
}

while (($#)); do
    case "$1" in
        --target-dir)
            if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
            target_dirs+=("$2")
            shift 2
            ;;
        --profiles-ini)
            if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
            profiles_ini="$2"
            shift 2
            ;;
        --dry-run) dry_run=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done
setup_flags=(--uninstall)
for target_dir in "${target_dirs[@]}"; do
    setup_flags+=(--target-dir "$target_dir")
done
if "$dry_run"; then setup_flags+=(--dry-run); fi
bash "$source_dir/setup.sh" "${setup_flags[@]}"
if [[ -f "$profiles_ini" ]]; then
    if "$dry_run"; then
        python3 "$source_dir/unsigned_pref.py" remove "$profiles_ini" --dry-run
    else
        python3 "$source_dir/unsigned_pref.py" remove "$profiles_ini"
    fi
fi
