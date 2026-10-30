#!/usr/bin/env python3
"""Rebuild data/slices/manifest.json from whatever image files are
actually sitting in data/slices/.

Drop images in (.svg, .png, .jpg, .jpeg, .gif, .webp - names can have
spaces), run this, and they become the slice list, naturally sorted
by filename (abc2.jpg before abc10.jpg, zero-padded or not). Existing
size/axis/layers metadata in manifest.json is left as-is; only the
file list is refreshed from the directory.

Run: python3 scripts/build_manifest.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib_manifest import build_manifest  # noqa: E402

SLICES_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "slices")


def main():
    if not os.path.isdir(SLICES_DIR):
        print(f"No such directory: {os.path.abspath(SLICES_DIR)}")
        raise SystemExit(1)

    manifest = build_manifest(SLICES_DIR)
    print(f"manifest.json now lists {manifest['sliceCount']} image(s) from {os.path.abspath(SLICES_DIR)}:")
    for name in manifest["files"]:
        print(f"  - {name}")


if __name__ == "__main__":
    main()
