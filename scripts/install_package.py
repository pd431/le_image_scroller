#!/usr/bin/env python3
"""Install a quiz package (a .zip exported by the annotator) into this
folder, so it can be hosted as-is and the quiz loads with no import step.

    python3 scripts/install_package.py brain-mri-week-3-quiz-2026-11-19.zip

Writes the package's images and manifest to data/slices/ and its
annotations to quiz/annotations.json. If that would replace a different
stack or different annotations it stops and says so; add --force to go
ahead. The fingerprint is recomputed from the files as written and must
equal the one in the package.
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(__file__))
from lib_manifest import IMAGE_EXTENSIONS, build_manifest, scan_slice_files  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class PackageError(Exception):
    pass


def _unsafe(name):
    """True for an archive member that could land outside its folder."""
    parts = name.replace("\\", "/").split("/")
    return (
        name.startswith(("/", "\\"))
        or (len(name) > 1 and name[1] == ":")
        or any(p in ("..", "") for p in parts)
    )


def read_package(zip_path):
    """Validate the archive and return (manifest, annotations_bytes or None,
    {slice filename: archive member}). Nothing is written."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError) as err:
        raise PackageError(f"{zip_path} is not a zip package: {err}")
    with zf:
        members = [n for n in zf.namelist() if not n.endswith("/")]
        for name in members:
            if _unsafe(name):
                raise PackageError(f"Unsafe path in the package, nothing was written: {name!r}")
        if "manifest.json" not in members:
            raise PackageError("The package has no manifest.json.")
        try:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as err:
            raise PackageError(f"The package's manifest.json is not valid JSON: {err}")
        files = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(files, list) or not files:
            raise PackageError("The package's manifest.json lists no slices.")
        slices = {}
        for name in files:
            if (
                not isinstance(name, str)
                or "/" in name or "\\" in name or name.startswith(".")
                or os.path.splitext(name)[1].lower() not in IMAGE_EXTENSIONS
            ):
                raise PackageError(f"Unusable slice name in the package, nothing was written: {name!r}")
            member = f"slices/{name}"
            if member not in members:
                raise PackageError(f"The package is missing {member}.")
            slices[name] = member
        annotations = zf.read("annotations.json") if "annotations.json" in members else None
        if annotations is not None:
            try:
                json.loads(annotations.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as err:
                raise PackageError(f"The package's annotations.json is not valid JSON: {err}")
    return manifest, annotations, slices


def _existing_state(slices_dir, annotations_path):
    """What is installed now: (datasetHash or None, image count, annotations bytes or None)."""
    current_hash, count = None, 0
    if os.path.isdir(slices_dir):
        count = len(scan_slice_files(slices_dir))
        try:
            with open(os.path.join(slices_dir, "manifest.json")) as f:
                current_hash = json.load(f).get("datasetHash")
        except (OSError, ValueError, AttributeError):
            current_hash = None
    current_ann = None
    if os.path.exists(annotations_path):
        with open(annotations_path, "rb") as f:
            current_ann = f.read()
    return current_hash, count, current_ann


def install(zip_path, root=ROOT, force=False, out=print):
    """Install the package under `root`. Returns the written manifest.
    Raises PackageError when the package is unusable or when installing
    would replace something and `force` is not set."""
    manifest, annotations, slices = read_package(zip_path)
    slices_dir = os.path.join(root, "data", "slices")
    annotations_path = os.path.join(root, "quiz", "annotations.json")

    # Unpack beside the target and fingerprint there, before touching it.
    os.makedirs(os.path.join(root, "data"), exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".slices-incoming-", dir=os.path.join(root, "data"))
    try:
        with zipfile.ZipFile(zip_path) as zf:
            for name, member in slices.items():
                with zf.open(member) as src, open(os.path.join(staging, name), "wb") as dst:
                    shutil.copyfileobj(src, dst)
        overrides = {k: manifest[k] for k in ("name", "size", "axis", "layers") if k in manifest}
        written = build_manifest(staging, overrides)

        if written["files"] != manifest["files"]:
            raise PackageError("The package's slice order doesn't match its filenames; it was not installed.")
        declared = manifest.get("datasetHash")
        if declared and written["datasetHash"] != declared:
            raise PackageError(
                "The images don't match the package's fingerprint (the zip was altered after export); "
                "it was not installed."
            )

        current_hash, current_count, current_ann = _existing_state(slices_dir, annotations_path)
        replacing = []
        if current_count and current_hash != written["datasetHash"]:
            replacing.append(f"the {current_count} image(s) now in {os.path.relpath(slices_dir, root)}")
        if annotations is not None and current_ann is not None and current_ann != annotations:
            replacing.append(os.path.relpath(annotations_path, root))
        if replacing and not force:
            raise PackageError(
                "Installing would replace " + " and ".join(replacing)
                + ". Nothing was changed. Run again with --force to replace them."
            )

        if os.path.isdir(slices_dir):
            shutil.rmtree(slices_dir)
        os.rename(staging, slices_dir)
        staging = None
    finally:
        if staging and os.path.isdir(staging):
            shutil.rmtree(staging)

    if annotations is not None:
        os.makedirs(os.path.dirname(annotations_path), exist_ok=True)
        with open(annotations_path, "wb") as f:
            f.write(annotations)

    out(f"Installed {manifest.get('name') or os.path.basename(zip_path)}:")
    out(f"  {written['sliceCount']} slice(s) -> {os.path.relpath(slices_dir, root)}")
    if annotations is not None:
        out(f"  annotations -> {os.path.relpath(annotations_path, root)}")
    else:
        out("  (the package has no annotations.json; quiz/annotations.json was left as it is)")
    out(f"  fingerprint {written['datasetHash'][:16]}… matches the package")
    return written


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("package", help="the .zip exported with Quiz package in the annotator")
    parser.add_argument("--force", action="store_true", help="replace the stack and annotations already installed")
    args = parser.parse_args(argv)
    try:
        install(args.package, force=args.force)
    except PackageError as err:
        print(err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
