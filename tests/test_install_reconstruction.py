import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import install_reconstruction


class Response(io.BytesIO):
    def __init__(self, data, status, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}


class ReconstructionDownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.models = Path(self.directory.name)
        self.data = b"verified model bytes"
        self.item = ("vae/test.safetensors", (len(self.data), hashlib.sha256(self.data).hexdigest()))

    def test_corrupt_complete_partial_restarts_without_range(self):
        partial = self.models / "vae/test.safetensors.partial"
        partial.parent.mkdir(parents=True)
        partial.write_bytes(b"x" * len(self.data))
        requests = []

        def urlopen(request, timeout):
            requests.append(request.headers)
            return Response(self.data, 200)

        with patch.object(install_reconstruction, "MODELS", self.models), patch.object(install_reconstruction.urllib.request, "urlopen", urlopen):
            receipt = install_reconstruction.download(self.item)
        self.assertEqual(receipt["sha256"], self.item[1][1])
        self.assertEqual((self.models / self.item[0]).read_bytes(), self.data)
        self.assertEqual(requests, [{}])

    def test_incomplete_partial_resumes_at_exact_byte(self):
        partial = self.models / "vae/test.safetensors.partial"
        partial.parent.mkdir(parents=True)
        partial.write_bytes(self.data[:7])
        requests = []

        def urlopen(request, timeout):
            requests.append(request.headers)
            return Response(self.data[7:], 206, {"Content-Range": f"bytes 7-{len(self.data) - 1}/{len(self.data)}"})

        with patch.object(install_reconstruction, "MODELS", self.models), patch.object(install_reconstruction.urllib.request, "urlopen", urlopen):
            install_reconstruction.download(self.item)
        self.assertEqual((self.models / self.item[0]).read_bytes(), self.data)
        self.assertEqual(requests, [{"Range": "bytes=7-"}])

    def test_wrong_resume_range_restarts_from_zero(self):
        partial = self.models / "vae/test.safetensors.partial"
        partial.parent.mkdir(parents=True)
        partial.write_bytes(self.data[:7])
        requests = []

        def urlopen(request, timeout):
            requests.append(request.headers)
            if len(requests) == 1:
                return Response(self.data[7:], 206, {"Content-Range": f"bytes 8-{len(self.data) - 1}/{len(self.data)}"})
            return Response(self.data, 200)

        with patch.object(install_reconstruction, "MODELS", self.models), patch.object(install_reconstruction.urllib.request, "urlopen", urlopen), patch.object(install_reconstruction.time, "sleep"):
            install_reconstruction.download(self.item)
        self.assertEqual((self.models / self.item[0]).read_bytes(), self.data)
        self.assertEqual(requests, [{"Range": "bytes=7-"}, {}])


if __name__ == "__main__":
    unittest.main()
