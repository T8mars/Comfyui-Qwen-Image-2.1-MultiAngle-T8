"""Stream gallery uploads and serve local assets without keeping the pack in memory."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import threading
import time
import uuid
import zipfile

from aiohttp import web
from PIL import Image, UnidentifiedImageError

from .pose_gallery import (GalleryStore, GalleryConflict, ImportCancelled, JOB,
                           MAX_FILE, MAX_PACK, MAX_FILES, safe_path, is_link)


class GalleryJobs:
    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()
        self.workers = {}
        self.cancels = {}
        self.uploads = set()

    def path(self, ident):
        if not isinstance(ident, str) or not JOB.fullmatch(ident):
            raise ValueError("无效的图库任务")
        path = self.store.root / "jobs" / ident
        if is_link(path) or path.resolve().parent != (self.store.root / "jobs").resolve():
            raise ValueError("图库任务路径越界")
        return path

    def read(self, ident):
        path = self.path(ident) / "job.json"
        if not path.is_file() or path.is_symlink():
            raise ValueError("图库任务不存在")
        return json.loads(path.read_text("utf-8"))

    def update(self, ident, **changes):
        with self.lock:
            value = self.read(ident)
            value.update(changes, updated=time.time())
            self.store.write_json(self.path(ident) / "job.json", value)
            return value

    def create(self, kind, name):
        if kind not in ("directory", "zip"):
            raise ValueError("请选择图库目录或ZIP")
        ident = uuid.uuid4().hex
        path = self.path(ident)
        path.mkdir()
        (path / "files").mkdir()
        value = {"id": ident, "kind": kind, "name": str(name)[:200], "state": "uploading",
                 "completed": 0, "total": 0, "uploaded": {}, "bytes": 0, "updated": time.time()}
        self.store.write_json(path / "job.json", value)
        return self.public(value)

    def public(self, value):
        return {key: data for key, data in value.items() if key != "uploaded"} | {"uploadedFiles": len(value["uploaded"])}

    def status(self, ident):
        with self.lock:
            value = self.read(ident)
            worker = self.workers.get(ident)
            if value["state"] == "running" and (worker is None or not worker.is_alive()):
                value = self.update(ident, state="paused", error="导入进程已停止，可继续导入")
            return self.public(value)

    def list(self):
        ids = [path.name for path in (self.store.root / "jobs").iterdir() if JOB.fullmatch(path.name)]
        return sorted((self.status(ident) for ident in ids), key=lambda item: item["updated"], reverse=True)[:30]

    async def upload(self, ident, name, content):
        with self.lock:
            if ident in self.uploads:
                raise GalleryConflict("此任务已有文件正在上传")
            job = self.read(ident)
            if job["state"] != "uploading":
                raise GalleryConflict("任务不在上传状态，请新建导入或继续已有任务")
            name = "archive.zip" if job["kind"] == "zip" else str(safe_path(name))
            if len(job["uploaded"]) >= MAX_FILES and name not in job["uploaded"]:
                raise ValueError("文件超过12000项")
            if any(key.casefold() == name.casefold() and key != name for key in job["uploaded"]):
                raise ValueError("图库存在大小写冲突的文件名")
            base = self.path(ident) / "files"
            target = base / name
            if base.is_symlink() or base.resolve().parent != self.path(ident).resolve() or not target.resolve().is_relative_to(base.resolve()):
                raise ValueError("上传路径越界")
            for path in [target, *target.parents]:
                if path == self.path(ident):
                    break
                if is_link(path):
                    raise ValueError("上传路径不能使用链接")
            target.parent.mkdir(parents=True, exist_ok=True)
            # Per-file temporary names allow safe retries after a broken upload.
            temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".part")
            limit = MAX_PACK if job["kind"] == "zip" else MAX_FILE
            prior = job["uploaded"].get(name, 0)
            self.uploads.add(ident)
        size = 0
        try:
            with temporary.open("wb") as handle:
                async for chunk in content.iter_chunked(1024 * 1024):
                    size += len(chunk)
                    if size > limit or job["bytes"] - prior + size > MAX_PACK:
                        raise ValueError("上传超过图库容量限制")
                    handle.write(chunk)
            with self.lock:
                current = self.read(ident)
                if current["state"] != "uploading":
                    raise GalleryConflict("上传已取消")
                if current["bytes"] - current["uploaded"].get(name, 0) + size > MAX_PACK:
                    raise ValueError("上传超过图库容量限制")
                os.replace(temporary, target)
                current["bytes"] += size - current["uploaded"].get(name, 0)
                current["uploaded"][name] = size
                current["updated"] = time.time()
                self.store.write_json(self.path(ident) / "job.json", current)
            return self.public(current)
        finally:
            temporary.unlink(missing_ok=True)
            with self.lock:
                self.uploads.discard(ident)

    def start(self, ident):
        with self.lock:
            if ident in self.uploads:
                raise GalleryConflict("请等待文件上传完成")
            if any(worker.is_alive() for worker in self.workers.values()):
                raise GalleryConflict("另一个图库任务正在导入，请等待或取消后重试")
            job = self.read(ident)
            if job["state"] == "ready":
                return self.public(job)
            if not job["uploaded"]:
                raise ValueError("请先上传图库文件")
            if job["kind"] == "zip" and "archive.zip" not in job["uploaded"]:
                raise ValueError("ZIP上传尚未完成")
            cancel = threading.Event()
            self.cancels[ident] = cancel
            self.update(ident, state="running", error=None)
            def work():
                try:
                    source = self.path(ident) / "files"
                    if job["kind"] == "zip":
                        source /= "archive.zip"
                    def progress(done, total, view):
                        if done == 1 or done % 16 == 0 or done == total:
                            self.update(ident, completed=done, total=total, view=view)
                    result = self.store.import_files(source, progress, cancel.is_set)
                    self.update(ident, state="ready", result=result, error=None)
                except ImportCancelled:
                    self.update(ident, state="cancelled", error=None)
                except (ValueError, TypeError, KeyError, AttributeError, OSError, RuntimeError, zipfile.BadZipFile, Image.DecompressionBombError) as error:
                    self.update(ident, state="failed", error=str(error))
            worker = threading.Thread(target=work, name="AnyAngle-gallery-import", daemon=True)
            self.workers[ident] = worker
            worker.start()
            return self.public(self.read(ident))

    def cancel(self, ident):
        with self.lock:
            value = self.read(ident)
            if value["state"] == "ready":
                return self.public(value)
            if self.workers.get(ident) and self.workers[ident].is_alive():
                self.cancels[ident].set()
            else:
                value = self.update(ident, state="cancelled")
            return self.public(value)

    def resume(self, ident):
        with self.lock:
            if ident in self.uploads or self.workers.get(ident) and self.workers[ident].is_alive():
                raise GalleryConflict("任务仍在运行，请等待停止后再继续上传")
            value = self.read(ident)
            if value["state"] == "ready":
                raise GalleryConflict("此任务已完成，请创建新导入")
            return self.public(self.update(ident, state="uploading", error=None))

    def remove(self, ident):
        with self.lock:
            if ident in self.uploads or self.workers.get(ident) and self.workers[ident].is_alive():
                raise GalleryConflict("任务仍在运行，请先取消并等待停止")
            self.read(ident)
            target = self.path(ident).resolve()
            root = (self.store.root / "jobs").resolve()
            if target.parent != root or not JOB.fullmatch(target.name):
                raise ValueError("任务清理路径越界")
            # Only the bounded upload job is removed. Imported blobs and Studio assets remain.
            shutil.rmtree(target)
            self.workers.pop(ident, None); self.cancels.pop(ident, None)
            return {"removed": ident}


def register_gallery_routes(routes, store_factory):
    managers = {}
    def store():
        return GalleryStore(store_factory().root / "pose_gallery")

    def jobs():
        root = str(store_factory().root.resolve())
        if root not in managers:
            managers[root] = GalleryJobs(store())
        return managers[root]

    async def guarded(action):
        try:
            result = await action()
            return result if isinstance(result, web.StreamResponse) else web.json_response(result)
        except GalleryConflict as error:
            return web.json_response({"error": str(error)}, status=409)
        except (ValueError, TypeError, KeyError, AttributeError, OSError, RuntimeError, RecursionError, zipfile.BadZipFile, UnidentifiedImageError, Image.DecompressionBombError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/anyangle-studio/pose-gallery")
    async def catalog(request):
        return await guarded(lambda: asyncio.to_thread(store().list))

    @routes.patch("/anyangle-studio/pose-gallery/items/{id}")
    async def patch(request):
        async def action():
            data = await request.json()
            return await asyncio.to_thread(store().patch, request.match_info["id"], data.get("changes"), data.get("revision"))
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-gallery/preferences")
    async def preferences(request):
        async def action():
            data = await request.json()
            return await asyncio.to_thread(store().preferences, data.get("changes"), data.get("revision"))
        return await guarded(action)

    @routes.get("/anyangle-studio/pose-gallery/blobs/{name}")
    async def blob(request):
        async def action():
            path = store().blob_path(request.match_info["name"])
            if not path.is_file():
                raise ValueError("图片尚未导入，请继续图库导入")
            return web.FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-gallery/asset")
    async def asset(request):
        async def action():
            data = await request.json()
            gallery = store()
            item = next((row for row in gallery.list()["items"] if row["id"] == data.get("id") and not row.get("hidden")), None)
            view = next((view for view in item["views"] if view["id"] == data.get("view")), None) if item else None
            if not view:
                raise ValueError("所选动作或视角不存在")
            content = await asyncio.to_thread(gallery.blob_path(view["original"]["name"]).read_bytes)
            asset = await asyncio.to_thread(store_factory().asset, content, "png")
            asset["label"] = f"{item['name']} · {view['label']}"
            return {"asset": asset, "source": {"id": item["id"], "viewId": view["id"], "hash": view["original"]["name"], "assetHash": asset["name"], "source": item["source"]}}
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-gallery/export")
    async def export(request):
        async def action():
            data = await request.json()
            path = await asyncio.to_thread(store().export, data.get("ids"))
            return {"url": "/anyangle-studio/pose-gallery/exports/" + path.name, "size": path.stat().st_size}
        return await guarded(action)

    @routes.get("/anyangle-studio/pose-gallery/exports/{name}")
    async def download(request):
        async def action():
            path = store().export_path(request.match_info["name"])
            if not path.is_file():
                raise ValueError("下载缓存已清理，请重新导出")
            return web.FileResponse(path, headers={"Content-Disposition": 'attachment; filename="anyangle-image-poses.zip"'})
        return await guarded(action)

    @routes.post("/anyangle-studio/pose-gallery/cache/clear")
    async def clear_cache(request):
        return await guarded(lambda: asyncio.to_thread(store().clear_cache))

    @routes.get("/anyangle-studio/pose-gallery/jobs")
    async def list_jobs(request):
        return await guarded(lambda: asyncio.to_thread(jobs().list))

    @routes.post("/anyangle-studio/pose-gallery/jobs")
    async def create_job(request):
        async def action():
            data = await request.json()
            return jobs().create(data.get("kind"), data.get("name", "图片姿势库"))
        return await guarded(action)

    @routes.put("/anyangle-studio/pose-gallery/jobs/{id}/file")
    async def upload(request):
        return await guarded(lambda: jobs().upload(request.match_info["id"], request.query.get("path", ""), request.content))

    @routes.get("/anyangle-studio/pose-gallery/jobs/{id}")
    async def job(request):
        return await guarded(lambda: asyncio.to_thread(jobs().status, request.match_info["id"]))

    @routes.post("/anyangle-studio/pose-gallery/jobs/{id}/{action}")
    async def job_action(request):
        async def action():
            name = request.match_info["action"]
            methods = {"start": jobs().start, "cancel": jobs().cancel, "resume": jobs().resume, "remove": jobs().remove}
            if name not in methods:
                raise ValueError("未知图库任务操作")
            return await asyncio.to_thread(methods[name], request.match_info["id"])
        return await guarded(action)
