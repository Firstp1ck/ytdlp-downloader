#!/usr/bin/env python3
"""Add or remove the user.js line that lets the unsigned extension stay enabled.

Usage: unsigned_pref.py add|remove PROFILES_INI [--dry-run]

Exit status of "add": 0 when the pref is already in effect, 3 when user.js was
just written and the browser still has to be restarted to apply it.

user.js is applied on every browser start, so the pref cannot drift back to
true. Only lines carrying MARKER are ever touched; the rest of user.js is kept.
"""

import configparser
import os
import sys

MARKER = "// ytdlp-downloader: allow the unsigned extension (remove with native-host/uninstall.sh)"
PREF_LINE = 'user_pref("xpinstall.signatures.required", false);'
RESTART_NEEDED = 3


def profile_dirs(profiles_ini):
    """Return the existing profile directories listed in a profiles.ini."""
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    parser.read(profiles_ini, encoding="utf-8")
    base = os.path.dirname(os.path.abspath(profiles_ini))
    dirs = []
    for section in parser.sections():
        if not section.startswith("Profile") or "Path" not in parser[section]:
            continue
        path = parser[section]["Path"]
        if parser[section].get("IsRelative", "1") == "1":
            path = os.path.join(base, path)
        if os.path.isdir(path):
            dirs.append(path)
    return dirs


def read_lines(path):
    """Return user.js lines, or [] when the file does not exist."""
    try:
        with open(path, encoding="utf-8") as stream:
            return stream.read().splitlines()
    except FileNotFoundError:
        return []


def pref_active(directory):
    """Return whether the running/last session already has the pref (prefs.js mirrors about:config)."""
    return PREF_LINE in (line.strip() for line in read_lines(os.path.join(directory, "prefs.js")))


def strip_block(lines):
    """Remove the marker line and the pref line that directly follows it."""
    result, skip_next = [], False
    for line in lines:
        if skip_next and line.strip() == PREF_LINE:
            skip_next = False
            continue
        skip_next = line.strip() == MARKER
        if not skip_next:
            result.append(line)
    return result


def write_lines(path, lines):
    """Write user.js, or delete it when nothing but our block was in it."""
    if any(line.strip() for line in lines):
        with open(path, "w", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")
    elif os.path.exists(path):
        os.remove(path)


def main(argv):
    if len(argv) not in (3, 4) or argv[1] not in ("add", "remove") or argv[3:] not in ([], ["--dry-run"]):
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    action, profiles_ini, dry_run = argv[1], argv[2], argv[3:] == ["--dry-run"]
    if not os.path.isfile(profiles_ini):
        print(f"No profiles.ini at {profiles_ini}; set xpinstall.signatures.required "
              "to false in about:config instead.", file=sys.stderr)
        return 0
    dirs = profile_dirs(profiles_ini)
    if not dirs:
        print(f"No profiles found in {profiles_ini}.", file=sys.stderr)
    changed = False
    for directory in dirs:
        path = os.path.join(directory, "user.js")
        lines = read_lines(path)
        stripped = strip_block(lines)
        if action == "add":
            if stripped != lines:
                print(f"Already allowed: {path}")
                continue
            new = stripped + [MARKER, PREF_LINE]
        else:
            if stripped == lines:
                continue
            new = stripped
        verb = ("Would update" if dry_run else "Updated") if action == "add" else ("Would clean" if dry_run else "Cleaned")
        print(f"{verb}: {path}")
        changed = True
        if not dry_run:
            write_lines(path, new)
    if action == "remove" and changed and not dry_run:
        print("Note: the pref stays false until you set it back to true in about:config.")
    if action == "add" and changed and not dry_run and not any(pref_active(d) for d in dirs):
        return RESTART_NEEDED
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
