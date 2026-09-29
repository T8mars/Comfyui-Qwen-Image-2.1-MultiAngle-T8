"""Exercise reconstruction metadata without loading GPU checkpoints."""
import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import torch
import torch.nn.functional as F


ROOT = Path(__file__).resolve().parents[1]


def load_reconstruction(input_dir):
    package = types.ModuleType("anyangle_reconstruction_test")
    package.__path__ = [str(ROOT)]
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_input_directory = lambda: str(input_dir)
    folder_paths.get_full_path = lambda _category, _name: None
    comfy = types.ModuleType("comfy")
    comfy.__path__ = []
    utils = types.ModuleType("comfy.utils")
    utils.common_upscale = lambda image, width, height, _method, _crop: F.interpolate(
        image, size=(height, width), mode="bilinear", align_corners=False)
    comfy.utils = utils
    extras = types.ModuleType("comfy_extras")
    extras.__path__ = []
    exporter = types.ModuleType("comfy_extras.nodes_gaussian_splat")

    def ply_bytes(positions, _scales, _rotations, _opacities, _sh):
        fields = ("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                  "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")
        header = "ply\nformat binary_little_endian 1.0\nelement vertex 1\n"
        header += "".join(f"property float {name}\n" for name in fields) + "end_header\n"
        return header.encode() + struct.pack("<14f", *positions[0].tolist(), *([0] * 11))

    exporter._gaussian_ply_bytes = ply_bytes
    modules = {"anyangle_reconstruction_test": package, "folder_paths": folder_paths,
               "comfy": comfy, "comfy.utils": utils, "comfy_extras": extras,
               "comfy_extras.nodes_gaussian_splat": exporter}
    spec = importlib.util.spec_from_file_location("anyangle_reconstruction_test.reconstruction", ROOT / "reconstruction.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


class ReconstructionOutputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.module = load_reconstruction(self.directory.name)
        self.folder_patch = patch.object(self.module.folder_paths, "get_input_directory", return_value=self.directory.name)
        self.folder_patch.start()
        self.addCleanup(self.folder_patch.stop)

    def save(self, mask, count=None, token=None, position=None):
        splat = types.SimpleNamespace(
            positions=torch.tensor([[position or [1.0, 2.0, 3.0]]]),
            counts=torch.tensor([count]) if count is not None else None,
            scales=torch.ones(1, 1, 3), rotations=torch.ones(1, 1, 4),
            opacities=torch.ones(1, 1, 1), sh=torch.zeros(1, 1, 1, 3))
        token = token or [1.0, 0.0, 0.0, 0.0, 0.75]
        samples = {"samples": types.SimpleNamespace(unbind=lambda: (
            torch.zeros(1), torch.tensor([[token]])))}
        reference = torch.zeros(1, 1024, 1024, 3)
        prepared = torch.zeros(1, 4, 4, 3)
        return self.module.AnyAngleReconstructionOutput().save(splat, samples, reference, prepared, mask)

    def test_single_pixel_foreground_survives_crop_metadata(self):
        mask = torch.zeros(1, 1024, 1024)
        mask[0, 400, 500] = 1
        result = self.save(mask)
        source = result["ui"]["anyangle_reconstruction"][0]["source"]
        self.assertEqual(source["foreground_bbox"], [500, 400, 501, 401])
        self.assertGreater(source["crop"][2] - source["crop"][0], 0)
        self.assertGreater(source["crop"][3] - source["crop"][1], 0)

    def test_empty_foreground_has_actionable_error(self):
        with self.assertRaisesRegex(ValueError, "foreground mask is empty"):
            self.save(torch.zeros(1, 1024, 1024))
        self.assertEqual(list((Path(self.directory.name) / "anyangle_studio").glob("*.ply")), [])

    def test_empty_splat_and_invalid_camera_token_fail_before_writing(self):
        mask = torch.ones(1, 1024, 1024)
        with self.assertRaisesRegex(ValueError, "no valid gaussians"):
            self.save(mask, count=0)
        for token in ([1.0, 0.0, float("nan"), 0.0, 0.75],
                      [0.0, 0.0, 0.0, 0.0, 0.75],
                      [1.0, 0.0, 0.0, 0.0, 0.0]):
            with self.subTest(token=token), self.assertRaisesRegex(ValueError, "camera token is invalid"):
                self.save(mask, token=token)
        with self.assertRaisesRegex(ValueError, "non-finite positions"):
            self.save(mask, position=[1.0, float("inf"), 3.0])
        self.assertEqual(list((Path(self.directory.name) / "anyangle_studio").glob("*.ply")), [])


if __name__ == "__main__":
    unittest.main()
