"""A fresh GitHub checkout must include everything needed to open the editor."""
import hashlib
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BundledAssetsTests(unittest.TestCase):
    def test_editor_assets_match_the_pinned_manifest(self):
        manifest = json.loads((ROOT / "assets-manifest.json").read_text(encoding="utf-8"))
        for entry in manifest["editor"]:
            path = ROOT / entry["path"]
            with self.subTest(path=entry["path"]):
                self.assertTrue(path.is_file(), f"Missing editor asset: {path}")
                digest = hashlib.sha256()
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                        digest.update(chunk)
                self.assertEqual(digest.hexdigest(), entry["sha256"])


if __name__ == "__main__":
    unittest.main()
