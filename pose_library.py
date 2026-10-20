"""Local, versioned pose catalog. Remote sources are read only on explicit refresh."""
import base64
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import struct
import tempfile
import threading
import urllib.parse
import urllib.request
import zipfile

from PIL import Image


ROOT = Path(__file__).resolve().parent
LOCK = threading.RLock()
TOKEN = re.compile(r"[a-f0-9]{64}\Z")
MAX_FILE = 2 * 1024 * 1024
MAX_PACK = 64 * 1024 * 1024
MAX_FILES = 2048
FORBIDDEN = {"__proto__", "prototype", "constructor"}
SOURCES = [
    {"id": "arekejoker", "name": "精选姿势 · Arekejoker", "repo": "Arekejoker/qwen21-nsfw-pose-skill", "host": "github", "license": "第三方动作许可待核实，供用户本地导入", "prefix": "pose_library/", "ref": "b2690b8dd9ec479039967551dc38c77950b022fb"},
    {"id": "general", "name": "通用姿势 · Totemistyk", "repo": "Totemistyk/General_Poses_PoseStudio", "host": "huggingface", "license": "上游未声明许可", "ref": "23468b2be53ab91fe493754b241d27dcfeb965ed"},
    {"id": "ballet", "name": "芭蕾 · Totemistyk", "repo": "Totemistyk/Ballet_PoseStudio", "host": "huggingface", "license": "上游README声明MIT", "ref": "14d658f5891ac752126f47fabc54993a48980f23"},
    {"id": "miu-main", "name": "主姿势库 · MIUProject", "repo": "MIUProject/VNCCS_PoseLibrary_Main", "host": "huggingface", "license": "上游未声明许可", "ref": "baef0455ef9d3cc31ce3e2a407f722069355c617"},
    {"id": "miu-super", "name": "扩充姿势 · MIUProject", "repo": "MIUProject/MySuperPoseRepo", "host": "huggingface", "license": "上游未声明许可", "ref": "75931b865e95b0ab97aaca2a3756f4d0fab83a32"},
]


class RevisionConflict(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()).hexdigest()


def read_json(data):
    if len(data) > MAX_FILE:
        raise ValueError("单个姿势JSON超过2 MiB")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in FORBIDDEN or key in result:
                raise ValueError("姿势包含保留或重复的字段")
            result[key] = value
        return result
    return json.loads(data.decode("utf-8-sig"), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError("非有限数字")))


def rig_names():
    with (ROOT / "web/vendor/assets/pose_studio_makehuman.v2.bin").open("rb") as handle:
        prefix = handle.read(12)
        if prefix[:8] != b"VNMHJS02":
            raise ValueError("本地人偶骨架资源损坏")
        length = struct.unpack("<I", prefix[8:])[0]
        if length > 4 * 1024 * 1024:
            raise ValueError("骨架头过大")
        header = json.loads(handle.read(length))
    return {bone["name"] for bone in header["bones"]}


def vectors(value, size=3):
    if not isinstance(value, dict) or len(value) > 1000:
        raise ValueError("无效的骨骼旋转表")
    result = {}
    for name, values in value.items():
        if name in FORBIDDEN or not isinstance(name, str) or len(name) > 100:
            raise ValueError("无效的骨骼名称")
        if not isinstance(values, list) or len(values) != size or not all(type(v) in (int, float) and math.isfinite(v) for v in values):
            raise ValueError(f"无效的骨骼旋转：{name}")
        result[name] = list(values)
    return result


