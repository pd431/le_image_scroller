"""Shared helper: scan data/slices/ for image files and (re)write
manifest.json from whatever is actually there, sorted naturally (the
way a person reading filenames alphabetically-with-numbers would
expect, e.g. abc1 < abc2 < abc10, zero-padded or not).

Used by both generate_slices.py (the apple sample dataset) and
build_manifest.py (for rebuilding the index after manually adding,
removing, or renaming images in the folder).
"""

import json
import os
import re

IMAGE_EXTENSIONS = {".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"}

DEFAULTS = {"size": 400, "axis": "", "layers": []}

_NUMBER_RUN = re.compile(r"(\d+)")


def _natural_sort_key(name):
    """Split into text/number chunks so digit runs compare as integers
    (abc2 < abc10) instead of as strings (abc10 < abc2), while text
    chunks still compare case-insensitively. re.split with a single
    capture group always alternates text, digits, text, digits, ...,
    so a given position is consistently str or consistently int across
    every filename - safe to compare without type errors."""
    return [
        int(chunk) if chunk.isdigit() else chunk.lower()
        for chunk in _NUMBER_RUN.split(name)
    ]


def scan_slice_files(slices_dir):
    """Image filenames in slices_dir, naturally sorted (see
    _natural_sort_key) - "abc1.jpg, abc2.jpg, ..., abc10.jpg" sorts in
    that numeric order with no need to zero-pad."""
    names = [
        f for f in os.listdir(slices_dir)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS
    ]
    return sorted(names, key=_natural_sort_key)


def build_manifest(slices_dir, overrides=None):
    """Scan slices_dir and write manifest.json there. size/axis/layers
    are preserved from any existing manifest.json unless overridden;
    sliceCount/files always reflect the current directory contents."""
    manifest_path = os.path.join(slices_dir, "manifest.json")
    overrides = overrides or {}

    existing = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            try:
                existing = json.load(f)
            except json.JSONDecodeError:
                existing = {}

    files = scan_slice_files(slices_dir)

    manifest = {
        "size": overrides.get("size", existing.get("size", DEFAULTS["size"])),
        "sliceCount": len(files),
        "axis": overrides.get("axis", existing.get("axis", DEFAULTS["axis"])),
        "layers": overrides.get("layers", existing.get("layers", DEFAULTS["layers"])),
        "files": files,
    }

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    return manifest
