"""Immutable assets and applied scenes under ComfyUI's persistent input directory."""
import base64
import binascii
import hashlib
import io
import json
import math
from pathlib import Path
import re
import tempfile
import zipfile

from PIL import Image, ImageOps

PROMPT = "Change the camera angle from <image2> to <image1>."
BASE_PROMPTS = {
    "coarse": "Use <image1> as the identity, clothing and style reference. Recreate the same subject at the camera angle and composition shown by <image2>.",
    "pose": "Use <image1> as the identity, clothing and style reference. Recreate the same subject in the body pose and framing shown by <image2>.",
    "depth": "Use <image1> as the identity, clothing and style reference. Follow the spatial depth, layout and occlusion relationships shown by <image2>.",
    "canny": "Use <image1> as the identity, clothing and style reference. Follow the silhouette, contours and major edge layout shown by <image2>.",
}


def conditioning_for(scene):
    conditioning = scene.get("conditioning") or {}
    if not isinstance(conditioning, dict):
        raise ValueError("Invalid guide settings")
    model = conditioning.get("model", "anyangle")
    guide = conditioning.get("guide", "coarse")
    if model not in ("anyangle", "base") or guide not in BASE_PROMPTS:
        raise ValueError("Unknown model or guide mode")
    return model, guide, conditioning


TOKEN = re.compile(r"[a-f0-9]{64}\Z")
ASSET = re.compile(r"[a-f0-9]{64}\.(png|glb|ply)\Z")


class StudioStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, name):
        if not isinstance(name, str) or (not ASSET.fullmatch(name) and not re.fullmatch(r"[a-f0-9]{64}\.json", name)):
            raise ValueError("Invalid AnyAngle asset reference")
        candidate = self.root / name
        if candidate.is_symlink():
            raise ValueError("AnyAngle asset is outside its storage directory")
        path = candidate.resolve()
        if path.parent != self.root or path.name != name:
            raise ValueError("AnyAngle asset is outside its storage directory")
        return path

    def write(self, name, data):
        path = self.path(name)
        if path.exists() and path.read_bytes() == data:
            return
        with tempfile.NamedTemporaryFile(dir=self.root, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        try:
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def asset(self, data, kind):
        if kind == "ply":
            end = data.find(b"end_header\n")
            if end < 0 or end > 16384 or not data.startswith(b"ply\nformat binary_little_endian 1.0\n"):
                raise ValueError("Choose a binary little-endian Gaussian PLY")
            header = data[:end].decode("ascii")
            count = re.search(r"element vertex (\d+)", header)
            fields = re.findall(r"property float (\w+)", header)
            if not count or not {"x", "y", "z", "opacity", "f_dc_0", "f_dc_1", "f_dc_2", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"}.issubset(fields):
                raise ValueError("PLY must contain Gaussian positions, colors, scales, opacity and rotations")
            if len(data) - end - len(b"end_header\n") != int(count[1]) * len(fields) * 4:
                raise ValueError("Gaussian PLY has invalid record lengths")
            meta = {"gaussians": int(count[1])}
        elif kind == "glb":
            if len(data) < 20 or data[:4] != b"glTF" or int.from_bytes(data[4:8], "little") != 2:
                raise ValueError("Please choose a glTF 2.0 binary (.glb)")
            if int.from_bytes(data[8:12], "little") != len(data):
                raise ValueError("GLB is truncated or its length is invalid")
            if data[16:20] != b"JSON":
                raise ValueError("GLB is missing its JSON chunk")
            length = int.from_bytes(data[12:16], "little")
            if length > len(data) - 20:
                raise ValueError("GLB JSON chunk is truncated")
            doc = json.loads(data[20:20 + length])
            if not isinstance(doc, dict):
                raise ValueError("Invalid GLB document")
            buffers, images = doc.get("buffers", []), doc.get("images", [])
            if not isinstance(buffers, list) or not isinstance(images, list):
                raise ValueError("Invalid GLB resources")
            for resource in buffers + images:
                if not isinstance(resource, dict):
                    raise ValueError("Invalid GLB resource")
                uri = resource.get("uri", "")
                if not isinstance(uri, str) or (uri and not uri.startswith("data:")):
                    raise ValueError("GLB must embed its textures and buffers; external URLs are not loaded")
            required = doc.get("extensionsRequired", [])
            if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
                raise ValueError("Invalid GLB extensions")
            if set(required) & {"KHR_draco_mesh_compression", "KHR_texture_basisu", "EXT_meshopt_compression"}:
                raise ValueError("Export this GLB without Draco, Meshopt or KTX2 compression")
            meta = {}
        elif kind == "png":
            try:
                opened = Image.open(io.BytesIO(data))
            except Image.DecompressionBombError as error:
                raise ValueError("Image exceeds 32 megapixels") from error
            with opened as source:
                if source.width * source.height > 32_000_000:
                    raise ValueError("Image exceeds 32 megapixels")
                source = ImageOps.exif_transpose(source)
                source.load()
                image = source.convert("RGB")
                buffer = io.BytesIO()
                image.save(buffer, format="PNG")
                data = buffer.getvalue()
                meta = {"width": image.width, "height": image.height}
        else:
            raise ValueError("Only GLB, Gaussian PLY and images are supported")
        digest = hashlib.sha256(data).hexdigest()
        name = f"{digest}.{kind}"
        self.write(name, data)
        return {"name": name, "sha256": digest, **meta}

    def read_asset(self, name):
        path = self.path(name)
        try:
            data = path.read_bytes()
        except FileNotFoundError as error:
            raise ValueError("AnyAngle asset is missing; reopen the editor and import/apply it again") from error
        if hashlib.sha256(data).hexdigest() != name.split(".")[0]:
            raise ValueError("AnyAngle asset failed its integrity check; reimport and apply it again")
        return data

    def save_scene(self, scene, png):
        if not isinstance(scene, dict) or scene.get("version") != 1:
            raise ValueError("Unsupported AnyAngle scene version")
        width, height = scene.get("width"), scene.get("height")
        if not isinstance(scene.get("camera"), dict) or not isinstance(scene.get("source"), dict):
            raise ValueError("Scene camera and source must be objects")
        if any(type(v) is not int or not 64 <= v <= 4096 for v in (width, height)):
            raise ValueError("Guide width and height must be integers from 64 to 4096")
        for key in ("azimuth", "elevation", "zoom", "offsetX", "offsetY"):
            value = scene.get("camera", {}).get(key)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"Invalid camera {key}")
        if scene["camera"]["zoom"] <= 0:
            raise ValueError("Camera zoom must be positive")
        model, guide_mode, conditioning = conditioning_for(scene)
        source_kind = scene.get("source", {}).get("kind")
        if source_kind not in ("human", "glb", "splat", "empty"):
            raise ValueError("Select a reconstructed scene, human or GLB source")
        if model == "base" and guide_mode == "depth" and not conditioning.get("map"):
            raise ValueError("Import a Depth Anything map before applying")
        if model == "base" and guide_mode == "pose" and source_kind != "human" and not (
                conditioning.get("map") and conditioning.get("mapKind") == "pose"):
            raise ValueError("OpenPose guide requires a pose image or human mannequin")
        if source_kind == "empty" and not (model == "base" and guide_mode in ("pose", "depth", "canny") and
                                           (conditioning.get("map") or scene.get("reference"))):
            raise ValueError("Current guide requires a 3D scene or an imported image")
        guide_asset = conditioning.get("map")
        if guide_asset:
            name = guide_asset.get("name") if isinstance(guide_asset, dict) else None
            if not isinstance(name, str) or not name.endswith(".png"):
                raise ValueError("Structural guide must be a PNG image")
            self.read_asset(name)
        if scene["source"]["kind"] in ("glb", "splat"):
            expected = ".glb" if scene["source"]["kind"] == "glb" else ".ply"
            source_name = scene["source"].get("name")
            if not isinstance(source_name, str) or not source_name.endswith(expected):
                raise ValueError("Scene source has the wrong asset format")
            self.read_asset(source_name)
        reference = scene.get("reference")
        source_reference = scene["source"].get("reference")
        if scene["source"]["kind"] == "splat" and (not isinstance(source_reference, dict) or not isinstance(reference, dict)
                                                  or not isinstance(reference.get("name"), str)
                                                  or source_reference.get("name") != reference.get("name")):
            raise ValueError("参考图与重建主体不一致，请重新重建后应用")
        if reference:
            name = reference.get("name") if isinstance(reference, dict) else None
            if not isinstance(name, str) or not name.endswith(".png"):
                raise ValueError("Reference must be an image")
            self.read_asset(name)
        if not isinstance(png, str) or not png.startswith("data:image/png;base64,"):
            raise ValueError("Guide must be a PNG capture")
        try:
            data = base64.b64decode(png.split(",", 1)[1], validate=True)
        except binascii.Error as error:
            raise ValueError("Guide must contain valid PNG data") from error
        guide = self.asset(data, "png")
        if (guide["width"], guide["height"]) != (width, height):
            raise ValueError("Guide dimensions do not match the scene; capture again")
        document = {"scene": scene, "guide": guide, "prompt": PROMPT if model == "anyangle" else BASE_PROMPTS[guide_mode]}
        encoded = json.dumps(document, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()
        digest = hashlib.sha256(encoded).hexdigest()
        self.write(f"{digest}.json", encoded)
        return {"version": 1, "id": digest}

    def load_scene(self, snapshot):
        token = json.loads(snapshot) if isinstance(snapshot, str) else snapshot
        if not isinstance(token, dict) or token.get("version") != 1 or not isinstance(token.get("id"), str) or not TOKEN.fullmatch(token["id"]):
            raise ValueError("Open AnyAngle Studio and apply a shot before running this node")
        document = json.loads(self.read_asset(f"{token['id']}.json"))
        if not isinstance(document, dict) or not isinstance(document.get("guide"), dict) or not isinstance(document.get("scene"), dict):
            raise ValueError("This reference is not an AnyAngle scene snapshot")
        guide = self.read_asset(document["guide"]["name"])
        return document, guide

    def save_batch(self, views):
        if not isinstance(views, list) or not views:
            raise ValueError("Batch must contain at least one saved view")
        saved = []
        for index, view in enumerate(views, 1):
            if not isinstance(view, dict):
                raise ValueError("Invalid batch view")
            document, _ = self.load_scene(view.get("snapshot"))
            saved.append({"snapshot": view["snapshot"], "file": f"view-{index:04d}.png",
                          "camera": document["scene"]["camera"], "width": document["scene"]["width"],
                          "height": document["scene"]["height"], "prompt": document["prompt"],
                          "prompt_id": view.get("prompt_id")})
        encoded = json.dumps({"version": 1, "kind": "anyangle-batch", "views": saved}, ensure_ascii=False, allow_nan=False).encode()
        digest = hashlib.sha256(encoded).hexdigest()
        self.write(f"{digest}.json", encoded)
        return {"id": digest, "count": len(saved)}

    def batch_archive(self, batch_id):
        batch = json.loads(self.read_asset(f"{batch_id}.json"))
        if batch.get("kind") != "anyangle-batch" or not isinstance(batch.get("views"), list):
            raise ValueError("This reference is not an AnyAngle batch")
        archive = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        try:
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as output:
                output.writestr("manifest.json", json.dumps(batch, ensure_ascii=False, indent=2))
                for index, view in enumerate(batch["views"], 1):
                    _, png = self.load_scene(view["snapshot"])
                    output.writestr(f"view-{index:04d}.png", png)
            archive.seek(0)
            return archive
        except Exception:
            archive.close()
            raise
