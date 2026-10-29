"""Local image pose groups; source files and user preferences have separate ownership."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import threading
import time
import zipfile

from PIL import Image


LOCK = threading.RLock()
CONTENT_LOCK = threading.RLock()
MAX_FILE = 16 * 1024 * 1024
MAX_PACK = 2 * 1024 * 1024 * 1024
MAX_FILES = 12000
SOURCE = {"id": "ai-pose-gallery-zh", "name": "AI Pose Gallery 中文",
          "url": "https://github.com/anhao/ai-pose-gallery-zh",
          "authorUrl": "https://ai-pose-gallery.pages.dev/"}
ANGLES = {"front": "正面", "side": "侧面", "diag": "斜侧", "high": "俯视", "low": "仰视"}
BLOB = re.compile(r"[a-f0-9]{64}\.(png|jpg|webp)\Z")
GROUP = re.compile(r"gallery-[a-f0-9]{24}\Z")
JOB = re.compile(r"[a-f0-9]{32}\Z")


class GalleryConflict(ValueError):
    pass


class ImportCancelled(Exception):
    pass


def is_link(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def safe_path(name):
    if not isinstance(name, str) or len(name) > 512 or "\\" in name or ":" in name or "\x00" in name:
        raise ValueError("图库文件名无效")
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in ("..", ".") or part.endswith((" ", ".")) for part in name.split("/")):
        raise ValueError("图库文件路径越界")
    if any(part.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]} for part in path.parts):
        raise ValueError("图库文件名是保留名称")
    return path


def bounded_text(value, maximum=500):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError("图库文字字段无效或过长")
    return value.strip()


def group_id(source_id, system, number):
    return "gallery-" + hashlib.sha256(f"{source_id}/{system}/{number}".encode()).hexdigest()[:24]


def image_info(data):
    if not data or len(data) > MAX_FILE:
        raise ValueError("单张图片须小于16 MiB")
    with Image.open(io.BytesIO(data)) as image:
        if image.format not in ("PNG", "JPEG", "WEBP") or image.width * image.height > 32_000_000:
            raise ValueError("图库只接受32百万像素以内的PNG/JPEG/WebP")
        image.load()
        extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[image.format]
        return {"name": hashlib.sha256(data).hexdigest() + "." + extension,
                "width": image.width, "height": image.height, "size": len(data)}


class GalleryFiles:
    """Read declared resources without extracting archives or executing source code."""
    def __init__(self, path):
        self.path = Path(path)
        if is_link(self.path):
            raise ValueError("图库导入不接受链接目录或文件")
        self.archive = None
        self.entries = {}
        total = 0
        try:
            if self.path.is_file():
                self.archive = zipfile.ZipFile(self.path)
                candidates = [(info.filename, info) for info in self.archive.infolist() if not info.is_dir()]
            else:
                candidates = []
                for parent, directories, files in os.walk(self.path, followlinks=False):
                    for name in directories + files:
                        child = Path(parent) / name
                        if is_link(child):
                            raise ValueError("图库导入不接受链接目录或文件")
                    candidates.extend((str((Path(parent) / name).relative_to(self.path)).replace("\\", "/"), Path(parent) / name) for name in files)
            if len(candidates) > MAX_FILES:
                raise ValueError("图库文件超过12000项，请分包导入")
            seen = set()
            for name, item in candidates:
                safe_path(name)
                if name.casefold() in seen:
                    raise ValueError("图库包含重复文件路径")
                seen.add(name.casefold())
                size = item.file_size if self.archive else item.stat().st_size
                if self.archive and stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError("图库压缩包不接受链接")
                total += size
                if size > MAX_FILE or total > MAX_PACK:
                    raise ValueError("图库资源超过单文件16 MiB或整包2 GiB限制")
                self.entries[name] = item
        except Exception:
            self.close()
            raise

    def close(self):
        if self.archive:
            self.archive.close()

    def read(self, name):
        safe_path(name)
        if name not in self.entries:
            raise ValueError(f"图库缺少文件：{name}")
        item = self.entries[name]
        if self.archive:
            with self.archive.open(item) as handle:
                data = handle.read(MAX_FILE + 1)
        else:
            if is_link(item) or not item.resolve().is_relative_to(self.path.resolve()):
                raise ValueError("图库文件路径已变化")
            with item.open("rb") as handle:
                data = handle.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError("图库文件超过16 MiB")
        return data

    def manifest(self):
        matches = [name for name in self.entries if PurePosixPath(name).name in ("pose-zh.json", "anyangle-gallery.json")]
        if len(matches) != 1:
            raise ValueError("请选择包含一份pose-zh.json或anyangle-gallery.json的完整图库")
        name = matches[0]
        prefix = str(PurePosixPath(name).parent)
        prefix = "" if prefix == "." else prefix + "/"
        value = json.loads(self.read(name).decode("utf-8-sig"))
        return prefix, PurePosixPath(name).name, value


def source_groups(files, prefix, rows):
    if not isinstance(rows, list) or not rows or len(rows) > 6000:
        raise ValueError("图库索引必须含1至6000个视角")
    original_path = prefix + "pose.json"
    originals = json.loads(files.read(original_path).decode("utf-8-sig")) if original_path in files.entries else []
    originals = {row["id"]: row for row in originals}
    # The upstream JSON lives in data/, while image paths are relative to the site root.
    asset_prefix = prefix[:-5] if prefix.endswith("data/") else prefix
    source = dict(SOURCE)
    source["revision"] = hashlib.sha256(encoded(rows)).hexdigest()
    source["license"] = files.read(asset_prefix + "LICENSE").decode("utf-8-sig") if asset_prefix + "LICENSE" in files.entries else "来源未附许可文件"
    groups, seen = {}, set()
    for row in rows:
        view_id = bounded_text(row.get("id"))
        match = re.fullmatch(r"([a-z][a-z0-9_]*)_(P\d+)_(front|side|diag|high|low)", view_id)
        if not match or view_id in seen:
            raise ValueError("图库视角ID无效或重复")
        seen.add(view_id)
        system, number, angle = match.groups()
        key = group_id(source["id"], system, number)
        name = bounded_text(row.get("姿势名称"))
        system_name = bounded_text(row.get("体系"))
        if key not in groups:
            groups[key] = {"id": key, "kind": "reference-set", "name": name,
                           "originalName": bounded_text(originals.get(view_id, {}).get("ポーズ名", name)),
                           "system": system, "systemName": system_name, "number": number,
                           "category": bounded_text(row.get("分类")), "source": source,
                           "people": 2 if "双人" in system_name else 1,
                           "frame": "upper" if "上半身" in system_name else "full", "tags": [], "views": []}
        if groups[key]["name"] != name:
            raise ValueError(f"同组动作名称不一致：{view_id}")
        original = str(safe_path(bounded_text(row.get("原图"))))
        thumbnail = str(safe_path(bounded_text(row.get("缩略图"))))
        groups[key]["views"].append({"id": view_id, "angle": angle, "label": ANGLES[angle],
                                     "originalPath": asset_prefix + original, "thumbnailPath": asset_prefix + thumbnail})
    return list(groups.values())


def portable_groups(value):
    if not isinstance(value, dict) or value.get("kind") != "anyangle-image-pose-library" or value.get("version") != 1:
        raise ValueError("图片姿势包版本不支持")
    groups = copy.deepcopy(value.get("items"))
    if not isinstance(groups, list) or not groups or len(groups) > 6000:
        raise ValueError("图片姿势包没有有效动作")
    ids, views = set(), set()
    for item in groups:
        if not isinstance(item, dict) or not GROUP.fullmatch(str(item.get("id", ""))) or item["id"] in ids or item.get("kind") != "reference-set":
            raise ValueError("动作组ID无效或重复")
        ids.add(item["id"])
        for key in ("name", "originalName", "system", "systemName", "number", "category"):
            item[key] = bounded_text(item.get(key, ""))
        if item.get("people") not in (1, 2) or item.get("frame") not in ("full", "upper"):
            raise ValueError("动作人数或画幅无效")
        source = item.get("source", {})
        if not isinstance(source, dict) or any(not isinstance(v, str) or len(v) > 20000 for v in source.values()):
            raise ValueError("图库来源信息无效")
        if item["id"] != group_id(source.get("id"), item["system"], item["number"]):
            raise ValueError("动作组ID与来源不一致")
        item["tags"] = text_list(item.get("tags", []))
        if "sourceMissing" in item and type(item["sourceMissing"]) is not bool:
            raise ValueError("图库来源状态无效")
        if not isinstance(item.get("views"), list) or not 1 <= len(item["views"]) <= 20:
            raise ValueError("动作组视角无效")
        angles = set()
        for view in item["views"]:
            if not isinstance(view, dict) or view.get("angle") not in ANGLES or view["angle"] in angles:
                raise ValueError("视角无效或重复")
            angles.add(view["angle"])
            view["id"] = bounded_text(view.get("id"))
            if view["id"] in views:
                raise ValueError("图片姿势包包含重复视角")
            views.add(view["id"])
            view["label"] = ANGLES[view["angle"]]
            for field in ("original", "thumbnail"):
                name = view.get(field, {}).get("name", "")
                if not BLOB.fullmatch(name):
                    raise ValueError("图片资源hash无效")
                view[field + "Path"] = "blobs/" + name
    return groups


def text_list(values):
    if not isinstance(values, list) or len(values) > 100:
        raise ValueError("标签须为最多100项的文字列表")
    return list(dict.fromkeys(bounded_text(value, 120) for value in values if value))


class GalleryStore:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if any(is_link(p) for p in [self.root, *self.root.parents]):
            raise ValueError("图库不能使用链接目录")
        self.root.mkdir(parents=True, exist_ok=True)
        for folder in ("blobs", "jobs", "exports"):
            path = self.root / folder
            if is_link(path):
                raise ValueError("图库子目录不能使用链接")
            path.mkdir(exist_ok=True)

    def write_json(self, path, value):
        self.write(path, encoded(value))

    def write(self, path, data):
        if path.is_symlink() or not path.resolve().is_relative_to(self.root.resolve()):
            raise ValueError("图库写入路径越界")
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        try:
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def read(self):
        path = self.root / "index.json"
        if path.is_symlink():
            raise ValueError("图库索引不能使用链接")
        if not path.exists():
            return {"version": 1, "revision": 0, "items": [], "overrides": {}, "presets": [], "collections": [], "lastFilters": {}}
        value = json.loads(path.read_text("utf-8"))
        if value.get("version") != 1 or not isinstance(value.get("items"), list):
            raise ValueError("图片库索引损坏，请从备份恢复")
        return value

    def list(self):
        with LOCK:
            result = self.read()
            for item in result["items"]:
                item.update(result["overrides"].get(item["id"], {}))
                for view in item["views"]:
                    for field in ("original", "thumbnail"):
                        view[field]["ready"] = self.blob_path(view[field]["name"]).is_file()
            result.pop("overrides")
            return result

    def blob_path(self, name):
        if not isinstance(name, str) or not BLOB.fullmatch(name):
            raise ValueError("无效的图片库资源")
        path = self.root / "blobs" / name
        if path.is_symlink() or path.resolve().parent != (self.root / "blobs").resolve():
            raise ValueError("图库资源路径越界")
        return path

    def commit(self, revision, update):
        with LOCK:
            data = self.read()
            if type(revision) is not int or data["revision"] != revision:
                raise GalleryConflict("图片姿势库已在另一窗口更新，请刷新后重试")
            update(data)
            data["revision"] += 1
            self.write_json(self.root / "index.json", data)
            return self.list()

    def patch(self, item_id, changes, revision):
        if not isinstance(changes, dict) or set(changes) - {"name", "favorite", "hidden", "tags", "used"}:
            raise ValueError("不支持的图库修改")
        values = {}
        for key, value in changes.items():
            if key in ("favorite", "hidden", "used"):
                if type(value) is not bool:
                    raise ValueError("图库状态必须是布尔值")
                if key == "used":
                    if value:
                        values["lastUsed"] = time.time()
                else:
                    values[key] = value
            elif key == "tags":
                values[key] = text_list(value)
            else:
                values[key] = bounded_text(value)
                if not values[key]:
                    raise ValueError("动作名称不能为空")
        def update(data):
            if not any(item["id"] == item_id for item in data["items"]):
                raise ValueError("动作组不存在")
            data["overrides"].setdefault(item_id, {}).update(values)
        return self.commit(revision, update)

    def preferences(self, changes, revision):
        result = validate_preferences(changes)
        return self.commit(revision, lambda data: data.update(result))

    def import_files(self, path, progress=None, cancelled=None):
        with CONTENT_LOCK:
            return self._import_files(path, progress, cancelled)

    def _import_files(self, path, progress=None, cancelled=None):
        files = GalleryFiles(path)
        try:
            prefix, name, value = files.manifest()
            portable = name == "anyangle-gallery.json"
            groups = portable_groups(value) if portable else source_groups(files, prefix, value)
            settings = validate_preferences({key: value.get(key, {} if key == "lastFilters" else []) for key in ("presets", "collections", "lastFilters")}) if portable else {}
            overrides = value.get("overrides", {}) if portable else {}
            if not isinstance(overrides, dict):
                raise ValueError("无效的图库用户设置")
            overrides = {key: validate_override(row) for key, row in overrides.items()}
            total = sum(len(item["views"]) * 2 for item in groups)
            done = 0
            for item in groups:
                for view in item["views"]:
                    for field in ("original", "thumbnail"):
                        if cancelled and cancelled():
                            raise ImportCancelled()
                        source_path = view.pop(field + "Path")
                        if portable:
                            source_path = prefix + source_path
                        content = files.read(source_path)
                        info = image_info(content)
                        if portable and info["name"] != view[field]["name"]:
                            raise ValueError(f"图片内容与hash不一致：{view['id']}")
                        target = self.blob_path(info["name"])
                        if not target.exists() or target.read_bytes() != content:
                            self.write(target, content)
                        view[field] = info
                        done += 1
                        if progress:
                            progress(done, total, view["id"])
            with LOCK:
                if cancelled and cancelled():
                    raise ImportCancelled()
                data = self.read()
                existing = {row["id"]: row for row in data["items"]}
                if not portable:
                    incoming = {row["id"] for row in groups}
                    for row in existing.values():
                        if row["source"].get("id") == SOURCE["id"] and row["id"] not in incoming:
                            row["sourceMissing"] = True
                existing.update({row["id"]: row for row in groups})
                data["items"] = list(existing.values())
                if portable:
                    # Import restores missing settings; local edits with the same ID win.
                    for key, preference in overrides.items():
                        if key in existing and key not in data["overrides"]:
                            data["overrides"][key] = preference
                    for key in ("presets", "collections"):
                        merged = {row["id"]: row for row in settings[key]}
                        merged.update({row["id"]: row for row in data[key]})
                        if len(merged) > 200:
                            raise ValueError("合并后的预设或收藏夹超过200项，请先清理")
                        data[key] = list(merged.values())
                    if not data["lastFilters"]:
                        data["lastFilters"] = settings["lastFilters"]
                data["revision"] += 1
                self.write_json(self.root / "index.json", data)
            return {"groups": len(groups), "views": total // 2, "files": done, "revision": data["revision"]}
        finally:
            files.close()

    def export(self, ids=None):
        with CONTENT_LOCK:
            return self._export(ids)

    def _export(self, ids=None):
        with LOCK:
            value = self.read()
        if ids is not None:
            if not isinstance(ids, list) or any(not isinstance(v, str) for v in ids):
                raise ValueError("请选择有效的动作组")
            selected = set(ids)
            value["items"] = [item for item in value["items"] if item["id"] in selected]
            if len(value["items"]) != len(selected):
                raise ValueError("所选动作组已不存在")
            value["overrides"] = {key: data for key, data in value["overrides"].items() if key in selected}
            value["collections"] = [{**row, "ids": [key for key in row["ids"] if key in selected]} for row in value["collections"] if any(key in selected for key in row["ids"])]
        if not value["items"]:
            raise ValueError("没有可导出的图片动作")
        value["kind"] = "anyangle-image-pose-library"
        key = hashlib.sha256(encoded(value)).hexdigest()
        output = self.export_path(key + ".zip")
        if output.exists():
            return output
        handle, temporary_name = tempfile.mkstemp(suffix=".part", dir=output.parent)
        os.close(handle)
        temporary = Path(temporary_name)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                archive.writestr("anyangle-gallery.json", encoded(value))
                written = set()
                for item in value["items"]:
                    for view in item["views"]:
                        for field in ("original", "thumbnail"):
                            name = view[field]["name"]
                            if name not in written:
                                path = self.blob_path(name)
                                if not path.is_file():
                                    raise ValueError("部分图片尚未导入，请恢复原图后再导出")
                                archive.write(path, "blobs/" + name)
                                written.add(name)
            os.replace(temporary, output)
            return output
        finally:
            temporary.unlink(missing_ok=True)

    def export_path(self, name):
        if not isinstance(name, str) or not re.fullmatch(r"[a-f0-9]{64}\.zip", name):
            raise ValueError("无效的图库下载")
        path = self.root / "exports" / name
        if path.is_symlink() or path.resolve().parent != (self.root / "exports").resolve():
            raise ValueError("图库下载路径越界")
        return path

    def clear_cache(self):
        if not CONTENT_LOCK.acquire(blocking=False):
            raise GalleryConflict("图库正在导入或导出，请稍后清理")
        try:
            with LOCK:
                data = self.read()
                used = {view[field]["name"] for item in data["items"] for view in item["views"] for field in ("original", "thumbnail")}
                removed = 0
                for directory in ("exports", "blobs"):
                    for path in (self.root / directory).iterdir():
                        if path.is_symlink() or not path.is_file() or path.resolve().parent != (self.root / directory).resolve():
                            continue
                        if directory == "exports" or BLOB.fullmatch(path.name) and path.name not in used:
                            removed += path.stat().st_size
                            path.unlink()
                return {"removedBytes": removed}
        finally:
            CONTENT_LOCK.release()


def validate_preferences(changes):
    if not isinstance(changes, dict) or set(changes) - {"presets", "collections", "lastFilters"}:
        raise ValueError("未知图库设置")
    result = {}
    for key, rows in changes.items():
        if key == "lastFilters":
            result[key] = filters(rows)
            continue
        if not isinstance(rows, list) or len(rows) > 200:
            raise ValueError("预设或收藏夹最多200项")
        seen, clean = set(), []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("无效的预设或收藏夹")
            ident, name = bounded_text(row.get("id"), 100), bounded_text(row.get("name"), 120)
            if not ident or not name or ident in seen:
                raise ValueError("预设或收藏夹ID/名称无效")
            seen.add(ident)
            item = {"id": ident, "name": name}
            if key == "presets":
                item["filters"] = filters(row.get("filters", {}))
            else:
                ids = row.get("ids", [])
                if not isinstance(ids, list) or len(ids) > 6000 or any(not isinstance(v, str) or not GROUP.fullmatch(v) for v in ids):
                    raise ValueError("收藏夹动作ID无效")
                item["ids"] = list(dict.fromkeys(ids))
            clean.append(item)
        result[key] = clean
    return result


def filters(value):
    allowed = {"query", "category", "type", "people", "frame", "angle", "tab", "source", "sort", "collection", "offline"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError("未知搜索筛选")
    return {key: bounded_text(item, 500) for key, item in value.items()}


def validate_override(value):
    if not isinstance(value, dict) or set(value) - {"name", "tags", "favorite", "hidden", "lastUsed"}:
        raise ValueError("无效的图库用户设置")
    result = {}
    for key, item in value.items():
        if key in ("favorite", "hidden"):
            if type(item) is not bool:
                raise ValueError("无效的收藏/隐藏状态")
        elif key == "name":
            item = bounded_text(item)
            if not item:
                raise ValueError("名称不能为空")
        elif key == "tags":
            item = text_list(item)
        elif type(item) not in (int, float) or not 0 <= item < 100_000_000_000:
            raise ValueError("最近使用时间无效")
        result[key] = item
    return result
