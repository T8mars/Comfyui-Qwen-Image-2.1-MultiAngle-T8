import base64
import copy
import io
import json
from pathlib import Path
import sys
import struct
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1]))
from multiperson import canonical_scene, build_manifest, actor_prompt, number_text
from storage import StudioStore, prompt_for
import dwpose
import storage


def scene_for(count=3):
    return {"version": 2, "width": 96, "height": 64, "source": {"kind": "human"},
            "camera": {"azimuth": 35, "elevation": 8, "zoom": 1.3, "offsetX": 0, "offsetY": 0},
            "cameraTarget": [0, 10, 0], "actors": [{"id": f"actor-{index}", "label": f"角色 {index}",
                "transform": {"x": index * 3, "y": 0, "z": 0, "scale": 1, "yaw": index * 5},
                "pose": {"bones": {"head": [0, index * 10, 0]}, "modelRotation": [0, 15, 0]},
                "identity": {"inputKey": f"actor_reference_{index + 1}", "description": f"character {index}"}}
                for index in range(count)],
            "conditioning": {"model": "base", "guide": "pose", "identityMode": "actors", "imageOrder": "guide-first"}}


def image_data(color="gray"):
    buffer = io.BytesIO(); Image.new("RGB", (96, 64), color).save(buffer, "PNG")
    return buffer.getvalue()


class MultiPersonTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = StudioStore(self.directory.name)
        self.scene = canonical_scene(scene_for())
        for actor, color in zip(self.scene["actors"], ("red", "green", "blue")):
            actor["identity"]["asset"] = self.store.asset(image_data(color), "png")
        self.png = "data:image/png;base64," + base64.b64encode(image_data()).decode()

    def test_reordering_deleting_and_hidden_actors_keep_identity_hashes(self):
        before = build_manifest(self.scene)
        self.scene["actors"] = [self.scene["actors"][2], self.scene["actors"][0]]
        after = build_manifest(self.scene)
        refs_before = {actor["id"]: before["references"][actor["referenceIndex"] - 2]["asset"]["name"] for actor in before["actors"]}
        refs_after = {actor["id"]: after["references"][actor["referenceIndex"] - 2]["asset"]["name"] for actor in after["actors"]}
        self.assertEqual(refs_after, {key: refs_before[key] for key in refs_after})
        self.scene["actors"][0]["visible"] = False
        self.assertEqual([actor["id"] for actor in build_manifest(self.scene)["actors"]], ["actor-0"])

    def test_shared_reference_is_encoded_once_without_losing_people(self):
        shared = self.scene["actors"][0]["identity"]["asset"]
        for index, actor in enumerate(self.scene["actors"]):
            actor["identity"].update(asset=shared, sourcePerson={"description": f"person {index} in the source"})
        manifest = build_manifest(self.scene)
        self.assertEqual(manifest["imageCount"], 2)
        self.assertEqual([actor["referenceIndex"] for actor in manifest["actors"]], [2, 2, 2])
        self.assertIn("person 2 in the source", actor_prompt(self.scene, manifest))

    def test_shared_photo_selected_regions_match_the_frontend_contract(self):
        path = Path(__file__).parent / "fixtures" / "multiperson-contract.json"
        scene = json.loads(path.read_text(encoding="utf-8"))
        manifest = build_manifest(scene)
        self.assertEqual(manifest, scene["manifest"])
        self.assertEqual(actor_prompt(scene, manifest), scene["resolvedPrompt"])
        self.assertEqual(manifest["references"][0]["actorIds"], ["actor-0", "actor-1"])
        self.assertEqual(manifest["actors"][0]["referenceIndex"], manifest["actors"][1]["referenceIndex"])
        self.assertIn("person 1 in the source photo; selected source pixel region [80, 40, 280, 400] in a 640 x 480 image "
                      "(normalized region [0.125, 0.083333, 0.4375, 0.833333])", scene["resolvedPrompt"])

    def test_region_keeps_description_without_dimensions_and_rounds_normalized_values(self):
        person = self.scene["actors"][0]["identity"]
        person["sourcePerson"] = {"description": "left person", "bbox": [1, 2, 3.25, 4.5]}
        self.assertIn("left person; selected source pixel region [1, 2, 3.25, 4.5] from <image2>", prompt_for(self.scene))
        person["sourcePerson"] = {"bbox": [-.5, -1, 5, 7], "canvasWidth": 3, "canvasHeight": 7}
        self.assertIn("normalized region [-0.166667, -0.142857, 1.666667, 1]", prompt_for(self.scene))

    def test_photo_and_text_identities_have_no_phantom_image_slots(self):
        self.scene["actors"][1]["identity"]["asset"] = None
        prompt = prompt_for(self.scene)
        self.assertEqual(build_manifest(self.scene)["imageCount"], 3)
        self.assertNotIn("<image4>", prompt)
        self.assertIn("character 1", prompt)
        self.scene["conditioning"]["promptMode"] = "custom"
        self.scene["conditioning"]["customPrompt"] = "  My <image7>\n"
        self.assertEqual(prompt_for(self.scene), "  My <image7>\n")

    def test_prompt_numbers_keep_editor_precision_and_javascript_exponent_format(self):
        cases = [(1.23456789, "1.23456789"), (1.0, "1"), (-0.0, "0"), (1e-7, "1e-7"),
                 (1e-6, "0.000001"), (1e20, "100000000000000000000"), (1e21, "1e+21")]
        for value, text in cases:
            self.assertEqual(number_text(value), text)
        self.scene["actors"][0]["transform"]["x"] = 1.23456789
        self.scene["actors"][0]["identity"]["sourcePerson"] = {"bbox": [1.0, 2.0, 3.25, 4.5]}
        prompt = prompt_for(self.scene)
        self.assertIn("world position (1.23456789, 0, 0)", prompt)
        self.assertIn("region [1, 2, 3.25, 4.5]", prompt)

    def test_more_than_nine_actors_is_not_truncated(self):
        scene = canonical_scene(scene_for(12))
        for index, actor in enumerate(scene["actors"]):
            actor["identity"]["asset"] = {"name": f"{index:064x}.png"}
        manifest = build_manifest(scene)
        self.assertEqual(len(manifest["actors"]), 12)
        self.assertEqual(manifest["imageCount"], 13)
        self.assertEqual(len(manifest["warnings"]), 1)

    def test_single_guide_ignores_saved_identity_photos_without_deleting_them(self):
        self.scene["conditioning"]["promptMode"] = "single"
        manifest = build_manifest(self.scene)
        self.assertEqual(manifest["imageCount"], 1)
        self.assertTrue(self.scene["actors"][0]["identity"]["asset"])
        self.assertNotIn("<image2>", prompt_for(self.scene))

    def test_neutral_coarse_output_does_not_claim_mannequin_colors(self):
        self.scene["conditioning"]["guide"] = "coarse"
        self.assertNotIn("#ef6262", prompt_for(self.scene))
        self.scene["conditioning"]["colorActors"] = True
        self.assertIn("#ef6262", prompt_for(self.scene))
        self.scene["source"] = {"kind": "glb"}
        self.assertEqual(build_manifest(self.scene)["actors"], [])

    def test_photo_structures_do_not_generate_a_prompt_for_the_retained_3d_cast(self):
        self.scene["reference"] = self.store.asset(image_data("white"), "png")
        for guide in ("pose", "depth", "canny"):
            with self.subTest(guide=guide):
                settings = self.scene["conditioning"]
                settings.update(guide=guide, map=self.store.asset(image_data(), "png"), mapKind=guide)
                manifest = build_manifest(self.scene)
                self.assertEqual(manifest["actors"], [])
                self.assertEqual(manifest["imageCount"], 2)
                self.assertEqual(manifest["references"][0]["asset"], self.scene["reference"])
                self.assertNotIn("exactly 3 people", prompt_for(self.scene))
                settings.update(map=None, mapOrigin="auto" if guide == "canny" else "scene")
                self.assertEqual(len(build_manifest(self.scene)["actors"]), 3)
        settings["mapOrigin"] = "reference"
        self.assertEqual(build_manifest(self.scene)["actors"], [])
        settings.update(promptMode="custom", customPrompt="Use my chosen image mapping")
        self.assertEqual(len(build_manifest(self.scene)["actors"]), 3)
        self.assertEqual(prompt_for(self.scene), settings["customPrompt"])
        self.assertTrue(all(actor["identity"]["asset"] for actor in self.scene["actors"]))

    def test_static_structure_without_shared_original_uses_one_actual_image(self):
        self.scene.pop("reference", None)
        settings = self.scene["conditioning"]
        settings.update(imageOrder="reference-first", promptExtra="A dancer in blue.")
        for guide in ("pose", "depth", "canny"):
            with self.subTest(guide=guide):
                settings.update(guide=guide, map=self.store.asset(image_data(), "png"), mapKind=guide)
                manifest = build_manifest(self.scene)
                self.assertEqual(manifest["guide"]["index"], 1)
                self.assertEqual(manifest["imageCount"], 1)
                self.assertIn("<image1>", prompt_for(self.scene))
                self.assertNotIn("<image2>", prompt_for(self.scene))
                self.assertIn("A dancer in blue.", prompt_for(self.scene))
        settings.update(promptMode="custom", customPrompt="Keep my <image7> mapping.")
        self.assertEqual(prompt_for(self.scene), settings["customPrompt"])
        self.assertTrue(self.scene["actors"][0]["identity"]["asset"])

    def test_snapshot_v2_retains_local_pose_and_global_camera(self):
        snapshot = self.store.save_scene(self.scene, self.png)
        self.assertEqual(snapshot["version"], 1)
        document, _ = self.store.load_scene(snapshot)
        self.assertEqual(document["scene"]["cameraTarget"], [0, 10, 0])
        self.assertEqual(document["scene"]["actors"][0]["pose"]["modelRotation"], [0, 15, 0])
        self.assertEqual(document["scene"]["manifest"]["imageCount"], 4)

    def test_save_rebuilds_derived_manifest_and_ignores_asset_names_in_user_text(self):
        obsolete = "0" * 64 + ".png"
        self.scene["manifest"] = {"references": [{"asset": {"name": obsolete}}]}
        self.scene["resolvedPrompt"] = "old prompt"
        self.scene["actors"][1]["identity"]["description"] = obsolete
        snapshot = self.store.save_scene(self.scene, self.png)
        document, _ = self.store.load_scene(snapshot)
        self.assertEqual(document["scene"]["resolvedPrompt"], document["prompt"])
        self.assertEqual(document["scene"]["manifest"]["imageCount"], 4)
        with self.store.scene_archive(snapshot) as archive, zipfile.ZipFile(archive) as saved:
            self.assertNotIn("assets/" + obsolete, saved.namelist())

    def test_invalid_ids_transforms_assets_and_camera_targets_are_rejected(self):
        variants = []
        scene = copy.deepcopy(self.scene); scene["actors"][1]["id"] = "actor-0"; variants.append(scene)
        scene = copy.deepcopy(self.scene); scene["actors"][0]["transform"]["scale"] = 0; variants.append(scene)
        scene = copy.deepcopy(self.scene); scene["cameraTarget"] = [0, float("nan"), 0]; variants.append(scene)
        scene = copy.deepcopy(self.scene); scene["actors"][0]["identity"]["asset"] = {"name": "../photo.png"}; variants.append(scene)
        scene = copy.deepcopy(self.scene); scene["selectedActorIds"] = ["missing"]; variants.append(scene)
        for scene in variants:
            with self.subTest(scene=scene), self.assertRaises(ValueError):
                self.store.save_scene(scene, self.png)

    def test_portable_zip_restores_all_identity_assets_on_a_new_computer(self):
        snapshot = self.store.save_scene(self.scene, self.png)
        with self.store.scene_archive(snapshot) as archive:
            data = archive.read()
        with tempfile.TemporaryDirectory() as directory:
            other = StudioStore(directory)
            result = other.import_scene_archive(data)
            document, _ = other.load_scene(result["snapshot"])
            self.assertEqual(document["prompt"], prompt_for(self.scene))
            for actor in document["scene"]["actors"]:
                other.read_asset(actor["identity"]["asset"]["name"])

    def test_prop_and_template_camera_target_round_trip_with_portable_assets(self):
        raw = json.dumps({"asset": {"version": "2.0"}}).encode()
        data = struct.pack("<4sII", b"glTF", 2, 20 + len(raw)) + struct.pack("<I4s", len(raw), b"JSON") + raw
        prop = {"id": "prop-bench", "asset": self.store.asset(data, "glb"), "transform": {"x": 2, "scale": .7}}
        self.scene["props"] = [prop]
        contact = {"id": "handshake", "actors": ["actor-0", "actor-1"], "sides": ["r", "r"],
                   "anchor": [1.5, 12, -2], "mode": "align-once"}
        self.scene["contacts"] = [contact]
        self.scene["compositionTemplates"] = [{"name": "Bench scene", "actors": self.scene["actors"], "props": [prop],
                                               "contacts": [contact], "cameraTarget": [3, 8, 2], "camera": self.scene["camera"]}]
        snapshot = self.store.save_scene(self.scene, self.png)
        with self.store.scene_archive(snapshot) as archive, tempfile.TemporaryDirectory() as directory:
            result = StudioStore(directory).import_scene_archive(archive.read())
            self.assertEqual(result["scene"]["props"][0]["transform"]["scale"], .7)
            self.assertEqual(result["scene"]["compositionTemplates"][0]["cameraTarget"], [3, 8, 2])
            self.assertEqual(result["scene"]["contacts"], [contact])
            self.assertEqual(result["scene"]["compositionTemplates"][0]["contacts"], [contact])
            StudioStore(directory).read_asset(prop["asset"]["name"])
        duplicate = copy.deepcopy(self.scene)
        duplicate["compositionTemplates"][0]["props"][0]["id"] = "actor-0"
        with self.assertRaisesRegex(ValueError, "IDs"):
            self.store.save_scene(duplicate, self.png)
        self.scene["compositionTemplates"][0]["cameraTarget"][0] = float("nan")
        with self.assertRaises(ValueError):
            self.store.save_scene(self.scene, self.png)

    def test_invalid_contact_participants_anchor_or_template_do_not_save(self):
        contact = {"id": "contact", "actors": ["actor-0", "actor-1"], "sides": ["r", "l"], "anchor": [0, 10, 0]}
        variants = []
        for field, value in (("actors", ["actor-0", "missing"]), ("actors", ["actor-0", "actor-0"]),
                             ("anchor", [0, float("nan"), 0]), ("sides", ["r", "unknown"]), ("id", "")):
            bad = copy.deepcopy(contact); bad[field] = value
            scene = copy.deepcopy(self.scene); scene["contacts"] = [bad]; variants.append(scene)
            scene = copy.deepcopy(self.scene); scene["compositionTemplates"] = [{"name": "invalid", "actors": scene["actors"], "contacts": [bad]}]; variants.append(scene)
        for scene in variants:
            with self.subTest(scene=scene), self.assertRaisesRegex(ValueError, "Contact"):
                self.store.save_scene(scene, self.png)

    def test_invalid_or_missing_prop_assets_do_not_save_a_scene(self):
        for name in ("../private.glb", "0" * 64 + ".png", "0" * 64 + ".glb"):
            self.scene["props"] = [{"id": "prop-bench", "asset": {"name": name}}]
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.store.save_scene(self.scene, self.png)

    def test_portable_zip_rejects_escape_sha_changes_and_missing_manifest(self):
        snapshot = self.store.save_scene(self.scene, self.png)
        with self.store.scene_archive(snapshot) as archive:
            original = zipfile.ZipFile(io.BytesIO(archive.read()))
        for corrupt in ("escape", "sha", "missing"):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as output:
                for name in original.namelist():
                    if corrupt == "missing" and name == "manifest.json":
                        continue
                    raw = original.read(name)
                    if corrupt == "sha" and name.startswith("assets/"):
                        raw += b"corruption"
                    output.writestr(name, raw)
                if corrupt == "escape":
                    output.writestr("../private.png", b"data")
            with tempfile.TemporaryDirectory() as directory:
                other = StudioStore(directory)
                with self.subTest(corrupt=corrupt), self.assertRaises(ValueError):
                    other.import_scene_archive(buffer.getvalue())
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_portable_export_and_import_enforce_the_same_asset_and_manifest_budgets(self):
        snapshot = self.store.save_scene(self.scene, self.png)
        with self.store.scene_archive(snapshot) as archive:
            original = archive.read()
        for limit in ("PORTABLE_MAX_TOTAL", "PORTABLE_MAX_ASSET", "PORTABLE_MAX_MANIFEST"):
            with self.subTest(limit=limit), patch.object(storage, limit, 1):
                with self.assertRaises(ValueError):
                    self.store.scene_archive(snapshot)
                with self.assertRaises(ValueError):
                    self.store.import_scene_archive(original)
        with patch.object(storage, "PORTABLE_MAX_TOTAL", len(original) - 1), self.assertRaises(ValueError):
            self.store.scene_archive(snapshot)

    def test_pose_keypoints_preserve_multiple_people_and_visible_only_joints(self):
        people = []
        for offset in (0, 45):
            values = [[20 + offset, 20 + index, .8 if index < 8 else .05] for index in range(18)]
            people.append({"pose_keypoints_2d": np.asarray(values).flatten().tolist()})
        result, png = dwpose.people_from_keypoints([{"canvas_width": 96, "canvas_height": 64, "people": people}])
        self.assertEqual(len(result), 2)
        self.assertNotIn("la", result[0]["points"])
        self.assertFalse(result[0]["fullBody"])
        pixels = np.asarray(Image.open(io.BytesIO(png)))
        self.assertGreater(pixels[:, :45].sum(), 0)
        self.assertGreater(pixels[:, 45:].sum(), 0)

    def test_a_full_body_without_a_nose_remains_full_body_but_cannot_guess_three_dimensions(self):
        values = [value for index in range(18) for value in (20, 20 + index, 0 if index == 0 else .9)]
        result, _ = dwpose.people_from_keypoints({"canvas_width": 96, "canvas_height": 64, "people": [{"pose_keypoints_2d": values}]})
        self.assertTrue(result[0]["fullBody"])
        self.assertFalse(result[0]["canEstimate3D"])
        self.assertNotIn("head", result[0]["points"])

    def test_openpose_json_preserves_and_renders_real_hands_and_face_without_filling_missing_points(self):
        body = [value for index in range(18) for value in (20, 20 + index, .9)]
        hand = [value for index in range(21) for value in (55 + index % 5, 10 + index // 5, .9)]
        face = [value for index in range(70) for value in (80 + index % 3, 45 + index // 3 % 4, .9)]
        frame = {"canvas_width": 96, "canvas_height": 64, "people": [{"pose_keypoints_2d": body,
                 "hand_left_keypoints_2d": hand, "hand_right_keypoints_2d": [], "face_keypoints_2d": face}]}
        people, png = dwpose.people_from_keypoints(frame)
        self.assertEqual(len(people[0]["hand_left_keypoints_2d"]), 63)
        self.assertEqual(len(people[0]["face_keypoints_2d"]), 210)
        self.assertEqual(people[0]["hand_right_keypoints_2d"], [])
        pixels = np.asarray(Image.open(io.BytesIO(png)))
        self.assertGreater(pixels[5:20, 50:65].sum(), 0)
        self.assertGreater(pixels[40:55, 75:90].sum(), 0)
        self.assertEqual(pixels[5:20, 65:75].sum(), 0)
        frame["people"][0]["hand_left_keypoints_2d"] = [0, 0, .9]
        with self.assertRaisesRegex(ValueError, "hand_left"):
            dwpose.people_from_keypoints(frame)

    def test_multi_detection_does_not_drop_a_good_person_if_another_pose_fails(self):
        keys = np.full((133, 2), [20, 20], dtype=np.float32)
        scores = np.ones(133, dtype=np.float32)
        boxes = [(np.array([0, 0, 45, 64]), .9), (np.array([50, 0, 96, 64]), .8)]
        with patch.object(dwpose, "_sessions", return_value=(None, None)), patch.object(dwpose, "_detect_people", return_value=boxes), \
             patch.object(dwpose, "_estimate_body", side_effect=[(keys, scores), (keys, np.zeros(133))]):
            people, _ = dwpose.extract_people(image_data())
        self.assertEqual(len(people), 2)
        self.assertTrue(people[0]["points"])
        self.assertIn("warning", people[1])

    def test_yolox_nms_keeps_two_people_and_removes_duplicate_boxes(self):
        output = np.zeros((1, 8400, 85), dtype=np.float32)
        ratio = 640 / 96
        for index, center in enumerate(([20, 30], [20.5, 30], [75, 30])):
            output[0, index, :2] = np.asarray(center) * ratio / 8 - [index, 0]
            output[0, index, 2:4] = np.log(np.asarray([30, 50]) * ratio / 8)
            output[0, index, 4:6] = .9 - index * .05
        class Detector:
            def get_inputs(self):
                return [type("Input", (), {"name": "image"})()]
            def run(self, *_):
                return [output]
        result = dwpose._detect_people(np.zeros((64, 96, 3), dtype=np.uint8), Detector())
        self.assertEqual(len(result), 2)
        self.assertLess(result[0][0][0], result[1][0][0])
