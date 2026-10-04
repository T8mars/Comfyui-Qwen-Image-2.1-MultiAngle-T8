import base64
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch

from PIL import Image
import torch


class NodeOutputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        package = "anyangle_node_output_test"
        root = Path(__file__).parents[1]
        spec = importlib.util.spec_from_file_location(package, root / "__init__.py", submodule_search_locations=[str(root)])
        self.module = importlib.util.module_from_spec(spec)
        paths = ModuleType("folder_paths")
        paths.get_input_directory = lambda: self.directory.name
        routes = ModuleType(package + ".routes")
        routes.register_routes = lambda store: None
        reconstruction = ModuleType(package + ".reconstruction")
        reconstruction.AnyAngleReconstructionOutput = object
        self.modules = patch.dict(sys.modules, {package: self.module, "folder_paths": paths,
                                              routes.__name__: routes, reconstruction.__name__: reconstruction})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        spec.loader.exec_module(self.module)
        image = io.BytesIO()
        Image.new("RGB", (96, 64), (32, 77, 119)).save(image, "PNG")
        self.png = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
        self.scene = {"version": 1, "width": 96, "height": 64, "source": {"kind": "human"},
                      "camera": {"azimuth": 35, "elevation": 17, "zoom": 1, "offsetX": 0, "offsetY": 0},
                      "conditioning": {"model": "base", "guide": "pose", "promptMode": "single", "mapOrigin": "rig"}}

    def test_single_guide_runs_node_without_a_photo_and_disables_lora(self):
        token = self.module.store().save_scene(self.scene, self.png)
        output = self.module.AnyAngleStudio().render(json.dumps(token))["result"]
        self.assertEqual(tuple(output[0].shape), (1, 64, 96, 3))
        self.assertEqual(output[1], self.module.store().load_scene(token)[0]["prompt"])
        self.assertNotIn("<image2>", output[1])
        self.assertEqual(output[3], 0.0)
        self.assertIsNone(json.loads(output[2]).get("reference"))

    def test_edited_rig_ignores_an_old_structure_input_and_keeps_custom_prompt(self):
        self.scene["conditioning"].update(promptMode="custom", customPrompt="  Follow <image3>.\n")
        self.scene["openpose"] = {"origin": "import", "sourceName": "old-photo.png", "useRig": True}
        token = self.module.store().save_scene(self.scene, self.png)
        output = self.module.AnyAngleStudio().render(json.dumps(token), structure_image=torch.ones((1, 64, 96, 3)))["result"]
        self.assertEqual(output[1], "  Follow <image3>.\n")
        self.assertEqual(output[3], 0.0)
        self.assertEqual((output[0][0, 0, 0] * 255).round().to(torch.uint8).tolist(), [32, 77, 119])
