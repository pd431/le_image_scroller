"""Unit tests for the Python helper scripts.

Run: python3 -m unittest discover tests
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import check_contrast  # noqa: E402
import lib_manifest  # noqa: E402


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for name, body in [("a1.svg", "<svg/>"), ("a10.svg", "<svg>10</svg>"), ("a2.png", b"\x89PNG"), ("notes.txt", "x")]:
            mode = "wb" if isinstance(body, bytes) else "w"
            with open(os.path.join(self.dir, name), mode) as f:
                f.write(body)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_natural_sort_and_image_filter(self):
        m = lib_manifest.build_manifest(self.dir)
        self.assertEqual(m["files"], ["a1.svg", "a2.png", "a10.svg"])
        self.assertEqual(m["sliceCount"], 3)

    def test_hashes_present_and_stable(self):
        m1 = lib_manifest.build_manifest(self.dir)
        m2 = lib_manifest.build_manifest(self.dir)
        self.assertEqual(set(m1["fileHashes"]), set(m1["files"]))
        self.assertRegex(m1["datasetHash"], r"^[0-9a-f]{64}$")
        self.assertEqual(m1["datasetHash"], m2["datasetHash"])

    def test_dataset_hash_changes_when_a_slice_changes(self):
        before = lib_manifest.build_manifest(self.dir)["datasetHash"]
        with open(os.path.join(self.dir, "a2.png"), "wb") as f:
            f.write(b"\x89PNG different")
        after_edit = lib_manifest.build_manifest(self.dir)["datasetHash"]
        self.assertNotEqual(before, after_edit)
        os.rename(os.path.join(self.dir, "a10.svg"), os.path.join(self.dir, "a3.svg"))
        after_rename = lib_manifest.build_manifest(self.dir)["datasetHash"]
        self.assertNotEqual(after_edit, after_rename)

    def test_existing_metadata_preserved(self):
        with open(os.path.join(self.dir, "manifest.json"), "w") as f:
            json.dump({"size": 512, "axis": "z", "layers": [{"id": "x", "label": "X"}], "files": ["stale.svg"]}, f)
        m = lib_manifest.build_manifest(self.dir)
        self.assertEqual((m["size"], m["axis"], m["layers"]), (512, "z", [{"id": "x", "label": "X"}]))
        self.assertNotIn("stale.svg", m["files"])


class ContrastTests(unittest.TestCase):
    def test_theme_passes(self):
        self.assertEqual(check_contrast.main([]), 0)

    def test_apca_reference_values(self):
        # Reference pairs from the APCA 0.0.98G-4g documentation.
        black, white = (0, 0, 0, 1), (1, 1, 1, 1)
        self.assertAlmostEqual(check_contrast.apca_lc(black, white), 106.0, delta=0.5)
        self.assertAlmostEqual(check_contrast.apca_lc(white, black), -107.9, delta=0.5)
        grey = check_contrast.parse_colour("#888888")
        self.assertAlmostEqual(check_contrast.apca_lc(grey, white), 63.1, delta=0.5)

    def test_wcag_reference_values(self):
        black, white = (0, 0, 0, 1), (1, 1, 1, 1)
        self.assertAlmostEqual(check_contrast.wcag_ratio(black, white), 21.0, places=2)


if __name__ == "__main__":
    unittest.main()