def normalize_pose(data, names=None):
    if not isinstance(data, dict):
        raise ValueError("请选择姿势JSON对象")
    names = rig_names() if names is None else names
    kind = "anyangle"
    if data.get("kind") == "anyangle-pose" and data.get("version") == 1:
        pose = data.get("pose")
    elif data.get("schema_version") in (2, 3) and isinstance(data.get("characters"), list) and data["characters"]:
        kind = "vnccs"
        characters = data["characters"]
        actor = next((a for a in characters if a.get("id") == data.get("active_character_id")), characters[0])
        poses = actor.get("poses")
        tab = data.get("activeTab", 0)
        if not isinstance(poses, list) or not poses or type(tab) is not int or not 0 <= tab < len(poses):
            raise ValueError("VNCCS活动人物/姿势不存在")
        pose = poses[tab]
    elif isinstance(data.get("bones"), dict) and not any(key in data for key in ("source", "actors", "referenceLibrary")):
        kind, pose = "vnccs", data
    else:
        raise ValueError("无法识别姿势；支持AnyAngle姿势和VNCCS骨骼JSON")
    if not isinstance(pose, dict):
        raise ValueError("缺少姿势内容")
    bones = vectors(pose.get("bones"))
    unknown = sorted(set(bones) - names)
    known = {key: value for key, value in bones.items() if key in names}
    if not known:
        raise ValueError("姿势中没有本地人偶可识别的骨骼")
    result = {"bones": known}
    if kind == "anyangle":
        # Local saved poses already use this runtime's shaped-rest coordinate system.
        for key in ("bonePositions", "hipBonePosition", "positionDeltas"):
            if pose.get(key):
                result[key] = vectors(pose[key])
        if pose.get("modelRotation"):
            result["modelRotation"] = vectors({"rotation": pose["modelRotation"]})["rotation"]
    warnings = ["未映射骨骼：" + ", ".join(unknown)] if unknown else []
    if kind == "vnccs" and pose.get("hipBonePosition"):
        warnings.append("已保留目标体型；骨盆与接触位置可继续手动微调")
    return result, warnings


def category(name):
    lower = name.lower()
    for key, words in [("舞蹈", ("ballet", "dance", "arabesque", "attitude", "plie", "pirouette")),
                       ("坐姿", ("sit", "seat", "chair")), ("躺姿", ("lay", "lying", "prone", "fetal")),
                       ("运动", ("box", "fight", "punch", "kick", "jump", "run", "walk", "step")),
                       ("跪蹲", ("kneel", "squat", "crawl"))]:
        if any(word in lower for word in words):
            return key
    return "站姿"


TRANSLATIONS = {"Standing": "自然站立", "Boxing Stance": "拳击准备", "Fighting Straight Punch": "直拳",
                "Jumping": "跳跃", "Kicking": "踢腿", "Seated on Floor": "席地而坐",
                "Walking profile": "侧身行走", "Standing Hand on Hip": "站立叉腰",
                "Standing One Leg Up": "单腿抬起", "Sitting legs crossed": "交叉坐姿"}


def normalized_entry(data, name, source=None, names=None):
    if isinstance(data, dict) and data.get("kind") == "anyangle-composition" and data.get("version") == 1:
        slots = data.get("slots")
        if not isinstance(slots, list) or not 2 <= len(slots) <= 128:
            raise ValueError("多人编排需要2至128个人物槽")
        normalized = []
        for slot in slots:
            pose, _ = normalize_pose({"version": 1, "kind": "anyangle-pose", "pose": slot.get("pose")}, names)
            transform = {"x": 0, "y": 0, "z": 0, "yaw": 0, **slot.get("transform", {})}
            if not all(type(transform.get(key)) in (int, float) and math.isfinite(transform[key]) for key in ("x", "y", "z", "yaw")):
                raise ValueError("无效的编排站位")
            normalized.append({"label": str(slot.get("label", "人物"))[:80], "pose": pose,
                               "transform": {key: transform[key] for key in ("x", "y", "z", "yaw")}})
        align = data.get("align", [])
        if not isinstance(align, list) or len(align) > 128:
            raise ValueError("无效的编排接触关系")
        for pair in align:
            if (not isinstance(pair, dict) or not isinstance(pair.get("slots"), list) or len(pair["slots"]) != 2
                    or not all(type(i) is int and 0 <= i < len(slots) for i in pair["slots"]) or pair["slots"][0] == pair["slots"][1]
                    or pair.get("hands") not in (["l", "l"], ["l", "r"], ["r", "l"], ["r", "r"])):
                raise ValueError("无效的双人手部映射")
        entry = normalized_entry({"version": 1, "kind": "anyangle-pose", "pose": normalized[0]["pose"]}, name, source, names)
        entry.update(kind="composition", slots=normalized, align=align, category="多人编排", poseHash=digest({"slots": normalized, "align": align}))
        return entry
    pose, warnings = normalize_pose(data, names)
    if source is not None and not isinstance(source, dict):
        raise ValueError("无效的姿势来源")
    source = {"id": "local", "name": "本地导入", "license": "用户提供", **copy.deepcopy(source or {})}
    name = str(name).strip()[:160] or "未命名姿势"
    return {"kind": "pose", "name": TRANSLATIONS.get(name, name), "originalName": name,
            "category": category(name), "tags": [], "pose": pose, "source": source,
            "rigProfile": "makehuman-v2-degrees", "warnings": warnings, "favorite": False,
            "poseHash": digest(pose)}


