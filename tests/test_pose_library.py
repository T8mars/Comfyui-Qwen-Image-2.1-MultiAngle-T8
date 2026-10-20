import base64
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1]))
from pose_library import (PoseLibraryStore, RevisionConflict, builtin_entries, inspect_files,
                          inspect_zip, normalized_entry, normalize_pose, read_json)


def document(angle=20):
    return {"version": 1, "kind": "anyangle-pose", "pose": {"bones": {"head": [angle, 0, 0]}}}


class PoseCatalogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = PoseLibraryStore(self.directory.name)

    def entry(self, angle=20, name="A"):
        return normalized_entry(document(angle), name)

    def test_vnccs_active_actor_tab_and_degrees(self):
        source = {"schema_version": 3, "bones": {"head": [99, 0, 0]}, "active_character_id": "b", "activeTab": 1,
                  "characters": [{"id": "a", "poses": [{"bones": {"head": [1, 0, 0]}}]},
                                 {"id": "b", "poses": [{"bones": {"head": [2, 0, 0]}}, {"bones": {"head": [45, 0, 0]}, "camera": {}, "hipBonePosition": {"hips": [8, 8, 8]}}]}]}
        pose, warnings = normalize_pose(source)
        self.assertEqual(pose, {"bones": {"head": [45, 0, 0]}})
        self.assertTrue(warnings)

    def test_partial_bones_are_diagnosed_without_rejecting_usable_pose(self):
        pose, warnings = normalize_pose({"bones": {"head": [1, 2, 3], "unknown": [3, 2, 1]}})
        self.assertEqual(list(pose["bones"]), ["head"])
        self.assertIn("unknown", warnings[0])

    def test_scene_version_three_is_not_a_pose(self):
        with self.assertRaises(ValueError):
            normalize_pose({"version": 3, "source": {"kind": "human"}, "actors": [], "bones": {"head": [0, 0, 0]}})

    def test_non_finite_bool_and_malformed_rotations_rejected(self):
        for values in ([float("nan"), 0, 0], [True, 0, 0], [0, 0], [0, "1", 0]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                normalize_pose({"bones": {"head": values}})

    def test_duplicate_and_reserved_json_keys_rejected(self):
        for raw in (b'{"bones":{},"bones":{}}', b'{"__proto__":{}}', b'{"head":NaN}'):
            with self.assertRaises(ValueError):
                read_json(raw)

    def test_import_copies_values_and_persists_across_instances(self):
        entry = self.entry()
        result = self.store.import_entries([entry], 0)
        entry["pose"]["bones"]["head"][0] = 100
        other = PoseLibraryStore(self.directory.name).list()
        self.assertEqual(result["revision"], 1)
        self.assertEqual(other["items"][-1]["pose"]["bones"]["head"], [20, 0, 0])

    def test_revision_conflict_keeps_index_byte_identical(self):
        self.store.import_entries([self.entry()], 0)
        original = self.store.path("index.json").read_bytes()
        with self.assertRaises(RevisionConflict):
            self.store.import_entries([self.entry(99)], 0)
        self.assertEqual(self.store.path("index.json").read_bytes(), original)

    def test_bad_import_batch_never_partially_commits(self):
        malformed = self.entry(); malformed["pose"]["bones"]["head"] = [None, 0, 0]
        with self.assertRaises(ValueError):
            self.store.import_entries([self.entry(), malformed], 0)
        self.assertEqual(self.store.read()["revision"], 0)
        self.assertEqual(self.store.read()["items"], [])

    def test_remote_updates_keep_stable_id_and_user_metadata(self):
        first = self.entry(); first["source"] = {"id": "general", "path": "poses/A.json", "ref": "old"}
        result = self.store.import_entries([first], 0); saved = result["items"][-1]
        self.store.patch(saved["id"], {"name": "我的动作", "favorite": True}, 1)
        second = self.entry(60); second["source"] = {**first["source"], "ref": "new"}
        result = self.store.import_entries([second], 2)
        item = result["items"][-1]
        self.assertEqual(len(result["items"]), len(builtin_entries()) + 1)
        self.assertEqual(item["id"], saved["id"])
        self.assertEqual(item["name"], "我的动作")
        self.assertTrue(item["favorite"])
        self.assertEqual(item["pose"]["bones"]["head"], [60, 0, 0])

    def test_builtin_favorites_and_hidden_state_are_shared(self):
        self.store.patch("builtin-0", {"favorite": True, "hidden": True}, 0)
        other = PoseLibraryStore(self.directory.name).list()
        self.assertTrue(other["items"][0]["favorite"])
        self.assertTrue(other["items"][0]["hidden"])

    def test_export_roundtrip_keeps_name_tags_provenance_and_preview(self):
        entry = self.entry(); entry.update(tags=["portrait"], favorite=True)
        buf = io.BytesIO(); Image.new("RGB", (40, 40), "blue").save(buf, "PNG")
        entry["previewData"] = base64.b64encode(buf.getvalue()).decode()
        result = self.store.import_entries([entry], 0)
        packed = self.store.export([result["items"][-1]["id"]])
        decoded = inspect_zip(packed)
        self.assertEqual(decoded["errors"], [])
        self.assertEqual(decoded["entries"][0]["name"], "A")
        self.assertEqual(decoded["entries"][0]["tags"], ["portrait"])
        self.assertTrue(decoded["entries"][0]["favorite"])
        self.assertTrue(decoded["entries"][0]["previewData"])

    def test_delete_does_not_mutate_copied_workflow_pose(self):
        item = self.store.import_entries([self.entry()], 0)["items"][-1]
        workflow = copy.deepcopy(item["pose"])
        self.store.delete([item["id"]], 1)
        self.assertEqual(workflow, {"bones": {"head": [20, 0, 0]}})
        self.assertEqual(self.store.read()["items"], [])

    def test_import_paths_cannot_escape_and_never_execute_scripts(self):
        for name in ("../outside.json", "/absolute.json", "C:/outside.json", "nested\\file.json"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                inspect_files({name: json.dumps(document()).encode()})
        result = inspect_files({"ok.json": json.dumps(document()).encode(), "run.py": b"raise Exception('MUST NOT EXECUTE')"})
        self.assertEqual(len(result["entries"]), 1)

    def test_source_zip_only_imports_pose_library_tree(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("repo-main/pose_library/Standing.json", json.dumps(document()))
            archive.writestr("repo-main/workflows/not-a-pose.json", json.dumps(document(90)))
            archive.writestr("repo-main/scripts/evil.py", "raise Exception('MUST NOT EXECUTE')")
        result = inspect_zip(buf.getvalue())
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(result["entries"][0]["pose"]["bones"]["head"][0], 20)

    def test_zip_slip_symlinks_and_duplicate_paths_rejected(self):
        for mode in ("slip", "link", "duplicate"):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as archive:
                if mode == "slip":
                    archive.writestr("../escape.json", "{}")
                elif mode == "link":
                    info = zipfile.ZipInfo("a.json"); info.external_attr = (0o120777 << 16); archive.writestr(info, "outside")
                else:
                    archive.writestr("a.json", "{}"); archive.writestr("a.json", "{}")
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                inspect_zip(buf.getvalue())

    def test_preview_paths_and_unknown_patch_fields_rejected(self):
        for name in ("../file.png", "file.json", "../index.json"):
            with self.assertRaises(ValueError):
                self.store.path(name)
        with self.assertRaises(ValueError):
            self.store.patch("builtin-0", {"pose": document()["pose"]}, 0)

    def test_directory_import_retains_local_source_and_rejects_bad_provenance(self):
        inspected = inspect_files({"nested/local.json": json.dumps(document()).encode()})
        self.assertEqual(inspected["entries"][0]["source"]["id"], "local")
        self.assertEqual(inspected["entries"][0]["source"]["path"], "nested/local.json")
        row = self.entry(); row["source"] = ["invalid"]
        with self.assertRaises(ValueError):
            self.store.import_entries([row], 0)
        self.assertEqual(self.store.read()["revision"], 0)

    def test_composition_roundtrip_preserves_slots_and_hand_mapping(self):
        row = self.entry(); row.update(kind="composition", slots=[
            {"pose": document()["pose"], "transform": {"x": 0, "yaw": 90}},
            {"pose": document(40)["pose"], "transform": {"x": 7, "yaw": -90}},
        ], align=[{"slots": [0, 1], "hands": ["r", "l"]}])
        item = self.store.import_entries([row], 0)["items"][-1]
        result = inspect_zip(self.store.export([item["id"]]))
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["entries"][0]["slots"], item["slots"])
        self.assertEqual(result["entries"][0]["align"], item["align"])
        for malformed in ([None, None], [{"pose": document()["pose"], "transform": {"x": float("inf")}}, row["slots"][1]]):
            with self.assertRaises((ValueError, AttributeError)):
                self.store.import_entries([{**row, "slots": malformed}], 1)
        self.assertEqual(self.store.read()["revision"], 1)

    def test_fresh_install_exports_all_builtin_previews_without_generated_cache(self):
        result = inspect_zip(self.store.export())
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["entries"]), 15)
        self.assertTrue(all(row.get("previewData") for row in result["entries"]))


if __name__ == "__main__":
    unittest.main()
