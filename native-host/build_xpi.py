#!/usr/bin/env python3
"""Package extension/ into an .xpi (a zip with manifest.json at its root).

Usage: build_xpi.py EXTENSION_DIR OUTPUT_XPI

tests/ is left out. Files are added in sorted order with a fixed timestamp so
the same sources always produce the same archive.
"""

import os
import sys
import zipfile

FIXED_TIME = (2026, 1, 1, 0, 0, 0)
EXCLUDED_DIRS = {"tests", "node_modules", "__pycache__"}


def extension_files(root):
    """Yield (absolute path, archive name) for every packaged file under root."""
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = sorted(d for d in subdirs if d not in EXCLUDED_DIRS and not d.startswith("."))
        for name in sorted(files):
            if name.startswith("."):
                continue
            path = os.path.join(directory, name)
            yield path, os.path.relpath(path, root).replace(os.sep, "/")


def build(root, output):
    """Write the archive atomically and return the number of files packaged."""
    if not os.path.isfile(os.path.join(root, "manifest.json")):
        raise SystemExit(f"No manifest.json in {root}")
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    partial = output + ".partial"
    count = 0
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, name in extension_files(root):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(path, "rb") as stream:
                archive.writestr(info, stream.read())
            count += 1
    os.replace(partial, output)
    return count


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__.strip().splitlines()[2])
    count = build(sys.argv[1], sys.argv[2])
    print(f"Built extension: {sys.argv[2]} ({count} files)")