def preview_png(data):
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("预览图超过4 MiB")
    with Image.open(io.BytesIO(data)) as image:
        if image.format not in ("PNG", "JPEG", "WEBP") or image.width * image.height > 4_000_000:
            raise ValueError("预览图格式或像素不受支持")
        image = image.convert("RGB")
        image.thumbnail((320, 320))
        output = io.BytesIO(); image.save(output, "PNG")
    return output.getvalue()


def safe_member(name):
    if not isinstance(name, str) or "\\" in name or ":" in name:
        raise ValueError("无效的导入路径")
    parts = PurePosixPath(name).parts
    if name.startswith("/") or ".." in parts or not parts:
        raise ValueError("导入路径越界")
    return "/".join(parts)


def inspect_files(files, source=None):
    if len(files) > MAX_FILES or sum(len(data) for data in files.values()) > MAX_PACK:
        raise ValueError("姿势包超过2048个文件或64 MiB")
    clean = {safe_member(name): data for name, data in files.items()}
    names, entries, errors = rig_names(), [], []
    for path, data in clean.items():
        if not path.lower().endswith(".json") or PurePosixPath(path).name == "manifest.json":
            continue
        try:
            document = read_json(data)
            if document.get("kind") == "anyangle-pose-pack":
                continue
            provenance = {**(source or {}), "path": path}
            entry = normalized_entry(document, PurePosixPath(path).stem, provenance, names)
            entry["importPath"] = path
            stem = path.rsplit(".", 1)[0]
            for ext in (".webp", ".png", ".jpg", ".jpeg"):
                if stem + ext in clean:
                    try:
                        entry["previewData"] = base64.b64encode(preview_png(clean[stem + ext])).decode()
                    except (ValueError, OSError, Image.DecompressionBombError) as error:
                        entry["warnings"].append(str(error))
                    break
            entries.append(entry)
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
            errors.append({"path": path, "error": str(error)})
    return {"entries": entries, "errors": errors}


def inspect_zip(data):
    if len(data) > MAX_PACK:
        raise ValueError("姿势ZIP超过64 MiB")
    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > MAX_FILES or sum(item.file_size for item in members) > MAX_PACK:
            raise ValueError("姿势ZIP解压量超过限制")
        for item in members:
            name = safe_member(item.filename)
            if item.is_dir():
                continue
            if item.external_attr >> 16 & 0o170000 == 0o120000:
                raise ValueError("姿势包不能包含符号链接")
            if name in files:
                raise ValueError("姿势包存在重名文件")
            if item.file_size > 4 * 1024 * 1024 or item.file_size > max(1, item.compress_size) * 1000:
                raise ValueError("姿势包单项过大或压缩比异常")
            if Path(name).suffix.lower() in (".json", ".png", ".webp", ".jpg", ".jpeg"):
                files[name] = archive.read(item)
    manifests = [(name, raw) for name, raw in files.items() if PurePosixPath(name).name == "manifest.json"]
    for name, raw in manifests:
        manifest = read_json(raw)
        if manifest.get("kind") == "anyangle-pose-pack" and manifest.get("version") == 1:
            result = inspect_files(files)
            metadata = {row.get("file"): row for row in manifest.get("items", []) if isinstance(row, dict)}
            for entry in result["entries"]:
                row = metadata.get(entry["importPath"], {})
                for key in ("name", "originalName", "category", "tags", "favorite", "source"):
                    if key in row:
                        entry[key] = row[key]
            return result
    # A source archive may include scripts and workflows: only its pose_library tree is data.
    scoped = {name: raw for name, raw in files.items() if "pose_library" in PurePosixPath(name).parts}
    return inspect_files(scoped or files)


