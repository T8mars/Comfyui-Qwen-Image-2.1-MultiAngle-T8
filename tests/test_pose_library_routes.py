import asyncio
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer

from pose_library import builtin_entries


class PoseRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        package = types.ModuleType("pose_route_test"); package.__path__ = [str(Path(__file__).parents[1])]
        with patch.dict(sys.modules, {"pose_route_test": package}):
            spec = importlib.util.spec_from_file_location("pose_route_test.routes", Path(__file__).parents[1] / "pose_library_routes.py")
            self.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.module)
        routes = web.RouteTableDef()
        self.module.register_pose_routes(routes, lambda: types.SimpleNamespace(root=Path(self.directory.name)))
        app = web.Application(client_max_size=64*1024*1024); app.add_routes(routes)
        self.client = TestClient(TestServer(app)); await self.client.start_server(); self.addAsyncCleanup(self.client.close)
        self.base = "/anyangle-studio/pose-library"

    async def get(self):
        return await (await self.client.get(self.base)).json()

    async def inspect(self):
        form = FormData(); form.add_field("files", json.dumps({"schema_version": 3, "bones": {"head": [30, 0, 0]}}), filename="poses/Test.json", content_type="application/json")
        response = await self.client.post(self.base + "/inspect", data=form)
        self.assertEqual(response.status, 200)
        return await response.json()

    async def test_list_is_offline_and_includes_original_builtins(self):
        with patch.object(self.module, "fetch_source") as fetch:
            first = await self.get(); second = await self.get()
        fetch.assert_not_called(); self.assertEqual(first["revision"], second["revision"])
        self.assertEqual(len(first["items"]), len(builtin_entries()))

    async def test_inspect_is_nonmutating_then_import_visible_to_second_client(self):
        inspected = await self.inspect(); self.assertEqual((await self.get())["revision"], 0)
        response = await self.client.post(self.base + "/import", json={"revision": 0, "entries": inspected["entries"]})
        self.assertEqual(response.status, 200)
        imported = await response.json(); self.assertEqual(imported["revision"], 1)
        self.assertEqual(imported["items"][-1]["pose"]["bones"]["head"], [30, 0, 0])
        self.assertEqual((await self.get())["items"][-1], imported["items"][-1])

    async def test_concurrent_same_revision_only_one_writer_succeeds(self):
        entries = (await self.inspect())["entries"]
        responses = await asyncio.gather(*[self.client.post(self.base + "/import", json={"revision": 0, "entries": entries}) for _ in range(2)])
        self.assertEqual(sorted(response.status for response in responses), [200, 409])
        self.assertEqual((await self.get())["revision"], 1)

    async def test_patch_builtin_preferences_roundtrips_and_unknown_fields_do_not_commit(self):
        response = await self.client.patch(self.base + "/items/builtin-0", json={"revision": 0, "changes": {"favorite": True, "name": "常用"}})
        self.assertEqual(response.status, 200); self.assertEqual((await self.get())["items"][0]["name"], "常用")
        response = await self.client.patch(self.base + "/items/builtin-0", json={"revision": 1, "changes": {"arbitraryPath": "../file"}})
        self.assertEqual(response.status, 400); self.assertEqual((await self.get())["revision"], 1)

    async def test_export_reimport_and_delete_preserve_portable_pose(self):
        inspected = await self.inspect()
        saved = await (await self.client.post(self.base + "/import", json={"revision": 0, "entries": inspected["entries"]})).json()
        item = saved["items"][-1]
        response = await self.client.post(self.base + "/export", json={"ids": [item["id"]]})
        self.assertEqual(response.content_type, "application/zip"); packed = await response.read()
        response = await self.client.post(self.base + "/delete", json={"revision": 1, "ids": [item["id"]]}); self.assertEqual(response.status, 200)
        form = FormData(); form.add_field("files", packed, filename="poses.zip", content_type="application/zip")
        inspected = await (await self.client.post(self.base + "/inspect", data=form)).json()
        self.assertEqual(inspected["entries"][0]["pose"], item["pose"])

    async def test_nonmultipart_and_invalid_zip_have_actionable_errors(self):
        response = await self.client.post(self.base + "/inspect", json={"file": "invalid"}); self.assertEqual(response.status, 400)
        form = FormData(); form.add_field("files", b"not a zip", filename="bad.zip", content_type="application/zip")
        response = await self.client.post(self.base + "/inspect", data=form); self.assertEqual(response.status, 400)
        self.assertEqual((await self.get())["revision"], 0)

    async def test_excessively_nested_json_returns_controlled_error_without_catalog_change(self):
        data = '{"entries":' + '[' * 1500 + '0' + ']' * 1500 + '}'
        response = await self.client.post(self.base + '/import', data=data, headers={'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400)
        self.assertIn('error', await response.json())
        self.assertEqual((await self.get())['revision'], 0)

    async def test_source_fetch_only_runs_after_explicit_post_and_failure_preserves_library(self):
        with patch.object(self.module, "fetch_source", side_effect=OSError("offline")) as fetch:
            response = await self.client.get(self.base + "/sources/general/refresh"); self.assertEqual(response.status, 405); fetch.assert_not_called()
            started = await (await self.client.post(self.base + "/sources/general/refresh", json={})).json()
            for _ in range(100):
                job = await (await self.client.get(self.base + "/jobs/" + started["id"])).json()
                if job["state"] != "running":
                    break
                await asyncio.sleep(.01)
            self.assertEqual(job["state"], "failed"); self.assertEqual(job["error"], "offline"); fetch.assert_called_once()
        self.assertEqual((await self.get())["revision"], 0)


if __name__ == "__main__":
    unittest.main()
