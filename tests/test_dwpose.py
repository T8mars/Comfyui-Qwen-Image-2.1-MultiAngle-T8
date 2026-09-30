import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1]))
import dwpose


class PhotoPoseTests(unittest.TestCase):
    def test_half_body_photo_outputs_visible_skeleton_without_inventing_legs(self):
        image = io.BytesIO()
        Image.new("RGB", (160, 240), "gray").save(image, "PNG")
        keys = np.full((133, 2), [80, 100], dtype=np.float32)
        scores = np.zeros(133, dtype=np.float32)
        for index, position in {0: [80, 30], 5: [110, 70], 6: [50, 70],
                                7: [125, 95], 8: [35, 95], 9: [110, 120], 10: [50, 120]}.items():
            keys[index] = position
            scores[index] = .8
        for index in (11, 12, 13, 14, 15, 16):
            keys[index] = [80, 230]
            scores[index] = .05
        with patch.object(dwpose, "_sessions", return_value=(None, None)), \
             patch.object(dwpose, "_detect_person", return_value=[0, 0, 160, 240]), \
             patch.object(dwpose, "_estimate_body", return_value=(keys, scores)):
            _, png, missing, full_body = dwpose.extract_pose(image.getvalue())
        result = np.asarray(Image.open(io.BytesIO(png)))
        self.assertFalse(full_body)
        self.assertGreater(missing, 0)
        self.assertGreater(result[:130].sum(), 0)
        self.assertEqual(result[160:].sum(), 0)


if __name__ == "__main__":
    unittest.main()