def builtin_entries():
    presets = json.loads((ROOT / "web/editor/builtin-poses.json").read_text("utf-8"))
    entries = [{**normalized_entry({"version": 1, "kind": "anyangle-pose", "pose": {"bones": p["bones"]}}, p["name"],
                               {"id": "builtin", "name": "AnyAngle内置", "license": "项目原创姿势"}),
             "id": "builtin-" + str(i), "builtin": True, "category": p.get("category", "站姿")}
            for i, p in enumerate(presets)]
    for i, (name, yaw, align) in enumerate((("双人合影", [0, 0], []), ("双人对话", [70, -70], []), ("双人握手", [90, -90], [{"slots": [0, 1], "hands": ["r", "r"]}]))):
        slots = [{"label": f"人物{j+1}", "pose": {"bones": presets[0]["bones"]}, "transform": {"x": j * (4 if align else 7), "y": 0, "z": 0, "yaw": yaw[j]}} for j in range(2)]
        entry = normalized_entry({"version": 1, "kind": "anyangle-composition", "slots": slots, "align": align}, name,
                                 {"id": "builtin", "name": "AnyAngle内置编排", "license": "项目原创编排"})
        entries.append({**entry, "id": f"builtin-composition-{i}", "builtin": True})
    for entry in entries:
        entry["builtinPreview"] = entry["id"] + ".png"
    return entries


