"""Narrow local catalog endpoints, independent of ComfyUI execution."""
import asyncio
import base64
import json
import time
import uuid
import zipfile

from aiohttp import web
from PIL import Image

from .pose_library import (MAX_FILE, MAX_PACK, PoseLibraryStore, RevisionConflict,
                           fetch_source, inspect_files, inspect_zip)


def register_pose_routes(routes, store_factory):
    jobs = {}
    def store():
        return PoseLibraryStore(store_factory().root / "pose_library")

    async def guarded(action):
        try:
            result = await action()
            return result if isinstance(result, web.StreamResponse) else web.json_response(result)
        except RevisionConflict as error:
            return web.json_response({"error": str(error)}, status=409)
        except (ValueError, TypeError, KeyError, AttributeError, OSError, RuntimeError, RecursionError, zipfile.BadZipFile, Image.DecompressionBombError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio/pose-library")
    async def catalog(request):
        return await guarded(lambda: asyncio.to_thread(store().list))

    @routes.post("/anyangle-studio/pose-library/inspect")
    async def inspect(request):
        async def action():
            if not request.content_type.startswith("multipart/"):
                raise ValueError("请选择姿势文件、目录或ZIP")
            reader = await request.multipart()
            files, total, archive = {}, 0, None
            while part := await reader.next():
                if not part.filename:
                    continue
                content = bytearray()
                while chunk := await part.read_chunk():
                    total += len(chunk); content.extend(chunk)
                    if total > MAX_PACK:
                        raise ValueError("导入总量超过64 MiB")
                name = part.filename
                if name.lower().endswith(".zip"):
                    if archive is not None or files:
                        raise ValueError("每次请选择一个姿势ZIP")
                    archive = bytes(content)
                else:
                    if archive is not None or name in files:
                        raise ValueError("重复文件名或混合ZIP导入")
                    files[name] = bytes(content)
            if archive is not None:
                return await asyncio.to_thread(inspect_zip, archive)
            return await asyncio.to_thread(inspect_files, files)
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-library/import")
    async def import_entries(request):
        async def action():
            data = await request.json()
            return await asyncio.to_thread(store().import_entries, data.get("entries"), data.get("revision"))
        return await guarded(action)

    @routes.patch("/anyangle-studio/pose-library/items/{id}")
    async def patch_entry(request):
        async def action():
            data = await request.json()
            return await asyncio.to_thread(store().patch, request.match_info["id"], data.get("changes", {}), data.get("revision"))
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-library/delete")
    async def delete_entries(request):
        async def action():
            data = await request.json()
            return await asyncio.to_thread(store().delete, data.get("ids"), data.get("revision"))
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-library/export")
    async def export_entries(request):
        async def action():
            data = await request.json()
            content = await asyncio.to_thread(store().export, data.get("ids"))
            return web.Response(body=content, content_type="application/zip", headers={"Content-Disposition": 'attachment; filename="anyangle-poses.zip"'})
        return await guarded(action)

    @routes.get("/anyangle-studio/pose-library/previews/{name}")
    async def preview(request):
        async def action():
            name = request.match_info["name"]
            if not name.endswith(".png"):
                raise ValueError("无效的预览资源")
            return web.Response(body=await asyncio.to_thread(store().path(name).read_bytes), content_type="image/png")
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-library/sources/{source}/refresh")
    async def refresh_source(request):
        async def action():
            data = await request.json()
            # Only this explicit endpoint performs network access. No refresh on startup/list.
            if len([job for job in jobs.values() if job["state"] == "running"]) >= 2:
                raise ValueError("已有两个来源正在读取，请等待完成")
            source = request.match_info["source"]
            for old in list(jobs):
                if jobs[old]["state"] != "running" and time.monotonic() - jobs[old]["started"] > 1800:
                    del jobs[old]
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "source": source, "state": "running", "index": 0, "total": 0, "path": "", "started": time.monotonic()}
            jobs[job_id] = job
            def progress(index, total, path):
                job.update(index=index, total=total, path=path)
            async def work():
                try:
                    result = await asyncio.to_thread(fetch_source, source, bool(data.get("latest")), progress)
                    job.update(state="ready", result=result)
                except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError, Image.DecompressionBombError) as error:
                    job.update(state="failed", error=str(error))
            job["task"] = asyncio.create_task(work())
            return {"id": job_id}
        return await guarded(action)

    @routes.get("/anyangle-studio/pose-library/jobs/{id}")
    async def job_status(request):
        async def action():
            job = jobs.get(request.match_info["id"])
            if not job:
                raise ValueError("来源读取任务不存在或已过期")
            return {key: value for key, value in job.items() if key not in ("task", "started")}
        return await guarded(action)
