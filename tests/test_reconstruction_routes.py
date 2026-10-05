import importlib.util
import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
import zipfile
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image
from test_reconstruction import load_reconstruction
from test_multiperson import scene_for
from dwpose import people_from_keypoints, keypoints_signature


class ReconstructionRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        backend = load_reconstruction(self.directory.name)
        catalog = {}
        for role, name in backend.MODELS.items():
            category = "vae" if role.startswith("vae_") else role
            catalog.setdefault(category, []).append(name)
        catalog["diffusion_models"].append("三维/custom-triposplat.safetensors")
        self.catalog = catalog
        backend.folder_paths.folder_names_and_paths = {category: ([], set()) for category in catalog}
        backend.folder_paths.get_filename_list = lambda category: catalog[category]
        backend.folder_paths.get_full_path = lambda category, name: name if name in catalog[category] else None
        table = web.RouteTableDef()
        package = types.ModuleType("anyangle_reconstruction_test")
        package.__path__ = [str(Path(__file__).parents[1])]
        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=table))
        dwpose = types.ModuleType("anyangle_reconstruction_test.dwpose")
        dwpose.extract_pose = None; dwpose.extract_people = None; dwpose.people_from_keypoints = None
        dwpose.keypoints_signature = keypoints_signature
        depth = types.ModuleType("anyangle_reconstruction_test.depth"); depth.extract_depth = None
        modules = {"anyangle_reconstruction_test": package, "anyangle_reconstruction_test.reconstruction": backend,
                   "anyangle_reconstruction_test.dwpose": dwpose, "anyangle_reconstruction_test.depth": depth, "server": server}
        spec = importlib.util.spec_from_file_location("anyangle_reconstruction_test.routes", Path(__file__).parents[1] / "routes.py")
        routes = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(routes)
        self.store = backend.StudioStore(self.directory.name)
        self.routes_module = routes
        routes.register_routes(lambda: self.store)
        app = web.Application(); app.add_routes(table)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_human_repair_only_runs_on_explicit_post_and_reports_download_errors(self):
        with patch.object(self.routes_module, "repair_editor_assets") as repair:
            response = await self.client.get("/anyangle-studio/repair-human")
            self.assertEqual(response.status, 405)
            repair.assert_not_called()
            response = await self.client.post("/anyangle-studio/repair-human")
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())["repaired"])
            repair.assert_called_once_with()
        with patch.object(self.routes_module, "repair_editor_assets", side_effect=OSError("network unavailable")):
            response = await self.client.post("/anyangle-studio/repair-human")
            self.assertEqual(response.status, 400)
            self.assertIn("install_assets.py", (await response.json())["error"])

    async def test_default_and_manual_models_are_resolved_through_http(self):
        response = await self.client.get("/anyangle-studio/reconstruction-config")
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())["available"])
        response = await self.client.get("/anyangle-studio/reconstruction-config", params={
            "diffusion_models": "三维/custom-triposplat.safetensors"})
        self.assertEqual(response.status, 200)
        config = await response.json()
        self.assertTrue(config["available"])
        self.assertEqual(config["models"]["diffusion_models"], "三维/custom-triposplat.safetensors")
        self.assertIn("三维/custom-triposplat.safetensors", config["choices"]["diffusion_models"])

    async def test_unknown_roles_and_model_path_escape_return_400(self):
        for params in [{"other": "model.safetensors"}, {"vae_encoder": "../private.safetensors"},
                       {"vae_encoder": "C:/private.safetensors"}, {"keep_background": "false"}]:
            response = await self.client.get("/anyangle-studio/reconstruction-config", params=params)
            self.assertEqual(response.status, 400)
            self.assertIn("error", await response.json())

    async def test_background_option_drops_the_birefnet_requirement(self):
        self.catalog["background_removal"] = []
        response = await self.client.get("/anyangle-studio/reconstruction-config")
        self.assertFalse((await response.json())["available"])
        response = await self.client.get("/anyangle-studio/reconstruction-config", params={"keep_background": "1"})
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())["available"])

    async def test_saved_batch_download_streams_real_pngs_and_task_metadata(self):
        buffer = io.BytesIO(); Image.new("RGB", (96, 64), (42, 68, 91)).save(buffer, format="PNG")
        scene = {"version": 1, "width": 96, "height": 64, "source": {"kind": "human"},
                 "camera": {"azimuth": 0, "elevation": 0, "zoom": 1, "offsetX": 0, "offsetY": 0}}
        views = []
        for angle in [0, 90]:
            scene["camera"]["azimuth"] = angle
            response = await self.client.post("/anyangle-studio/snapshots", json={
                "scene": scene, "png": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()})
            self.assertEqual(response.status, 200)
            views.append({"snapshot": await response.json(), "prompt_id": f"job-{angle}"})
        response = await self.client.post("/anyangle-studio/batches", json={"views": views})
        self.assertEqual(response.status, 200)
        saved = await response.json()
        response = await self.client.get(f"/anyangle-studio/batch-guides/{saved['id']}")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "application/zip")
        with zipfile.ZipFile(io.BytesIO(await response.read())) as archive:
            self.assertIsNone(archive.testzip())
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual([view["camera"]["azimuth"] for view in manifest["views"]], [0, 90])
            self.assertEqual(Image.open(io.BytesIO(archive.read("view-0001.png"))).size, (96, 64))
        response = await self.client.post("/anyangle-studio/batches", json={"views": [{"snapshot": {"version": 1, "id": "../private"}}]})
        self.assertEqual(response.status, 400)
        response = await self.client.get("/anyangle-studio/batch-guides/invalid")
        self.assertEqual(response.status, 404)

    async def test_null_guide_settings_apply_and_read_back_through_http(self):
        buffer = io.BytesIO(); Image.new("RGB", (96, 64), "black").save(buffer, "PNG")
        scene = {"version": 1, "width": 96, "height": 64, "source": {"kind": "human"},
                 "camera": {"azimuth": 0, "elevation": 0, "zoom": 1, "offsetX": 0, "offsetY": 0},
                 "conditioning": None}
        response = await self.client.post("/anyangle-studio/snapshots", json={"scene": scene,
            "png": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()})
        self.assertEqual(response.status, 200)
        snapshot = await response.json()
        response = await self.client.get("/anyangle-studio/snapshots/" + snapshot["id"])
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["prompt"], "Change the camera angle from <image2> to <image1>.")

    async def test_portable_scene_routes_restore_references_and_report_invalid_zips(self):
        buffer = io.BytesIO(); Image.new("RGB", (96, 64), "gray").save(buffer, "PNG")
        scene = scene_for()
        for actor in scene["actors"]:
            actor["identity"]["asset"] = self.store.asset(buffer.getvalue(), "png")
        response = await self.client.post("/anyangle-studio/portable-scenes", json={"scene": scene,
            "png": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()})
        self.assertEqual(response.status, 200)
        portable = await response.json()
        response = await self.client.get(portable["url"])
        self.assertEqual(response.status, 200)
        zipped = await response.read()
        from aiohttp import FormData
        form = FormData(); form.add_field("file", zipped, filename="scene.zip", content_type="application/zip")
        response = await self.client.post("/anyangle-studio/import-scene", data=form)
        self.assertEqual(response.status, 200)
        restored = await response.json()
        self.assertEqual(len(restored["scene"]["actors"]), 3)
        self.assertEqual(restored["manifest"]["imageCount"], 2)
        form = FormData(); form.add_field("file", b"bad zip", filename="scene.zip", content_type="application/zip")
        response = await self.client.post("/anyangle-studio/import-scene", data=form)
        self.assertEqual(response.status, 400)

    async def test_pose_people_route_preserves_every_json_person(self):
        values = [value for index in range(18) for value in (20 + index, 20 + index, .9)]
        frames = [{"canvas_width": 96, "canvas_height": 64, "people": [{"pose_keypoints_2d": values}] * 2}]
        with patch.object(self.routes_module, "people_from_keypoints", side_effect=people_from_keypoints):
            response = await self.client.post("/anyangle-studio/pose-people", json={"keypoints": frames})
        self.assertEqual(response.status, 200)
        result = await response.json()
        self.assertEqual(len(result["people"]), 2)
        self.assertEqual((result["width"], result["height"]), (96, 64))
        self.assertEqual(result["people"][0]["canvasWidth"], 96)
        response = await self.client.post("/anyangle-studio/pose-people", json={"reference": "../image.png"})
        self.assertEqual(response.status, 400)

    async def test_standard_openpose_json_reads_explicit_fallback_canvas_through_http(self):
        values = [value for index in range(18) for value in (20 + index, 20 + index, .9)]
        frame = {"version": 1.3, "people": [{"pose_keypoints_2d": values}] * 2}
        with patch.object(self.routes_module, "people_from_keypoints", side_effect=people_from_keypoints):
            response = await self.client.post("/anyangle-studio/pose-people", json={
                "keypoints": frame, "canvas_width": 96, "canvas_height": 64})
            self.assertEqual(response.status, 200)
            result = await response.json()
            self.assertEqual(len(result["people"]), 2)
            self.assertEqual((result["width"], result["height"]), (96, 64))
            self.assertEqual(result["people"][0]["points"]["head"], [20, 20])
            self.assertEqual(result["signature"], keypoints_signature(frame))
            response = await self.client.post("/anyangle-studio/pose-people", json={
                "keypoints": frame, "canvas_width": -1, "canvas_height": 64})
            self.assertEqual(response.status, 400)
            response = await self.client.post("/anyangle-studio/pose-people", json={"keypoints": frame})
            self.assertEqual(response.status, 400)

    async def test_portable_scene_over_budget_fails_before_returning_a_download_url(self):
        buffer = io.BytesIO(); Image.new("RGB", (96, 64), "gray").save(buffer, "PNG")
        with patch.dict(self.store.scene_archive_manifest.__globals__, {"PORTABLE_MAX_TOTAL": 1}):
            response = await self.client.post("/anyangle-studio/portable-scenes", json={"scene": scene_for(),
                "png": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()})
        self.assertEqual(response.status, 400)
        result = await response.json()
        self.assertNotIn("url", result)
        self.assertIn("error", result)
