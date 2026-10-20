import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from pose_library import PoseLibraryStore, builtin_entries, inspect_files, inspect_zip, normalized_entry


class PoseStabilityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = PoseLibraryStore(self.directory.name)

    def entry(self, name):
        return normalized_entry({'version': 1, 'kind': 'anyangle-pose', 'pose': {'bones': {'head': [20, 0, 0]}}}, name)

    def test_full_builtin_pack_reimport_keeps_all_ids_and_no_duplicates(self):
        original = self.store.list()['items']
        result = self.store.import_entries(inspect_zip(self.store.export())['entries'], 0)
        self.assertEqual({row['id'] for row in result['items']}, {row['id'] for row in original})
        self.assertEqual(len(result['items']), 15)

    def test_catalog_without_source_paths_keeps_distinct_named_entries(self):
        a, b = self.entry('A'), self.entry('B')
        a['source'] = b['source'] = {'id': 'custom-source', 'name': 'Custom'}
        result = self.store.import_entries([a, b], 0)
        self.assertEqual([row['originalName'] for row in result['items'] if not row.get('builtin')], ['A', 'B'])

    def test_normalization_warnings_survive_direct_import(self):
        row = self.entry('A'); row['pose']['bones']['unknown_rig_bone'] = [0, 0, 0]
        result = self.store.import_entries([row], 0)
        self.assertTrue(any('unknown_rig_bone' in value for value in result['items'][-1]['warnings']))

    def test_bad_preview_does_not_discard_valid_pose_or_other_files(self):
        document = json.dumps({'bones': {'head': [0, 0, 0]}}).encode()
        with patch('pose_library.preview_png', side_effect=Image.DecompressionBombError('too many pixels')):
            result = inspect_files({'A.json': document, 'A.png': b'image', 'B.json': document})
        self.assertEqual(len(result['entries']), 2)
        self.assertTrue(result['entries'][0]['warnings'])

    def test_failed_atomic_replace_retains_previous_index_and_removes_temporary_file(self):
        self.store.import_entries([self.entry('A')], 0)
        original = (Path(self.directory.name) / 'index.json').read_bytes()
        with patch('pose_library.os.replace', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.store.patch(self.store.list()['items'][-1]['id'], {'name': 'B'}, 1)
        self.assertEqual((Path(self.directory.name) / 'index.json').read_bytes(), original)
        self.assertEqual([path.name for path in Path(self.directory.name).iterdir()], ['index.json'])

    def test_builtin_metadata_roundtrips_to_a_fresh_install(self):
        self.store.patch('builtin-0', {'name': '我的站姿', 'favorite': True}, 0)
        data = inspect_zip(self.store.export())
        with tempfile.TemporaryDirectory() as destination:
            restored = PoseLibraryStore(destination).import_entries(data['entries'], 0)
        first = next(row for row in restored['items'] if row['id'] == 'builtin-0')
        self.assertEqual(first['name'], '我的站姿')
        self.assertTrue(first['favorite'])
