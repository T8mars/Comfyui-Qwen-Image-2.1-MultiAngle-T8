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

sys.path.insert(0, str(Path(__file__).parents[3]))
from comfy_api.latest import io as comfy_io
from comfy_api.latest import _io
from comfy_extras.nodes_qwen import TextEncodeQwenImage21
from test_multiperson import scene_for
from test_reference_library import library_scene, reference


class NodeOutputTests(unittest.TestCase):
    def test_batch_text_and_combo_readers_preserve_values_with_matching_socket_types(self):
        from comfy_execution.validation import validate_node_input
        for reader, input_type, value in ((self.module.AnyAngleTextRead, "STRING", "  raw <image3>\n"),
                                          (self.module.AnyAnglePromptModeRead, "COMBO", "input-full")):
            schema = reader.GET_SCHEMA()
            self.assertTrue(schema.is_output_node)
            self.assertTrue(schema.is_dev_only)
            self.assertTrue(validate_node_input(input_type, schema.inputs[0].get_io_type()))
            self.assertEqual(reader.execute(value).ui["anyangle_text"], [value])

    def test_generic_encoder_preserves_full_prompt_negative_no_guide_and_first_dimensions(self):
        scene = library_scene()
        asset = self.module.image_asset(torch.ones((1, 79, 141, 3)))
        scene["referenceLibrary"]["items"] = [reference(asset)]
        token = self.module.store().save_scene(scene)
        studio = self.module.AnyAngleStudio().render(json.dumps(token))["result"]
        self.assertIsNone(studio[0])
        class Clip:
            def __init__(self): self.calls = []
            def tokenize(self, text, **kwargs): self.calls.append((text, kwargs)); return text
            def encode_from_tokens_scheduled(self, _): return [[torch.zeros((1, 1, 1)), {}]]
        class Vae:
            def __init__(self): self.images = []
            def encode(self, image): self.images.append(image.clone()); return torch.zeros((1, 64, image.shape[1] // 16, image.shape[2] // 16))
        for text in ("  custom <image1>\n", ""):
            clip, vae = Clip(), Vae()
            with patch("comfy.model_management.intermediate_device", return_value=torch.device("cpu")):
                encoded = self.module.AnyAngleMultiPersonEncode.execute(clip, vae, studio[2], prompt=text,
                    negative_prompt="negative user text", prompt_mode="input-full")
            self.assertEqual(clip.calls[0][0], text)
            self.assertEqual(clip.calls[1][0], "negative user text")
            self.assertEqual(encoded.ui["anyangle_encoding"][0]["width"], 128)
            self.assertEqual(encoded.ui["anyangle_encoding"][0]["height"], 64)
            self.assertEqual(len(vae.images), 1)
        clip, vae = Clip(), Vae()
        with patch("comfy.model_management.intermediate_device", return_value=torch.device("cpu")):
            self.module.AnyAngleMultiPersonEncode.execute(clip, vae, studio[2], prompt="extra")
        self.assertEqual(clip.calls[0][0], studio[1] + "\nextra")

    def test_connected_reference_batch_is_explicit_and_disconnect_requires_saved_version(self):
        images = torch.stack([torch.zeros((64, 96, 3)), torch.ones((64, 96, 3))])
        read = self.module.AnyAngleReferenceRead.execute(images).ui["anyangle_reference_batch"][0]
        self.assertEqual(read["batchCount"], 2)
        self.assertNotEqual(read["assets"][0]["name"], read["assets"][1]["name"])
        scene = library_scene()
        item = reference(read["assets"][1])
        item.update(inputKey="actor_reference_1", batchIndex=1)
        scene["referenceLibrary"]["items"] = [item]
        token = self.module.store().save_scene(scene)
        with self.assertRaisesRegex(ValueError, "缺少参考连线"):
            self.module.AnyAngleStudio().render(json.dumps(token))
        studio = self.module.AnyAngleStudio().render(json.dumps(token), actor_references={"actor_reference_1": images})["result"]
        self.assertEqual(json.loads(studio[2])["referenceLibrary"]["items"][0]["asset"]["name"], read["assets"][1]["name"])

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

    def test_scene_depth_keeps_its_saved_capture_with_an_old_structure_connection(self):
        self.scene["conditioning"].update(guide="depth", mapOrigin="scene")
        token = self.module.store().save_scene(self.scene, self.png)
        output = self.module.AnyAngleStudio().render(json.dumps(token), structure_image=torch.ones((1, 64, 96, 3)))["result"]
        self.assertIn("spatial depth", output[1])
        self.assertEqual((output[0][0, 0, 0] * 255).round().to(torch.uint8).tolist(), [32, 77, 119])

    def test_json_and_keypoints_guides_ignore_an_unselected_old_structure_connection(self):
        for origin in ("json", "keypoints"):
            self.scene["openpose"] = {"origin": origin, "sourceName": "old-photo.png", "useRig": False}
            token = self.module.store().save_scene(self.scene, self.png)
            output = self.module.AnyAngleStudio().render(json.dumps(token), structure_image=torch.ones((1, 64, 96, 3)))["result"]
            self.assertEqual((output[0][0, 0, 0] * 255).round().to(torch.uint8).tolist(), [32, 77, 119])

    def test_pose_read_output_node_reads_keypoints_without_a_studio_snapshot(self):
        keypoints = [{"canvas_width": 96, "canvas_height": 64, "people": [{
            "pose_keypoints_2d": [value for index in range(18) for value in (20, 20 + index, .9)]}]}]
        schema = self.module.AnyAnglePoseRead.GET_SCHEMA()
        self.assertTrue(schema.is_output_node)
        self.assertTrue(schema.is_dev_only)
        self.assertEqual(schema.outputs, [])
        read = self.module.AnyAnglePoseRead.execute(keypoints)
        self.assertIsNone(read.result)
        metadata = read.ui["anyangle_pose_people"][0]
        self.assertEqual(len(metadata["people"]), 1)
        self.assertEqual(len(metadata["signature"]), 64)
        self.module.store().read_asset(metadata["asset"]["name"])

    def test_changed_keypoints_require_reapply_only_for_the_static_pose_guide(self):
        keypoints = [{"canvas_width": 96, "canvas_height": 64, "people": [{
            "pose_keypoints_2d": [value for index in range(18) for value in (20, 20 + index, .9)]}]}]
        self.scene["openpose"] = {"origin": "keypoints", "inputSignature": "0" * 64, "useRig": False}
        token = self.module.store().save_scene(self.scene, self.png)
        with self.assertRaisesRegex(ValueError, "关键点已变化"):
            self.module.AnyAngleStudio().render(json.dumps(token), pose_keypoints=keypoints)
        self.scene["openpose"]["useRig"] = True
        token = self.module.store().save_scene(self.scene, self.png)
        self.module.AnyAngleStudio().render(json.dumps(token), pose_keypoints=keypoints)
        self.scene["conditioning"].update(guide="coarse")
        self.scene["openpose"]["useRig"] = False
        token = self.module.store().save_scene(self.scene, self.png)
        self.module.AnyAngleStudio().render(json.dumps(token), pose_keypoints=keypoints)

    def test_v3_schema_preserves_legacy_inputs_outputs_and_autogrow_zero_minimum(self):
        schema = self.module.AnyAngleStudio.GET_SCHEMA()
        self.assertEqual(schema.node_id, "AnyAngleStudioT8")
        self.assertEqual(list(self.module.AnyAngleStudio.RETURN_TYPES), ["IMAGE", "STRING", "STRING", "FLOAT"])
        self.assertEqual(list(self.module.AnyAngleStudio.RETURN_NAMES), ["guide_image_2", "prompt", "scene_json", "anyangle_lora_strength"])
        inputs = {item.id: item for item in schema.inputs}
        self.assertTrue(inputs["reference_image"].optional)
        self.assertTrue(inputs["structure_image"].optional)
        self.assertEqual(inputs["actor_references"].template.min, 0)

    def test_actor_socket_binding_updates_the_same_manifest_and_prompt(self):
        scene = scene_for()
        token = self.module.store().save_scene(scene, self.png)
        refs = {"actor_reference_1": torch.zeros((1, 64, 96, 3)), "actor_reference_3": torch.ones((1, 64, 96, 3))}
        output = self.module.AnyAngleStudio().render(json.dumps(token), actor_references=refs)["result"]
        actual = json.loads(output[2])
        self.assertEqual(actual["resolvedPrompt"], output[1])
        self.assertEqual(actual["manifest"]["imageCount"], 3)
        self.assertIn("<image3>", output[1])
        self.assertNotIn("<image4>", output[1])
        self.assertEqual(actual["actors"][1]["identity"]["description"], "character 1")

    def test_real_v3_flattened_autogrow_inputs_normalize_to_actor_bindings(self):
        token = self.module.store().save_scene(scene_for(2), self.png)
        flat = {"snapshot": json.dumps(token), "actor_references.actor_reference_1": torch.zeros((1, 64, 96, 3)),
                "actor_references.actor_reference_2": torch.ones((1, 64, 96, 3))}
        schema, _, dynamic = _io.get_finalized_class_inputs(self.module.AnyAngleStudio.INPUT_TYPES(), flat)
        self.assertIn("actor_references.actor_reference_1", schema["optional"])
        nested = _io.build_nested_inputs(flat, dynamic)
        self.assertEqual(set(nested["actor_references"]), {"actor_reference_1", "actor_reference_2"})
        output = self.module.AnyAngleStudio.EXECUTE_NORMALIZED(**nested)
        scene = json.loads(output.result[2])
        self.assertEqual(len(output.result), 4)
        self.assertEqual(scene["manifest"]["imageCount"], 3)
        self.assertEqual(len(output.ui["anyangle_actor_references"]), 2)

    def test_native_validation_accepts_the_empty_autogrow_container(self):
        token = self.module.store().save_scene(scene_for(2), self.png)
        flat = {"snapshot": json.dumps(token)}
        _, _, dynamic = _io.get_finalized_class_inputs(self.module.AnyAngleStudio.INPUT_TYPES(), flat)
        nested = _io.build_nested_inputs(flat, dynamic)
        self.assertIn("actor_references", nested)
        self.assertTrue(self.module.AnyAngleStudio.validate_inputs(**nested))
        nested["snapshot"] = ""
        self.assertIsInstance(self.module.AnyAngleStudio.validate_inputs(**nested), str)

    def test_thin_encoder_calls_real_native_cpu_encoder_and_retains_its_latent(self):
        scene = scene_for(2)
        token = self.module.store().save_scene(scene, self.png)
        studio = self.module.AnyAngleStudio().render(json.dumps(token), actor_references={
            "actor_reference_1": torch.zeros((1, 80, 48, 3)), "actor_reference_2": torch.ones((1, 80, 48, 3))})["result"]
        class Clip:
            def __init__(self): self.calls = []
            def tokenize(self, prompt, **kwargs):
                self.calls.append((prompt, kwargs)); return prompt
            def encode_from_tokens_scheduled(self, _):
                return [[torch.zeros((1, 1, 1)), {}]]
        class Vae:
            def __init__(self): self.images = []
            def encode(self, image):
                self.images.append(image.clone()); return torch.zeros((1, 64, image.shape[1] // 16, image.shape[2] // 16))
        clip, vae = Clip(), Vae()
        with patch("comfy.model_management.intermediate_device", return_value=torch.device("cpu")):
            encoded = self.module.AnyAngleMultiPersonEncode.execute(clip, vae, studio[2], studio[0], 64)
        self.assertEqual(tuple(encoded.result[2]["samples"].shape), (1, 64, 4, 6))
        self.assertEqual(len(vae.images), 3)
        self.assertEqual(clip.calls[0][0], studio[1])
        self.assertEqual(len(encoded.result[0][0][1]["reference_latents"]), 3)
        self.assertEqual(vae.images[0].shape, studio[0].shape)
        self.assertEqual(float(vae.images[1].mean()), 0)
        self.assertEqual(float(vae.images[2].mean()), 1)
        reordered = json.loads(studio[2])
        reordered["conditioning"]["imageOrder"] = "reference-first"
        reordered["resolvedPrompt"] = self.module.prompt_for(reordered)
        clip, vae = Clip(), Vae()
        with patch("comfy.model_management.intermediate_device", return_value=torch.device("cpu")):
            encoded = self.module.AnyAngleMultiPersonEncode.execute(clip, vae, json.dumps(reordered), studio[0], 64)
        self.assertEqual(tuple(encoded.result[2]["samples"].shape), (1, 64, 6, 4))
        self.assertEqual(float(vae.images[0].mean()), 0)
        metadata = encoded.ui["anyangle_encoding"][0]
        self.assertEqual((metadata["width"], metadata["height"]), (64, 96))
        self.assertEqual(metadata["manifest"]["guide"]["index"], 3)
        self.assertIn("<image3>", metadata["prompt"])
