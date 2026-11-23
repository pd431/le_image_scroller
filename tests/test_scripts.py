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


class ServeTests(unittest.TestCase):
    def test_port_fallback_and_read_only(self):
        import http.client
        import threading

        import serve

        first = serve.make_server(0, root=ROOT)
        port = first.server_address[1]
        # The port is taken, so the next server lands on a later one.
        second = serve.make_server(port, root=ROOT)
        try:
            self.assertGreater(second.server_address[1], port)
            thread = threading.Thread(target=second.serve_forever, daemon=True)
            thread.start()
            conn = http.client.HTTPConnection("127.0.0.1", second.server_address[1], timeout=5)
            conn.request("GET", "/index.html")
            res = conn.getresponse()
            body = res.read()
            self.assertEqual(res.status, 200)
            self.assertIn(b"Radiology Scanner", body)
            self.assertEqual(res.getheader("Cache-Control"), "no-store")
            for method in ("POST", "PUT", "DELETE"):
                conn = http.client.HTTPConnection("127.0.0.1", second.server_address[1], timeout=5)
                conn.request(method, "/data/slices/evil.svg", body=b"x")
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 405, method)
            self.assertFalse(os.path.exists(os.path.join(ROOT, "data", "slices", "evil.svg")))
        finally:
            second.shutdown()
            second.server_close()
            first.server_close()


class InstallPackageTests(unittest.TestCase):
    def setUp(self):
        import zipfile

        self.zipfile = zipfile
        self.root = tempfile.mkdtemp()
        self.work = tempfile.mkdtemp()
        # A package built the way the browser builds one.
        src = os.path.join(self.work, "src")
        os.makedirs(src)
        self.images = {"knee-2.png": b"\x89PNG two", "knee-10.png": b"\x89PNG ten", "knee-1.png": b"\x89PNG one"}
        for name, body in self.images.items():
            with open(os.path.join(src, name), "wb") as f:
                f.write(body)
        self.manifest = lib_manifest.build_manifest(src, {"name": "Knee", "size": 512})
        self.annotations = json.dumps({"version": 3, "exportMode": "quiz", "datasetHash": self.manifest["datasetHash"], "annotations": []})
        self.package = self.make_zip("knee.zip")

    def tearDown(self):
        shutil.rmtree(self.root)
        shutil.rmtree(self.work)

    def make_zip(self, name, manifest=None, images=None, extra=None, annotations=True):
        path = os.path.join(self.work, name)
        with self.zipfile.ZipFile(path, "w") as z:
            z.writestr("manifest.json", json.dumps(manifest or self.manifest))
            for fname, body in (images or self.images).items():
                z.writestr(f"slices/{fname}", body)
            if annotations:
                z.writestr("annotations.json", self.annotations)
            for fname, body in (extra or {}).items():
                z.writestr(fname, body)
        return path

    def installed(self):
        with open(os.path.join(self.root, "data", "slices", "manifest.json")) as f:
            return json.load(f)

    def test_install_into_empty_folder_matches_fingerprint(self):
        import install_package

        lines = []
        written = install_package.install(self.package, root=self.root, out=lines.append)
        self.assertEqual(written["datasetHash"], self.manifest["datasetHash"])
        m = self.installed()
        self.assertEqual(m["files"], ["knee-1.png", "knee-2.png", "knee-10.png"])
        self.assertEqual((m["name"], m["size"]), ("Knee", 512))
        with open(os.path.join(self.root, "quiz", "annotations.json")) as f:
            self.assertEqual(f.read(), self.annotations)
        self.assertTrue(any("3 slice(s)" in line for line in lines))
        # Installing the same package again changes nothing and needs no --force.
        install_package.install(self.package, root=self.root, out=lines.append)

    def test_refuses_to_replace_without_force(self):
        import install_package

        install_package.install(self.package, root=self.root, out=lambda *_: None)
        other_images = {"scan-1.png": b"\x89PNG other"}
        src = os.path.join(self.work, "other")
        os.makedirs(src)
        with open(os.path.join(src, "scan-1.png"), "wb") as f:
            f.write(other_images["scan-1.png"])
        other = self.make_zip("other.zip", manifest=lib_manifest.build_manifest(src), images=other_images)
        with self.assertRaises(install_package.PackageError) as ctx:
            install_package.install(other, root=self.root, out=lambda *_: None)
        self.assertIn("--force", str(ctx.exception))
        self.assertIn("3 image(s)", str(ctx.exception))
        self.assertEqual(self.installed()["sliceCount"], 3)
        self.assertEqual(os.listdir(os.path.join(self.root, "data")), ["slices"])
        install_package.install(other, root=self.root, force=True, out=lambda *_: None)
        self.assertEqual(self.installed()["files"], ["scan-1.png"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "data", "slices", "knee-1.png")))

    def test_rejects_unsafe_paths_and_writes_nothing(self):
        import install_package

        for bad in ("../evil.png", "/abs/evil.png", "slices/../../evil.png"):
            pkg = self.make_zip("bad.zip", extra={bad: b"x"})
            with self.assertRaises(install_package.PackageError) as ctx:
                install_package.install(pkg, root=self.root, out=lambda *_: None)
            self.assertIn("Unsafe path", str(ctx.exception))
        manifest = dict(self.manifest, files=["../knee-1.png"])
        with self.assertRaises(install_package.PackageError):
            install_package.install(self.make_zip("bad2.zip", manifest=manifest), root=self.root, out=lambda *_: None)
        self.assertFalse(os.path.exists(os.path.join(self.root, "data", "slices")))
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.root), "evil.png")))

    def test_rejects_altered_images_and_non_packages(self):
        import install_package

        altered = self.make_zip("altered.zip", images=dict(self.images, **{"knee-2.png": b"swapped"}))
        with self.assertRaises(install_package.PackageError) as ctx:
            install_package.install(altered, root=self.root, out=lambda *_: None)
        self.assertIn("fingerprint", str(ctx.exception))
        self.assertFalse(os.path.exists(os.path.join(self.root, "data", "slices")))
        not_zip = os.path.join(self.work, "x.zip")
        with open(not_zip, "w") as f:
            f.write("nope")
        with self.assertRaises(install_package.PackageError):
            install_package.install(not_zip, root=self.root, out=lambda *_: None)


if __name__ == "__main__":
    unittest.main()
