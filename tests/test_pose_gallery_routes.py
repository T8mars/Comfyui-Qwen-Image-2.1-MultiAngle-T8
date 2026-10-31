import asyncio
import errno
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from storage import StudioStore
from test_pose_gallery import fixture


class GalleryRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_disk_full_create_leaves_no_job_and_list_can_read_interrupted_jobs(self):
        manager = self.module.GalleryJobs(self.gallery)
        job = manager.create('zip', 'existing.zip')
        manager.update(job['id'], state='running')
        before = set((self.gallery.root / 'jobs').iterdir())
        with patch.object(self.gallery, 'write_json', side_effect=OSError(errno.ENOSPC, 'Disk full')):
            with self.assertRaises(OSError):
                manager.create('zip', 'new.zip')
            self.assertEqual(set((self.gallery.root / 'jobs').iterdir()), before)
            listed = manager.list()
            self.assertEqual(len(listed), 1)
            self.assertEqual(listed[0]['state'], 'paused')
            self.assertEqual(manager.read(job['id'])['state'], 'running')
            manager.remove(job['id'])
        self.assertEqual(manager.list(), [])
        self.assertEqual(manager.create('zip', 'retry.zip')['state'], 'uploading')

    async def test_incomplete_job_directory_does_not_hide_existing_jobs(self):
        manager = self.module.GalleryJobs(self.gallery)
        job = manager.create('zip', 'existing.zip')
        (self.gallery.root / 'jobs' / ('0' * 32)).mkdir()
        self.assertEqual([row['id'] for row in manager.list()], [job['id']])

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        package = types.ModuleType('gallery_route_test'); package.__path__ = [str(Path(__file__).parents[1])]
        with patch.dict(sys.modules, {'gallery_route_test': package}):
            spec = importlib.util.spec_from_file_location('gallery_route_test.routes', Path(__file__).parents[1] / 'pose_gallery_routes.py')
            self.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.module)
        self.store = StudioStore(self.root / 'studio')
        self.gallery = self.module.GalleryStore(self.store.root / 'pose_gallery')
        self.jobs = self.module.GalleryJobs(self.gallery)
        self.source = fixture(self.root / 'source')
        table = web.RouteTableDef(); self.module.register_gallery_routes(table, lambda: self.store)
        app = web.Application(); app.add_routes(table)
        self.client = TestClient(TestServer(app)); await self.client.start_server(); self.addAsyncCleanup(self.client.close)
        self.base = '/anyangle-studio/pose-gallery'

    async def request(self, method, path, **kwargs):
        response = await self.client.request(method, self.base + path, **kwargs)
        return response, await response.json()

    def zip_source(self):
        result = io.BytesIO()
        with zipfile.ZipFile(result, 'w') as archive:
            for path in self.source.rglob('*'):
                if path.is_file(): archive.write(path, path.relative_to(self.source).as_posix())
        return result.getvalue()

    async def test_complete_zip_upload_import_export_download_and_asset_survives_cache_cleanup(self):
        response, job = await self.request('POST', '/jobs', json={'kind': 'zip', 'name': 'sample.zip'})
        self.assertEqual(response.status, 200)
        response, uploaded = await self.request('PUT', f"/jobs/{job['id']}/file?path=sample.zip", data=self.zip_source())
        self.assertEqual(response.status, 200); self.assertEqual(uploaded['uploadedFiles'], 1)
        response, started = await self.request('POST', f"/jobs/{job['id']}/start", json={})
        self.assertEqual(response.status, 200)
        for _ in range(100):
            _, state = await self.request('GET', f"/jobs/{job['id']}")
            if state['state'] != 'running': break
            await asyncio.sleep(.02)
        self.assertEqual(state['state'], 'ready', state)
        _, catalog = await self.request('GET', '')
        item = catalog['items'][0]
        response, result = await self.request('POST', '/asset', json={'id': item['id'], 'view': item['views'][0]['id']})
        self.assertEqual(response.status, 200)
        managed = self.store.read_asset(result['asset']['name'])
        self.assertEqual(result['source']['assetHash'], result['asset']['name'])
        self.assertEqual(result['source']['hash'], item['views'][0]['original']['name'])
        response, download = await self.request('POST', '/export', json={})
        self.assertEqual(response.status, 200)
        response = await self.client.get(download['url'])
        self.assertEqual(response.status, 200)
        with zipfile.ZipFile(io.BytesIO(await response.read())) as archive:
            self.assertIn('anyangle-gallery.json', archive.namelist())
        response, removed = await self.request('POST', f"/jobs/{job['id']}/remove", json={})
        self.assertEqual(response.status, 200)
        response, cleared = await self.request('POST', '/cache/clear', json={})
        self.assertEqual(response.status, 200); self.assertGreater(cleared['removedBytes'], 0)
        self.assertEqual(self.store.read_asset(result['asset']['name']), managed)
        self.assertEqual(len(self.gallery.list()['items']), 1)

    async def test_cancel_resume_upload_and_path_validation(self):
        _, job = await self.request('POST', '/jobs', json={'kind':'directory','name':'folder'})
        ident = job['id']
        response, _ = await self.request('PUT', f'/jobs/{ident}/file?path=../outside', data=b'not written')
        self.assertEqual(response.status, 400); self.assertFalse((self.root / 'outside').exists())
        response, cancelled = await self.request('POST', f'/jobs/{ident}/cancel', json={})
        self.assertEqual(cancelled['state'], 'cancelled')
        response, _ = await self.request('PUT', f'/jobs/{ident}/file?path=source.json', data=b'{}')
        self.assertEqual(response.status, 409)
        _, resumed = await self.request('POST', f'/jobs/{ident}/resume', json={})
        self.assertEqual(resumed['state'], 'uploading')
        response, _ = await self.request('PUT', f'/jobs/{ident}/file?path=source.json', data=b'{}')
        self.assertEqual(response.status, 200)

    async def test_inflight_upload_cannot_be_started_deleted_or_overwritten(self):
        job = self.jobs.create('directory', 'slow')
        arrived, release = asyncio.Event(), asyncio.Event()
        class Content:
            async def iter_chunked(self, size):
                arrived.set(); await release.wait(); yield b'complete'
        work = asyncio.create_task(self.jobs.upload(job['id'], 'image.png', Content()))
        await arrived.wait()
        try:
            for operation in (self.jobs.start, self.jobs.remove, self.jobs.resume):
                with self.assertRaises(self.module.GalleryConflict): operation(job['id'])
            with self.assertRaises(self.module.GalleryConflict): await self.jobs.upload(job['id'], 'image.png', Content())
            self.jobs.cancel(job['id']); release.set()
            with self.assertRaises(self.module.GalleryConflict): await work
        finally:
            release.set()
        self.assertEqual(self.jobs.read(job['id'])['uploaded'], {})
        self.assertEqual(list((self.jobs.path(job['id']) / 'files').iterdir()), [])

    async def test_outdated_patch_and_hidden_asset_return_explicit_errors(self):
        self.gallery.import_files(self.source)
        item = self.gallery.list()['items'][0]
        response, _ = await self.request('PATCH', '/items/' + item['id'], json={'revision':0,'changes':{'hidden':True}})
        self.assertEqual(response.status, 409)
        response, _ = await self.request('PATCH', '/items/' + item['id'], json={'revision':1,'changes':{'hidden':True}})
        self.assertEqual(response.status, 200)
        response, _ = await self.request('POST', '/asset', json={'id':item['id'],'view':item['views'][0]['id']})
        self.assertEqual(response.status, 400)

if __name__ == '__main__': unittest.main()