class PoseLibraryStore:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if any(path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()) for path in [self.root, *self.root.parents]):
            raise ValueError("姿势库不能使用链接目录")
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, name):
        if name != "index.json" and not re.fullmatch(r"[a-f0-9]{64}\.(json|png)", name):
            raise ValueError("无效的姿势库资源名")
        path = self.root / name
        if path.is_symlink() or path.resolve().parent != self.root.resolve():
            raise ValueError("姿势库资源路径越界")
        return path

    def write(self, name, data):
        with tempfile.NamedTemporaryFile(dir=self.root, delete=False) as handle:
            temporary = Path(handle.name); handle.write(data)
        try:
            os.replace(temporary, self.path(name))
        finally:
            temporary.unlink(missing_ok=True)

    def read(self):
        path = self.path("index.json")
        if not path.exists():
            return {"version": 1, "revision": 0, "items": [], "sources": {}}
        value = json.loads(path.read_text("utf-8"))
        if value.get("version") != 1 or not isinstance(value.get("items"), list):
            raise ValueError("姿势库索引损坏，请从导出包恢复")
        return value

    def list(self):
        with LOCK:
            index = self.read()
            builtins = builtin_entries()
            for row in builtins:
                row.update(index.get("overrides", {}).get(row["id"], {}))
            index["items"] = builtins + index["items"]
            index["catalog"] = SOURCES
            return index

    def commit(self, revision, operation):
        with LOCK:
            index = self.read()
            if type(revision) is not int or revision != index["revision"]:
                raise RevisionConflict("姿势库已在另一窗口更新，请刷新列表后重试")
            operation(index)
            index["revision"] += 1
            self.write("index.json", json.dumps(index, ensure_ascii=False, allow_nan=False).encode())
            return self.list()

    def import_entries(self, entries, revision):
        if not isinstance(entries, list) or not entries or len(entries) > MAX_FILES:
            raise ValueError("请选择要入库的有效姿势")
        prepared = []
        builtins = {(row['originalName'], row['poseHash']): row['id'] for row in builtin_entries()}
        for row in entries:
            if not isinstance(row, dict):
                raise ValueError("无效的姿势条目")
            data = ({"kind": "anyangle-composition", "version": 1, "slots": row.get("slots"), "align": row.get("align", [])}
                    if row.get("kind") == "composition" else {"kind": "anyangle-pose", "version": 1, "pose": row.get("pose")})
            entry = normalized_entry(data, row.get("originalName") or row.get("name", ""), row.get("source"))
            for key in ("name", "category"):
                if key in row:
                    if not isinstance(row[key], str) or len(row[key]) > 160:
                        raise ValueError("姿势名称或分类过长")
                    entry[key] = row[key]
            tags = row.get("tags", [])
            if not isinstance(tags, list) or len(tags) > 64 or not all(isinstance(tag, str) and len(tag) < 100 for tag in tags):
                raise ValueError("无效的姿势标签")
            entry["tags"], entry["favorite"] = tags, bool(row.get("favorite"))
            warnings = row.get("warnings", [])
            if not isinstance(warnings, list) or not all(isinstance(value, str) and len(value) < 1000 for value in warnings):
                raise ValueError("无效的兼容性说明")
            entry["warnings"] = list(dict.fromkeys(entry["warnings"] + warnings))
            source = entry["source"]
            if not isinstance(source, dict) or len(json.dumps(source)) > 4096:
                raise ValueError("无效的姿势来源")
            identity = {"source": source.get("id", "local"), "path": source.get("path", entry["originalName"])}
            if identity["source"] == "local":
                identity["pose"] = entry["poseHash"]
            entry["id"] = digest(identity)
            builtin_id = builtins.get((entry["originalName"], entry["poseHash"])) if source.get("id") == "builtin" else None
            if builtin_id:
                entry.update(id=builtin_id, builtin=True)
            entry["createdAt"] = datetime.now(timezone.utc).isoformat()
            if row.get("previewData"):
                raw = preview_png(base64.b64decode(row["previewData"], validate=True))
                name = hashlib.sha256(raw).hexdigest() + ".png"
                entry["preview"] = name
                self.write(name, raw)
            elif isinstance(row.get("preview"), str) and row["preview"].endswith(".png") and self.path(row["preview"]).is_file():
                entry["preview"] = row["preview"]
            prepared.append(entry)
        def update(index):
            by_id = {row["id"]: row for row in index["items"]}
            for entry in prepared:
                if entry.get("builtin"):
                    overrides = index.setdefault("overrides", {}).setdefault(entry["id"], {})
                    for key in ("name", "category", "favorite", "tags", "preview"):
                        if key in entry:
                            overrides.setdefault(key, entry[key])
                    continue
                previous = by_id.get(entry["id"])
                if not previous and entry["source"].get("id") not in (None, "local") and entry["source"].get("path"):
                    previous = next((row for row in by_id.values() if row["source"].get("id") == entry["source"].get("id")
                                     and row["source"].get("path") == entry["source"].get("path")), None)
                if previous:
                    entry["id"] = previous["id"]
                    for key in ("name", "favorite", "tags", "hidden", "createdAt"):
                        if key in previous:
                            entry[key] = previous[key]
                    if not entry.get("preview") and previous.get("preview"):
                        entry["preview"] = previous["preview"]
                by_id[entry["id"]] = entry
            index["items"] = list(by_id.values())
        return self.commit(revision, update)

    def patch(self, item_id, values, revision):
        builtin = next((row for row in builtin_entries() if row["id"] == item_id), None)
        if not builtin and not TOKEN.fullmatch(item_id or ""):
            raise ValueError("无效的姿势条目")
        def update(index):
            entry = index.setdefault("overrides", {}).setdefault(item_id, {}) if builtin else next((row for row in index["items"] if row["id"] == item_id), None)
            if entry is None:
                raise ValueError("姿势不存在")
            for key, value in values.items():
                if key in ("name", "category") and isinstance(value, str) and 0 < len(value.strip()) <= 160:
                    entry[key] = value.strip()
                elif key in ("favorite", "hidden") and type(value) is bool:
                    entry[key] = value
                elif key == "tags" and isinstance(value, list) and len(value) <= 64 and all(isinstance(tag, str) and len(tag) < 100 for tag in value):
                    entry[key] = value
                elif key == "previewData" and isinstance(value, str):
                    raw = preview_png(base64.b64decode(value, validate=True))
                    name = hashlib.sha256(raw).hexdigest() + ".png"
                    self.write(name, raw)
                    entry["preview"] = name
                else:
                    raise ValueError("无效的姿势修改字段")
        return self.commit(revision, update)

    def delete(self, ids, revision):
        if not isinstance(ids, list) or not all(isinstance(value, str) and TOKEN.fullmatch(value) for value in ids):
            raise ValueError("请选择用户姿势；内置姿势只能隐藏")
        return self.commit(revision, lambda index: index.update(items=[row for row in index["items"] if row["id"] not in ids]))

    def export(self, ids=None):
        if ids is not None and (not isinstance(ids, list) or not all(isinstance(value, str) for value in ids)):
            raise ValueError("导出姿势ID必须是列表")
        items = self.list()["items"]
        if ids is not None:
            items = [row for row in items if row["id"] in ids]
        output, manifest = io.BytesIO(), {"version": 1, "kind": "anyangle-pose-pack", "items": []}
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for row in items:
                file = row["id"] + ".json"
                payload = ({"version": 1, "kind": "anyangle-composition", "slots": row["slots"], "align": row.get("align", [])}
                           if row.get("kind") == "composition" else {"version": 1, "kind": "anyangle-pose", "pose": row["pose"]})
                archive.writestr(file, json.dumps(payload))
                manifest["items"].append({**{key: row[key] for key in ("name", "originalName", "category", "tags", "favorite", "source")}, "file": file})
                if row.get("preview"):
                    archive.writestr(row["id"] + ".png", self.path(row["preview"]).read_bytes())
                elif row.get("builtinPreview"):
                    preview = ROOT / "web/editor/pose-previews" / row["builtinPreview"]
                    if preview.is_file():
                        archive.writestr(row["id"] + ".png", preview.read_bytes())
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        return output.getvalue()


