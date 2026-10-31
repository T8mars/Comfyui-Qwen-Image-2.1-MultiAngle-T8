import copy
from contextlib import contextmanager
import errno
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

from PIL import Image

from pose_gallery import GalleryStore, GalleryConflict, ImportCancelled, GalleryFiles, safe_path, is_link


def picture(color="red"):
    out = io.BytesIO()
    Image.new("RGB", (32, 48), color).save(out, "PNG")
    return out.getvalue()


def fixture(root, *, rows=None):
    root.mkdir(parents=True, exist_ok=True)
    (root / "data").mkdir(exist_ok=True)
    (root / "img").mkdir(exist_ok=True)
    (root / "thumbs").mkdir(exist_ok=True)
    if rows is None:
        rows = [{"id": f"full_single_P019_{angle}", "体系": "全身单人", "姿势编号": "P019", "分类": "站姿",
                 "姿势名称": "站姿双臂上举", "角度": angle, "原图": f"img/{angle}.png", "缩略图": f"thumbs/{angle}.png"}
                for angle in ("front", "side")]
    (root / "data/pose-zh.json").write_text(json.dumps(rows, ensure_ascii=False), "utf-8")
    (root / "LICENSE").write_text("Source notice must survive export.", "utf-8")
    for i, row in enumerate(rows):
        for key in ("原图", "缩略图"):
            (root / row[key]).write_bytes(picture("red" if i == 0 else "blue"))
    return root


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = fixture(self.root / "source")
        self.store = GalleryStore(self.root / "library")

    def test_nested_source_paths_group_actual_views_and_keep_notices(self):
        receipt = self.store.import_files(self.source)
        self.assertEqual(receipt["groups"], 1)
        self.assertEqual(receipt["views"], 2)
        item = self.store.list()["items"][0]
        self.assertEqual([view["angle"] for view in item["views"]], ["front", "side"])
        self.assertIn("must survive", item["source"]["license"])
        self.assertTrue(all(view["original"]["ready"] for view in item["views"]))

    def test_reimport_preserves_personal_edits_without_duplicate_groups(self):
        self.store.import_files(self.source)
        first = self.store.list()
        item = first["items"][0]
        self.store.patch(item["id"], {"name": "我的常用动作", "favorite": True, "tags": ["演示"]}, first["revision"])
        self.store.import_files(self.source)
        result = self.store.list()["items"]
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "我的常用动作")
        self.assertEqual(result[0]["tags"], ["演示"])
        self.assertTrue(result[0]["favorite"])

    def test_windows_junction_detection_does_not_require_python312(self):
        path = Mock()
        path.lstat.return_value.st_mode = 0o40755
        path.lstat.return_value.st_file_attributes = 0x410
        self.assertTrue(is_link(path))
        path.lstat.return_value.st_file_attributes = 0x10
        self.assertFalse(is_link(path))

    def test_source_update_keeps_removed_group_and_personal_edits(self):
        rows = json.loads((self.source / "data/pose-zh.json").read_text("utf-8"))
        old = copy.deepcopy(rows[0]); old["id"] = "full_single_P020_front"; old["姿势名称"] = "旧动作"
        fixture(self.source, rows=[*rows, old])
        self.store.import_files(self.source)
        data = self.store.list(); orphan = next(row for row in data["items"] if row["number"] == "P020")
        self.store.patch(orphan["id"], {"favorite": True, "name": "我的旧动作"}, data["revision"])
        fixture(self.source, rows=rows)
        self.store.import_files(self.source)
        saved = next(row for row in self.store.list()["items"] if row["id"] == orphan["id"])
        self.assertTrue(saved["sourceMissing"])
        self.assertTrue(saved["favorite"])
        self.assertEqual(saved["name"], "我的旧动作")
        self.assertTrue(saved["views"][0]["original"]["ready"])
        fixture(self.source, rows=[*rows, old]); self.store.import_files(self.source)
        restored = next(row for row in self.store.list()["items"] if row["id"] == orphan["id"])
        self.assertFalse(restored.get("sourceMissing", False))
        self.assertTrue(restored["favorite"])

    def test_broken_image_and_cancel_leave_published_index_intact_and_resume(self):
        self.store.import_files(self.source)
        before = self.store.list()
        original = (self.source / "img/side.png").read_bytes()
        (self.source / "img/side.png").write_bytes(b"corrupt image")
        with self.assertRaises(OSError):
            self.store.import_files(self.source)
        self.assertEqual(self.store.list(), before)
        (self.source / "img/side.png").write_bytes(original)
        completed = []
        with self.assertRaises(ImportCancelled):
            self.store.import_files(self.source, lambda n, *_: completed.append(n), lambda: len(completed) >= 2)
        self.assertEqual(self.store.list(), before)
        self.assertEqual(self.store.import_files(self.source)["files"], 4)

    def test_portable_roundtrip_retains_views_hashes_and_preferences(self):
        self.store.import_files(self.source)
        item = self.store.list()["items"][0]
        self.store.patch(item["id"], {"favorite": True, "hidden": True, "used": True}, 1)
        preferences = {"presets": [{"id": "standing", "name": "站姿", "filters": {"query": "举手", "angle": "side"}}],
                       "collections": [{"id": "daily", "name": "常用", "ids": [item["id"]]}], "lastFilters": {"query": "叉腰"}}
        self.store.preferences(preferences, 2)
        archive = self.store.export()
        other = GalleryStore(self.root / "other")
        other.import_files(archive)
        self.assertEqual(other.list()["items"], self.store.list()["items"])
        for key, value in preferences.items():
            self.assertEqual(other.list()[key], value)
        other.preferences({"presets": [{"id": "standing", "name": "本机改名", "filters": {"query": "跪姿"}}]}, 1)
        other.import_files(archive)
        self.assertEqual(other.list()["presets"][0]["name"], "本机改名")

    def test_cleanup_preserves_index_and_referenced_images(self):
        self.store.import_files(self.source)
        before = self.store.list()
        archive = self.store.export()
        orphan = self.store.blob_path("0" * 64 + ".png")
        orphan.write_bytes(picture("green"))
        removed = self.store.clear_cache()
        self.assertGreater(removed["removedBytes"], 0)
        self.assertFalse(archive.exists())
        self.assertFalse(orphan.exists())
        self.assertEqual(self.store.list(), before)
        self.assertTrue(self.store.export().is_file())

    def test_disk_full_keeps_index_and_removes_partial_write_before_retry(self):
        self.store.import_files(self.source)
        before = self.store.list()
        files = set(self.store.root.iterdir())
        temporary_file = tempfile.NamedTemporaryFile

        @contextmanager
        def failing_file(**kwargs):
            with temporary_file(**kwargs) as handle:
                def partial_write(data):
                    handle.write(data[:10])
                    raise OSError(errno.ENOSPC, 'No space left on device')
                proxy = Mock(wraps=handle)
                proxy.name = handle.name
                proxy.write.side_effect = partial_write
                yield proxy

        ident = before['items'][0]['id']
        with patch('pose_gallery.tempfile.NamedTemporaryFile', side_effect=failing_file):
            with self.assertRaises(OSError) as caught:
                self.store.patch(ident, {'favorite': True}, before['revision'])
            self.assertEqual(caught.exception.errno, errno.ENOSPC)
        self.assertEqual(self.store.list(), before)
        self.assertEqual(set(self.store.root.iterdir()), files)
        self.assertTrue(self.store.patch(ident, {'favorite': True}, before['revision'])['items'][0]['favorite'])

    def test_tampered_portable_asset_does_not_commit(self):
        self.store.import_files(self.source)
        archive = self.store.export()
        bad = self.root / "bad.zip"
        with zipfile.ZipFile(archive) as src, zipfile.ZipFile(bad, "w") as dst:
            for name in src.namelist():
                dst.writestr(name, picture("green") if name.startswith("blobs/") else src.read(name))
        other = GalleryStore(self.root / "other")
        with self.assertRaisesRegex(ValueError, "hash"):
            other.import_files(bad)
        self.assertEqual(other.list()["items"], [])

    def test_conflicts_and_invalid_preferences_are_nonmutating(self):
        self.store.import_files(self.source)
        item = self.store.list()["items"][0]
        with self.assertRaises(GalleryConflict):
            self.store.patch(item["id"], {"favorite": True}, 0)
        with self.assertRaises(ValueError):
            self.store.patch(item["id"], {"favorite": "false"}, 1)
        with self.assertRaises(ValueError):
            self.store.preferences({"presets": [{"id": "x", "name": "test", "filters": {"script": "javascript"}}]}, 1)
        self.assertEqual(self.store.list()["revision"], 1)

    def test_presets_collections_import_export_values_are_reusable(self):
        self.store.import_files(self.source)
        ident = self.store.list()["items"][0]["id"]
        preferences = {"presets": [{"id": "search-1", "name": "举手侧面", "filters": {"query": "举手", "angle": "side"}}],
                       "collections": [{"id": "folder-1", "name": "常用", "ids": [ident]}], "lastFilters": {"query": "叉腰"}}
        self.store.preferences(preferences, 1)
        for key, value in preferences.items():
            self.assertEqual(self.store.list()[key], value)
        self.store.preferences({"presets": [], "collections": []}, 2)
        self.assertEqual(self.store.list()["presets"], [])

    def test_archive_traversal_duplicate_and_symlink_rejected(self):
        for name in ("../evil", "/absolute", "C:/absolute", "nested\\escape", "folder/../escape", "CON.png"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_path(name)
        path = self.root / "bad.zip"
        with zipfile.ZipFile(path, "w") as output:
            output.writestr("A.json", b"{}")
            output.writestr("a.json", b"{}")
        with self.assertRaisesRegex(ValueError, "重复"):
            GalleryFiles(path)
        with zipfile.ZipFile(path, "w") as output:
            info = zipfile.ZipInfo("link"); info.external_attr = (0o120777 << 16)
            output.writestr(info, b"../outside")
        with self.assertRaisesRegex(ValueError, "链接"):
            GalleryFiles(path)

    def test_same_name_different_source_group_is_not_merged(self):
        rows = json.loads((self.source / "data/pose-zh.json").read_text("utf-8"))
        row = copy.deepcopy(rows[0]); row["id"] = "full_sexy_P019_front"; row["体系"] = "全身单人性感系"
        rows.append(row)
        (self.source / "data/pose-zh.json").write_text(json.dumps(rows), "utf-8")
        self.assertEqual(self.store.import_files(self.source)["groups"], 2)


if __name__ == "__main__":
    unittest.main()
