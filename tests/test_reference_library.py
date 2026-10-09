import base64
import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

from PIL import Image

from test_multiperson import scene_for, image_data
from multiperson import build_manifest, canonical_scene
from reference_library import encoder_prompt, guide_is_stale
from storage import StudioStore, prompt_for


def library_scene(mode="references-only"):
    scene = scene_for(0)
    scene.update(version=3, source={"kind": "empty"}, referenceLibrary={"version": 1, "mode": mode,
        "items": [], "firstReferenceId": None, "firstResolution": 0, "templates": []})
    return scene


def reference(asset, index=0, kind="accessory"):
    return {"id": f"ref-{index}", "label": f"素材 {index}", "asset": asset, "enabled": True, "inputKey": None,
        "usages": [{"id": f"use-{index}", "kind": kind, "target": {"kind": "text", "ids": [], "text": "the foreground product"},
            "sourceText": "", "instruction": "", "enabled": True}]}


class LibraryTests(unittest.TestCase):
    def test_stale_photo_pose_is_checked_only_when_that_static_guide_is_active(self):
        scene = library_scene("guided")
        scene.update(reference={"name": "new.png"}, openpose={"origin": "dwpose", "referenceName": "old.png"})
        scene["conditioning"]["guide"] = "pose"
        self.assertTrue(guide_is_stale(scene))
        scene["conditioning"]["guide"] = "coarse"
        self.assertFalse(guide_is_stale(scene))
        scene["conditioning"]["guide"] = "pose"
        scene["openpose"]["acceptStoredSource"] = True
        self.assertFalse(guide_is_stale(scene))

    def test_anyangle_keeps_author_pair_and_sends_enabled_multi_use_references(self):
        scene = library_scene("guided")
        scene.update(source={"kind": "human"}, reference=self.asset)
        scene["conditioning"].update(model="anyangle", imageOrder="reference-first")
        face = reference(self.store.asset(image_data("red"), "png"), 1, "identity")
        clothes = reference(self.store.asset(image_data("blue"), "png"), 2, "clothing")
        disabled = reference(self.store.asset(image_data("green"), "png"), 3, "scene")
        disabled["enabled"] = False
        scene["referenceLibrary"]["items"] = [face, clothes, disabled]
        manifest = build_manifest(scene)
        self.assertEqual(manifest["imageCount"], 4)
        self.assertEqual(manifest["guide"]["index"], 2)
        self.assertEqual([entry["index"] for entry in manifest["references"]], [1, 3, 4])
        self.assertEqual(manifest["excluded"], [{"id": "ref-3", "label": "素材 3", "reason": "素材已停用"}])
        prompt = prompt_for(scene)
        self.assertTrue(prompt.startswith("Change the camera angle from <image2> to <image1>."))
        self.assertIn("<image3>: Use only the face identity", prompt)
        self.assertIn("<image4>: Use only the clothing design", prompt)
        token = self.store.save_scene(scene, "data:image/png;base64," + base64.b64encode(image_data()).decode())
        self.assertEqual(self.store.load_scene(token)[0]["prompt"], prompt)
        scene["conditioning"]["imageOrder"] = "guide-first"
        manifest = build_manifest(scene)
        self.assertEqual(manifest["guide"]["index"], 1)
        self.assertEqual([entry["index"] for entry in manifest["references"]], [2, 3, 4])
        self.assertTrue(prompt_for(scene).startswith("Change the camera angle from <image1> to <image2>."))
        scene["conditioning"].update(promptMode="custom", customPrompt="  Custom <image4>\n")
        self.assertEqual(prompt_for(scene), "  Custom <image4>\n")

    def test_anyangle_deduplicates_source_without_losing_its_additional_uses(self):
        scene = library_scene("guided")
        scene.update(source={"kind": "human"}, reference=self.asset)
        scene["conditioning"].update(model="anyangle", imageOrder="reference-first")
        self.assertEqual(prompt_for(scene), "Change the camera angle from <image2> to <image1>.")
        scene["referenceLibrary"]["items"] = [reference(self.asset, kind="style"), reference(self.asset, 1, "clothing")]
        manifest = build_manifest(scene)
        self.assertEqual(manifest["imageCount"], 2)
        self.assertEqual(manifest["references"][0]["referenceIds"], ["scene-source", "ref-0", "ref-1"])
        self.assertEqual(len(manifest["references"][0]["usages"]), 2)
        self.assertIn("<image1>: Use the visual style", prompt_for(scene))

    def test_anyangle_missing_order_defaults_to_author_pair_without_changing_base_default(self):
        scene = library_scene("guided")
        scene.update(source={"kind": "human"}, reference=self.asset)
        scene["conditioning"].update(model="anyangle")
        scene["conditioning"].pop("imageOrder")
        self.assertEqual(build_manifest(scene)["guide"]["index"], 2)
        self.assertEqual(prompt_for(scene), "Change the camera angle from <image2> to <image1>.")
        scene["conditioning"]["model"] = "base"
        scene["referenceLibrary"]["items"] = [reference(self.asset)]
        self.assertEqual(build_manifest(scene)["guide"]["index"], 1)

    def test_splat_named_roles_survive_model_switches_without_claiming_editable_cast(self):
        scene = library_scene("guided")
        scene.update(actors=scene_for(2)["actors"], source={"kind": "splat"}, reference=self.asset)
        scene["conditioning"].update(model="anyangle", imageOrder="reference-first")
        item = reference(self.store.asset(image_data("red"), "png"), 1, "identity")
        item["usages"][0]["target"] = {"kind": "actors", "ids": [scene["actors"][0]["id"]], "text": ""}
        scene["referenceLibrary"]["items"] = [item]
        manifest = build_manifest(scene)
        self.assertEqual(manifest["imageCount"], 3)
        self.assertEqual(manifest["actors"], [])
        self.assertIn(scene["actors"][0]["label"], prompt_for(scene))
        self.assertNotIn("guide contains", prompt_for(scene))
        scene["actors"][0]["visible"] = False
        self.assertEqual(build_manifest(scene)["imageCount"], 2)
        scene["actors"][0]["visible"] = True
        scene["source"]["kind"] = "glb"
        self.assertEqual(build_manifest(scene)["imageCount"], 2)
        scene["source"]["kind"] = "splat"
        scene["conditioning"]["model"] = "base"
        manifest = build_manifest(scene)
        self.assertEqual(manifest["imageCount"], 2)
        self.assertEqual(manifest["actors"], [])
        self.assertEqual(manifest["references"][0]["actorIds"], [scene["actors"][0]["id"]])
        self.assertIn(scene["actors"][0]["label"], prompt_for(scene))
        self.assertNotIn("guide contains", prompt_for(scene))
        scene["source"]["kind"] = "glb"
        self.assertEqual(build_manifest(scene)["references"], [])

    def test_base_splat_keeps_visible_named_role_uses_for_all_guide_and_reference_modes(self):
        scene = library_scene("guided")
        scene.update(actors=scene_for(2)["actors"], source={"kind": "splat"}, reference=self.asset)
        scene["conditioning"].update(model="base", imageOrder="guide-first")
        scene["actors"][1]["visible"] = False
        face = reference(self.asset, 1, "identity")
        face["usages"][0]["target"] = {"kind": "actors", "ids": ["actor-0", "actor-1", "deleted-role"], "text": ""}
        clothes = reference(self.store.asset(image_data("red"), "png"), 2, "clothing")
        clothes["usages"][0]["target"] = {"kind": "actors", "ids": ["actor-0"], "text": ""}
        scene["referenceLibrary"]["items"] = [face, clothes]
        for guide in ("coarse", "pose", "depth", "canny"):
            with self.subTest(guide=guide):
                scene["conditioning"].update(guide=guide, map=self.asset, mapKind=guide)
                manifest = build_manifest(scene)
                self.assertEqual(manifest["imageCount"], 3)
                self.assertEqual(manifest["actors"], [])
                self.assertEqual([entry["actorIds"] for entry in manifest["references"]], [["actor-0"], ["actor-0"]])
                self.assertEqual(manifest["references"][0]["usages"][0]["targetText"], "角色 0")
                prompt = prompt_for(scene)
                self.assertIn("<image2>: Use only the face identity", prompt)
                self.assertIn("<image3>: Use only the clothing design", prompt)
                self.assertNotIn("guide contains", prompt)
                self.assertNotIn("角色 1", prompt)
        scene["referenceLibrary"]["mode"] = "references-only"
        manifest = build_manifest(scene)
        self.assertIsNone(manifest["guide"])
        self.assertEqual(manifest["imageCount"], 2)
        self.assertEqual(manifest["actors"], [])
        self.assertIn("<image1>: Use only the face identity", prompt_for(scene))
        scene["referenceLibrary"]["mode"] = "text"
        self.assertEqual(build_manifest(scene)["imageCount"], 0)

    def test_anyangle_shared_fixture_matches_declared_manifest_and_full_prompt(self):
        fixture = json.loads((Path(__file__).parent / "fixtures" / "anyangle-references.json").read_text(encoding="utf-8"))
        scene, expected = fixture["scene"], fixture["expected"]
        manifest = build_manifest(scene)
        self.assertEqual(manifest["imageCount"], expected["imageCount"])
        self.assertEqual(manifest["guide"]["index"], expected["guideIndex"])
        self.assertEqual([{key: entry["asset"]["name"] if key == "name" else entry[key] for key in ("name", "index", "resolution", "actorIds")}
                          for entry in manifest["references"]], expected["references"])
        self.assertEqual(prompt_for(scene), expected["prompt"])
        node = Path("C:/Users/27611/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe")
        if node.exists():
            script = "import{libraryManifest,libraryPrompt}from './web/editor/reference-library.mjs';let s=JSON.parse(process.argv[1]);let m=libraryManifest(s);console.log(JSON.stringify({manifest:m,prompt:libraryPrompt(s,m)}));"
            result = subprocess.run([str(node), "--input-type=module", "-e", script, json.dumps(scene)], cwd=Path(__file__).parents[1], capture_output=True, text=True, encoding="utf-8", check=True)
            actual = json.loads(result.stdout)
            self.assertEqual(actual["manifest"], manifest)
            self.assertEqual(actual["prompt"], expected["prompt"])

    def test_anyangle_without_original_keeps_optional_materials_and_avoids_phantom_trigger(self):
        scene = library_scene("guided")
        scene["source"] = {"kind": "human"}
        scene["conditioning"].update(model="anyangle", imageOrder="reference-first")
        scene["referenceLibrary"]["items"] = [reference(self.asset, kind="accessory")]
        manifest = build_manifest(scene)
        self.assertEqual(manifest["guide"]["index"], 1)
        self.assertEqual(manifest["references"][0]["index"], 2)
        prompt = prompt_for(scene)
        self.assertNotIn("Change the camera angle", prompt)
        self.assertIn("composition, poses and placement in <image1>", prompt)
        self.assertIn("<image2>: Use only the accessory", prompt)

    def test_mixed_role_target_records_only_visible_existing_actor_ids(self):
        scene = library_scene("guided")
        scene.update(actors=scene_for(2)["actors"], source={"kind": "human"})
        scene["actors"][1]["visible"] = False
        item = reference(self.asset, kind="identity")
        item["usages"][0]["target"] = {"kind": "actors", "ids": ["actor-0", "actor-1", "deleted-role"], "text": ""}
        scene["referenceLibrary"]["items"] = [item]
        manifest = build_manifest(scene)
        self.assertEqual(manifest["references"][0]["actorIds"], ["actor-0"])
        self.assertEqual(manifest["references"][0]["usages"][0]["targetText"], "角色 0")
        self.assertEqual(len(manifest["actors"]), 1)
        self.assertNotIn("角色 1", prompt_for(scene))

    def test_imported_empty_role_and_reference_labels_use_ids_without_dropping_bindings(self):
        scene = library_scene("guided")
        scene.update(actors=scene_for(1)["actors"], source={"kind": "human"})
        scene["actors"][0]["label"] = ""
        item = reference(self.asset, kind="identity")
        item["label"] = ""
        item["usages"][0]["target"] = {"kind": "actors", "ids": ["actor-0"], "text": ""}
        disabled = reference(self.asset, 1); disabled.update(label="", enabled=False)
        scene["referenceLibrary"]["items"] = [item, disabled]
        scene = canonical_scene(scene)
        manifest = build_manifest(scene)
        self.assertEqual(manifest["imageCount"], 2)
        self.assertEqual(manifest["references"][0]["labels"], ["ref-0"])
        self.assertEqual(manifest["references"][0]["usages"][0]["targetText"], "actor-0")
        self.assertEqual(manifest["actors"][0]["label"], "actor-0")
        self.assertEqual(manifest["excluded"][0]["label"], "ref-1")
    def test_invalid_templates_and_crop_provenance_fail_before_saving(self):
        scene = library_scene()
        scene["referenceLibrary"]["items"] = [reference(self.asset)]
        scene["referenceLibrary"]["templates"] = [{"id": "x", "name": "Broken", "items": [{"id": "bad"}]}]
        with self.assertRaisesRegex(ValueError, "Reference uses"):
            self.store.save_scene(scene)
        scene["referenceLibrary"]["templates"] = []
        scene["referenceLibrary"]["items"][0]["parent"] = {"name": self.asset["name"], "box": [0, 0, 0, 2]}
        with self.assertRaisesRegex(ValueError, "cropped"):
            self.store.save_scene(scene)

    def test_batch_receipt_contains_actual_frozen_text_and_hashes(self):
        scene = library_scene("text")
        token = self.store.save_scene(scene)
        batch = self.store.save_batch([{"snapshot": token, "encoding_plan": [{"encoder_id": "7", "prompt_mode": "input-full", "prompt": "  raw <image9>\n", "negative_prompt": "avoid text"}]}])
        saved = json.loads(self.store.read_asset(batch["id"] + ".json"))
        entry = saved["views"][0]["encoding_plan"][0]
        self.assertEqual(entry["prompt"], "  raw <image9>\n")
        self.assertEqual(len(entry["negative_prompt_sha256"]), 64)

    def test_alpha_and_exif_are_normalized_without_changing_legacy_asset_policy(self):
        data = io.BytesIO()
        Image.new("RGBA", (103, 81), (100, 80, 60, 128)).save(data, "PNG")
        old = self.store.asset(data.getvalue(), "png")
        current = self.store.asset(data.getvalue(), "png", preserve_alpha=True)
        self.assertNotEqual(old["name"], current["name"])
        self.assertEqual(Image.open(io.BytesIO(self.store.read_asset(old["name"]))).mode, "RGB")
        self.assertEqual(Image.open(io.BytesIO(self.store.read_asset(current["name"]))).mode, "RGBA")
        photo = Image.new("RGB", (96, 160), (0, 100, 200)); exif = Image.Exif(); exif[274] = 6
        jpeg = io.BytesIO(); photo.save(jpeg, "JPEG", exif=exif)
        normalized = self.store.asset(jpeg.getvalue(), "png", preserve_alpha=True)
        self.assertEqual((normalized["width"], normalized["height"]), (160, 96))

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = StudioStore(self.directory.name)
        self.asset = self.store.asset(image_data(), "png")

    def test_no_actor_product_and_style_send_without_fake_guide(self):
        scene = library_scene()
        scene["referenceLibrary"]["items"] = [reference(self.asset)]
        token = self.store.save_scene(scene)
        saved, png = self.store.load_scene(token)
        self.assertIsNone(png)
        self.assertIsNone(saved["guide"])
        self.assertEqual(saved["scene"]["manifest"]["imageCount"], 1)
        self.assertIn("only the accessory or product", saved["prompt"])
        self.assertNotIn("0 people", saved["prompt"])
        self.assertEqual(saved["scene"]["manifest"]["references"][0]["resolution"], 0)
        with self.assertRaisesRegex(ValueError, "不应保存"):
            self.store.save_scene(scene, image_data())

    def test_same_asset_multi_uses_unique_index_and_deleted_targets_do_not_go_global(self):
        scene = library_scene()
        first, second = reference(self.asset), reference(self.asset, 1, "style")
        second["usages"][0]["target"] = {"kind": "scene", "ids": [], "text": ""}
        scene["referenceLibrary"]["items"] = [first, second]
        manifest = build_manifest(canonical_scene(scene))
        self.assertEqual(manifest["imageCount"], 1)
        self.assertEqual(len(manifest["references"][0]["usages"]), 2)
        first["usages"][0]["target"] = {"kind": "actors", "ids": [], "text": ""}
        manifest = build_manifest(scene)
        self.assertEqual(len(manifest["references"][0]["usages"]), 1)
        self.assertEqual(manifest["excluded"][0]["id"], "ref-0")

    def test_first_index_reorder_real_crop_separate_and_over_ten_not_truncated(self):
        scene = library_scene()
        items = []
        for index in range(17):
            data = io.BytesIO()
            Image.new("RGB", (130 + index, 65), (index, 20, 40)).save(data, "PNG")
            items.append(reference(self.store.asset(data.getvalue(), "png"), index))
        scene["referenceLibrary"].update(items=items, firstReferenceId="ref-9")
        manifest = build_manifest(scene)
        self.assertEqual(manifest["references"][0]["referenceIds"], ["ref-9"])
        self.assertEqual([entry["index"] for entry in manifest["references"]], list(range(1, 18)))
        self.assertEqual(manifest["imageCount"], 17)
        self.assertEqual(len(manifest["warnings"]), 1)

    def test_disabled_assets_and_templates_survive_no_png_zip_and_batch(self):
        scene = library_scene()
        disabled = reference(self.asset, 1)
        disabled["enabled"] = False
        scene["referenceLibrary"]["items"] = [reference(self.asset), disabled]
        scene["referenceLibrary"]["templates"] = [{"id": "template-1", "name": "组合", "items": [disabled]}]
        token = self.store.save_scene(scene)
        with self.store.scene_archive(token) as archive:
            data = archive.read()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["minimumPluginVersion"], "1.6.0")
            self.assertIn(self.asset["name"], manifest["assets"])
        with tempfile.TemporaryDirectory() as other:
            imported = StudioStore(other).import_scene_archive(data)
            self.assertEqual(imported["scene"]["referenceLibrary"], scene["referenceLibrary"])
            self.assertIsNone(imported["guide"])
        batch = self.store.save_batch([{"snapshot": token}])
        with self.store.batch_archive(batch["id"]) as archive, zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.namelist(), ["manifest.json"])

    def test_prompt_full_raw_including_empty_append_once_and_invalid_mode(self):
        self.assertEqual(encoder_prompt("auto", "  raw <image9>\n", "input-full"), "  raw <image9>\n")
        self.assertEqual(encoder_prompt("auto", "", "input-full"), "")
        self.assertEqual(encoder_prompt("auto", "addition"), "auto\naddition")
        self.assertEqual(encoder_prompt("auto", "auto"), "auto")
        self.assertEqual(encoder_prompt("auto", "auto", "input-full"), "auto")
        self.assertEqual(encoder_prompt("auto"), "auto")
        with self.assertRaises(ValueError):
            encoder_prompt("auto", prompt_mode="guess")

    def test_source_stale_or_missing_enabled_connection_is_not_silently_reused(self):
        scene = library_scene()
        item = reference(self.asset)
        item.update(inputKey="actor_reference_1", missing=True)
        scene["referenceLibrary"]["items"] = [item]
        with self.assertRaisesRegex(ValueError, "缺少参考素材"):
            self.store.save_scene(scene)
        item.update(missing=False, inputKey=None)
        self.store.save_scene(scene)

    def test_pure_text_has_zero_images_and_keeps_exact_custom_prompt(self):
        scene = library_scene("text")
        scene["conditioning"].update(promptMode="custom", customPrompt="  a product photo\n")
        token = self.store.save_scene(scene)
        saved, png = self.store.load_scene(token)
        self.assertEqual(saved["scene"]["manifest"]["imageCount"], 0)
        self.assertEqual(saved["prompt"], "  a product photo\n")
        self.assertIsNone(png)

    def test_js_contract_matches_backend_for_targets_dedup_guides_and_prompts(self):
        node = Path("C:/Users/27611/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe")
        if not node.exists():
            self.skipTest("Node runtime unavailable")
        scene = library_scene()
        scene["referenceLibrary"]["items"] = [reference(self.asset), reference(self.asset, 1, "style")]
        script = "import{libraryManifest,libraryPrompt}from './web/editor/reference-library.mjs'; let s=JSON.parse(process.argv[1]);let m=libraryManifest(s);console.log(JSON.stringify({manifest:m,prompt:libraryPrompt(s,m)}));"
        result = subprocess.run([str(node), "--input-type=module", "-e", script, json.dumps(scene)], cwd=Path(__file__).parents[1], capture_output=True, text=True, encoding="utf-8", check=True)
        actual = json.loads(result.stdout)
        self.assertEqual(actual["manifest"], build_manifest(scene))
        self.assertEqual(actual["prompt"], prompt_for(scene))
