import asyncio
import json
import hashlib
import math

from aiohttp import web
from PIL import UnidentifiedImageError
from server import PromptServer
from .reconstruction import reconstruction_config
from .dwpose import extract_pose
from .depth import extract_depth
from .install_assets import repair_editor_assets


LOCAL_ADDRESSES = {"127.0.0.1", "::1"}


def _require_local(handler):
    async def wrapped(request):
        if request.remote not in LOCAL_ADDRESSES:
            return web.json_response({"error": "Forbidden"}, status=403)
        return await handler(request)
    return wrapped


def register_routes(store_factory):
    routes = PromptServer.instance.routes

    @routes.post("/anyangle-studio/repair-human")
    @_require_local
    async def repair_human(request):
        try:
            await asyncio.to_thread(repair_editor_assets)
            return web.json_response({"repaired": True})
        except (OSError, ValueError) as error:
            return web.json_response({"error": f"修复失败：{error}。可在节点目录运行 python install_assets.py。"}, status=400)

    @routes.get("/anyangle-studio/reconstruction-config")
    @_require_local
    async def reconstruction_models(request):
        try:
            selections = dict(request.query)
            keep_background = selections.pop("keep_background", "0")
            if keep_background not in ("0", "1"):
                raise ValueError("Invalid keep_background option")
            config = await asyncio.to_thread(reconstruction_config, selections, keep_background == "1")
            return web.json_response(config)
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/anyangle-studio/dwpose")
    @_require_local
    async def photo_to_pose(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid pose request")
            store = store_factory()
            name = payload.get("reference")
            if not isinstance(name, str) or not name.endswith(".png"):
                raise ValueError("请先连接或导入参考原图")
            photo = await asyncio.to_thread(store.read_asset, name)
            points, preview, low_confidence, full_body = await asyncio.to_thread(extract_pose, photo)
            asset = await asyncio.to_thread(store.asset, preview, "png")
            asset["label"] = "DWPose · 原图姿势"
            return web.json_response({"asset": asset, "points": points, "visibleOnly": True, "lowConfidence": low_confidence, "fullBody": full_body})
        except (ValueError, TypeError, OSError, RuntimeError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/anyangle-studio/depth")
    @_require_local
    async def photo_to_depth(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid depth request")
            store = store_factory()
            name = payload.get("reference")
            if not isinstance(name, str) or not name.endswith(".png"):
                raise ValueError("请先连接或导入参考原图")
            photo = await asyncio.to_thread(store.read_asset, name)
            png = await asyncio.to_thread(extract_depth, photo)
            asset = await asyncio.to_thread(store.asset, png, "png")
            asset["label"] = "Depth Anything 3 · 原图深度"
            return web.json_response({"asset": asset})
        except (ValueError, TypeError, OSError, RuntimeError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/anyangle-studio/poses")
    @_require_local
    async def save_pose(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict) or payload.get("version") != 1 or payload.get("kind") != "anyangle-pose":
                raise ValueError("Invalid pose document")
            bones = payload.get("pose", {}).get("bones")
            if not isinstance(bones, dict) or len(bones) > 1000:
                raise ValueError("Invalid pose bones")
            for values in bones.values():
                if not isinstance(values, list) or len(values) != 3 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
                    raise ValueError("Invalid bone rotation")
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, sort_keys=True).encode()
            digest = hashlib.sha256(encoded).hexdigest()
            await asyncio.to_thread(store_factory().write, f"{digest}.json", encoded)
            return web.json_response({"id": digest})
        except (ValueError, TypeError, AttributeError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio/poses/{id}")
    @_require_local
    async def download_pose(request):
        try:
            data = await asyncio.to_thread(store_factory().read_asset, request.match_info["id"] + ".json")
            if json.loads(data).get("kind") != "anyangle-pose":
                raise ValueError("Invalid pose document")
            return web.Response(body=data, content_type="application/json", headers={"Content-Disposition": 'attachment; filename="anyangle-pose.json"'})
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)

    @routes.post("/anyangle-studio/assets")
    @_require_local
    async def upload(request):
        try:
            reader = await request.multipart()
            part = await reader.next()
            if part is None or part.name != "file":
                raise ValueError("Choose a file to import")
            data = bytearray()
            while chunk := await part.read_chunk(1024 * 1024):
                data.extend(chunk)
                if len(data) > 256 * 1024 * 1024:
                    raise ValueError("Asset upload exceeds 256 MB")
            kind = "glb" if (part.filename or "").lower().endswith(".glb") else "png"
            asset = await asyncio.to_thread(store_factory().asset, bytes(data), kind)
            asset["label"] = (part.filename or "Imported asset")[:160]
            return web.json_response(asset)
        except (ValueError, OSError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio/assets/{name}")
    @_require_local
    async def asset(request):
        try:
            name = request.match_info["name"]
            if not name.endswith((".png", ".glb", ".ply")):
                raise ValueError("Invalid asset")
            data = await asyncio.to_thread(store_factory().read_asset, name)
            content_type = "image/png" if name.endswith(".png") else "model/gltf-binary" if name.endswith(".glb") else "application/octet-stream"
            return web.Response(body=data, content_type=content_type,
                                headers={"Cache-Control": "private, max-age=31536000, immutable"})
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)

    @routes.post("/anyangle-studio/snapshots")
    @_require_local
    async def snapshot(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid scene payload")
            result = await asyncio.to_thread(store_factory().save_scene, payload.get("scene"), payload.get("png"))
            return web.json_response(result)
        except (ValueError, OSError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/anyangle-studio/batches")
    @_require_local
    async def save_batch(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid batch payload")
            result = await asyncio.to_thread(store_factory().save_batch, payload.get("views"))
            return web.json_response(result)
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio/batch-guides/{id}")
    @_require_local
    async def download_batch(request):
        try:
            archive = await asyncio.to_thread(store_factory().batch_archive, request.match_info["id"])
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)
        try:
            response = web.StreamResponse(headers={"Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="anyangle-guides.zip"'})
            await response.prepare(request)
            while chunk := await asyncio.to_thread(archive.read, 1024 * 1024):
                await response.write(chunk)
            await response.write_eof()
            return response
        finally:
            archive.close()

    @routes.get("/anyangle-studio/snapshots/{id}")
    @_require_local
    async def read_snapshot(request):
        try:
            document, _ = await asyncio.to_thread(store_factory().load_scene, {"version": 1, "id": request.match_info["id"]})
            return web.json_response(document)
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)
