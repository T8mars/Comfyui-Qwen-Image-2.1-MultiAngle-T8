import asyncio
import json
import hashlib
import math

from aiohttp import web
from PIL import UnidentifiedImageError
from server import PromptServer
from .reconstruction import reconstruction_config


def register_routes(store_factory):
    routes = PromptServer.instance.routes

    @routes.get("/anyangle-studio/reconstruction-config")
    async def reconstruction_models(request):
        return web.json_response(reconstruction_config())

    @routes.post("/anyangle-studio/poses")
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
    async def download_pose(request):
        try:
            data = await asyncio.to_thread(store_factory().read_asset, request.match_info["id"] + ".json")
            if json.loads(data).get("kind") != "anyangle-pose":
                raise ValueError("Invalid pose document")
            return web.Response(body=data, content_type="application/json", headers={"Content-Disposition": 'attachment; filename="anyangle-pose.json"'})
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)

    @routes.post("/anyangle-studio/assets")
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
                    raise ValueError("GLB upload exceeds 256 MB")
            kind = "glb" if (part.filename or "").lower().endswith(".glb") else "png"
            asset = await asyncio.to_thread(store_factory().asset, bytes(data), kind)
            asset["label"] = (part.filename or "Imported asset")[:160]
            return web.json_response(asset)
        except (ValueError, OSError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio/assets/{name}")
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
    async def snapshot(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Invalid scene payload")
            result = await asyncio.to_thread(store_factory().save_scene, payload.get("scene"), payload.get("png"))
            return web.json_response(result)
        except (ValueError, OSError, UnidentifiedImageError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio/snapshots/{id}")
    async def read_snapshot(request):
        try:
            document, _ = await asyncio.to_thread(store_factory().load_scene, {"version": 1, "id": request.match_info["id"]})
            return web.json_response(document)
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=404)