def remote_bytes(url, maximum=MAX_FILE):
    request = urllib.request.Request(url, headers={"User-Agent": "AnyAngle-Studio-pose-library", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("来源文件超过容量限制")
    return data


def fetch_source(source_id, latest=False, progress=None):
    source = next((row for row in SOURCES if row["id"] == source_id), None)
    if not source:
        raise ValueError("请选择内置的姿势来源")
    source = dict(source); repo = source["repo"]; ref = source["ref"]
    if source["host"] == "github":
        if latest:
            ref = json.loads(remote_bytes(f"https://api.github.com/repos/{repo}/commits/main"))["sha"]
        tree = json.loads(remote_bytes(f"https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"))["tree"]
        all_paths = {row["path"] for row in tree if row.get("type") == "blob"}
        paths = [path for path in sorted(all_paths) if path.startswith(source["prefix"]) and path.lower().endswith(".json")]
        base = f"https://raw.githubusercontent.com/{repo}/{ref}/"
    else:
        metadata = json.loads(remote_bytes(f"https://huggingface.co/api/models/{repo}"))
        if latest:
            ref = metadata["sha"]
        else:
            metadata = json.loads(remote_bytes(f"https://huggingface.co/api/models/{repo}/revision/{ref}"))
        all_paths = {row["rfilename"] for row in metadata["siblings"]}
        paths = [path for path in sorted(all_paths) if path.lower().endswith(".json") and path != "pose_library.json"]
        base = f"https://huggingface.co/{repo}/resolve/{ref}/"
    if len(paths) > MAX_FILES:
        raise ValueError("来源文件数量超过限制")
    manifest = {}
    if "pose_library.json" in all_paths:
        document = json.loads(remote_bytes(base + "pose_library.json"))
        manifest = {safe_member(row["json_path"]): row for row in document.get("poses", []) if isinstance(row, dict) and isinstance(row.get("json_path"), str)}
    source["ref"] = ref
    result, errors, names = [], [], rig_names()
    for i, path in enumerate(paths):
        if progress:
            progress(i, len(paths), path)
        try:
            raw = remote_bytes(base + urllib.parse.quote(safe_member(path), safe="/"))
            provenance = {**source, "path": path, "sha256": hashlib.sha256(raw).hexdigest()}
            metadata = manifest.get(path, {})
            if metadata.get("json_sha256") and metadata["json_sha256"] != provenance["sha256"]:
                raise ValueError("来源JSON与清单SHA256不一致")
            entry = normalized_entry(read_json(raw), metadata.get("name") or PurePosixPath(path).stem, provenance, names)
            if source_id == "ballet":
                entry["category"] = "舞蹈"
            entry["tags"] = metadata.get("tags", [])
            image_path = metadata.get("preview_path")
            if not image_path:
                stem = path.rsplit(".", 1)[0]
                image_path = next((stem + ext for ext in (".webp", ".png", ".jpg") if stem + ext in all_paths), None)
            if image_path and image_path in all_paths:
                try:
                    image = remote_bytes(base + urllib.parse.quote(safe_member(image_path), safe="/"), 4 * 1024 * 1024)
                    if metadata.get("preview_sha256") and metadata["preview_sha256"] != hashlib.sha256(image).hexdigest():
                        raise ValueError("来源预览与清单SHA256不一致")
                    entry["previewData"] = base64.b64encode(preview_png(image)).decode()
                except (OSError, ValueError, Image.DecompressionBombError) as error:
                    entry["warnings"].append(f"预览未读取：{error}")
            result.append(entry)
        except (ValueError, TypeError, OSError, AttributeError, KeyError) as error:
            errors.append({"path": path, "error": str(error)})
    if progress:
        progress(len(paths), len(paths), "")
    return {"entries": result, "errors": errors, "source": source, "candidateCount": len(paths)}
