import base64
import copy
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib

from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1]))
from storage import StudioStore, BASE_PROMPTS


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = StudioStore(self.directory.name)
        buffer = io.BytesIO()
        Image.new("RGB", (96, 64), (32, 77, 119)).save(buffer, "PNG")
        self.png = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
        self.scene = {"version": 1, "width": 96, "height": 64, "source": {"kind": "human"},
                      "camera": {"azimuth": 45, "elevation": 15, "zoom": 1, "offsetX": 0, "offsetY": 0}}

    def test_applied_scene_survives_new_store_and_preserves_pixels(self):
        token = self.store.save_scene(self.scene, self.png)
        document, data = StudioStore(self.directory.name).load_scene(json.dumps(token))
        self.assertEqual(document["scene"], self.scene)
        self.assertEqual(Image.open(io.BytesIO(data)).getpixel((0, 0)), (32, 77, 119))
        self.assertEqual(self.store.save_scene(self.scene, self.png), token)

    def test_camera_only_revision_keeps_distinct_scene(self):
        first = self.store.save_scene(self.scene, self.png)
        self.scene["camera"]["azimuth"] = 90
        second = self.store.save_scene(self.scene, self.png)
        self.assertNotEqual(first, second)
        self.assertEqual(self.store.load_scene(first)[0]["scene"]["camera"]["azimuth"], 45)

    def test_base_model_structure_modes_change_prompt_and_allow_external_depth(self):
        scene = copy.deepcopy(self.scene)
        scene["source"] = {"kind": "empty"}
        scene["conditioning"] = {"model": "base", "guide": "depth", "map": None}
        with self.assertRaisesRegex(ValueError, "Depth Anything"):
            self.store.save_scene(scene, self.png)
        scene["conditioning"]["map"] = self.store.asset(base64.b64decode(self.png.split(",")[1]), "png")
        token = self.store.save_scene(scene, self.png)
        self.assertEqual(self.store.load_scene(token)[0]["prompt"], BASE_PROMPTS["depth"])
        scene["conditioning"]["guide"] = "canny"
        self.assertEqual(self.store.load_scene(self.store.save_scene(scene, self.png))[0]["prompt"], BASE_PROMPTS["canny"])
        scene["conditioning"]["guide"] = "pose"
        with self.assertRaisesRegex(ValueError, "human mannequin"):
            self.store.save_scene(scene, self.png)

    def test_unknown_guide_or_model_is_rejected(self):
        scene = copy.deepcopy(self.scene)
        scene["conditioning"] = {"model": "other", "guide": "coarse"}
        with self.assertRaisesRegex(ValueError, "Unknown model"):
            self.store.save_scene(scene, self.png)

    def test_missing_and_corrupted_guide_fail(self):
        token = self.store.save_scene(self.scene, self.png)
        document, _ = self.store.load_scene(token)
        path = self.store.path(document["guide"]["name"])
        path.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.store.load_scene(token)
        path.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            self.store.load_scene(token)

    def test_path_escape_rejected(self):
        for name in ("../private.png", "C:/secret.png", "a" * 64 + ".png/../x", "\\server\\share"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.store.path(name)

    def test_wrong_capture_size_and_nonfinite_camera_rejected(self):
        scene = copy.deepcopy(self.scene)
        scene["width"] = 128
        with self.assertRaisesRegex(ValueError, "dimensions"):
            self.store.save_scene(scene, self.png)
        scene = copy.deepcopy(self.scene)
        scene["camera"]["azimuth"] = float("nan")
        with self.assertRaisesRegex(ValueError, "camera"):
            self.store.save_scene(scene, self.png)

    def test_glb_external_resources_rejected(self):
        raw = json.dumps({"asset": {"version": "2.0"}, "images": [{"uri": "https://example.org/private.png"}]}).encode()
        raw += b" " * (-len(raw) % 4)
        glb = struct.pack("<4sII", b"glTF", 2, 20 + len(raw)) + struct.pack("<I4s", len(raw), b"JSON") + raw
        with self.assertRaisesRegex(ValueError, "embed"):
            self.store.asset(glb, "glb")

    def test_malformed_glb_resources_are_user_errors(self):
        for invalid in ({"asset": {"version": "2.0"}, "images": None},
                        {"asset": {"version": "2.0"}, "extensionsRequired": None}):
            raw = json.dumps(invalid).encode()
            raw += b" " * (-len(raw) % 4)
            glb = struct.pack("<4sII", b"glTF", 2, 20 + len(raw)) + struct.pack("<I4s", len(raw), b"JSON") + raw
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.asset(glb, "glb")

    def test_malformed_scene_assets_and_base64_are_user_errors(self):
        source = self.store.asset(base64.b64decode(self.png.split(",")[1]), "png")
        scene = copy.deepcopy(self.scene)
        scene["source"] = {**source, "kind": "glb"}
        with self.assertRaisesRegex(ValueError, "format"):
            self.store.save_scene(scene, self.png)
        scene["source"] = {"kind": "human"}
        scene["reference"] = {"name": source["name"]}
        with self.assertRaisesRegex(ValueError, "valid PNG"):
            self.store.save_scene(scene, "data:image/png;base64,???")

    def test_oversized_png_is_rejected_before_decode(self):
        def chunk(kind, payload):
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

        for width, height in ((8000, 5000), (20000, 10000)):
            header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
            png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IEND", b"")
            with self.subTest(size=(width, height)), self.assertRaisesRegex(ValueError, "32 megapixels"):
                self.store.asset(png, "png")

    def test_gaussian_asset_roundtrip_and_reference_binding(self):
        fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
                  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
        header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\n'
        header += ''.join(f'property float {field}\n' for field in fields) + 'end_header\n'
        ply = header.encode() + struct.pack('<14f', *([0] * 14))
        asset = self.store.asset(ply, 'ply')
        self.assertEqual(self.store.read_asset(asset['name']), ply)
        with self.assertRaisesRegex(ValueError, 'record lengths'):
            self.store.asset(ply[:-4], 'ply')
        reference = self.store.asset(base64.b64decode(self.png.split(',')[1]), 'png')
        self.scene['reference'] = reference
        self.scene['source'] = {**asset, 'kind': 'splat', 'reference': reference,
                                'camera_token': [1, 0, 0, 0, .75]}
        token = self.store.save_scene(self.scene, self.png)
        self.assertEqual(self.store.load_scene(token)[0]['scene']['source']['camera_token'], [1, 0, 0, 0, .75])
        self.scene['reference'] = {'name': 'a' * 64 + '.png'}
        with self.assertRaisesRegex(ValueError, '不一致'):
            self.store.save_scene(self.scene, self.png)


if __name__ == "__main__":
    unittest.main()
