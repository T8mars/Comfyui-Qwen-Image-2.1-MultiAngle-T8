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
    def test_normalized_openpose_body_is_scaled_to_canvas_pixels(self):
        values = [[.2 + index * .025, .15 + index * .03, .9] for index in range(18)]
        values[10] = [0, 0, 0]
        frame = {"canvas_width": 640, "canvas_height": 480,
                 "people": [{"pose_keypoints_2d": np.array(values).reshape(-1).tolist()}]}
        people, png = dwpose.people_from_keypoints(frame)
        person = people[0]
        self.assertAlmostEqual(person["points"]["head"][0], 128, places=4)
        self.assertAlmostEqual(person["points"]["head"][1], 72, places=4)
        self.assertAlmostEqual(person["normalizedPoints"]["rw"][0], .3, places=5)
        self.assertNotIn("ra", person["points"])
        self.assertGreater(person["bbox"][2], 300)
        pixels = np.asarray(Image.open(io.BytesIO(png)))
        self.assertGreater(pixels[65:80, 120:140].sum(), 0)
        self.assertEqual(pixels[:10, :10].sum(), 0)
        self.assertEqual(frame["people"][0]["pose_keypoints_2d"], np.array(values).reshape(-1).tolist())

    def test_normalized_and_pixel_parts_are_scaled_independently(self):
        body = [coordinate for index in range(18) for coordinate in (100 + index * 5, 150 + index * 5, .9)]
        hand = [coordinate for index in range(21) for coordinate in (.7 + index * .003, .5 + index * .002, .9)]
        face = [coordinate for index in range(70) for coordinate in (.5, .25, .9)]
        frame = {"canvas_width": 640, "canvas_height": 480,
                 "people": [{"pose_keypoints_2d": body, "hand_left_keypoints_2d": hand,
                             "face_keypoints_2d": face}]}
        people, png = dwpose.people_from_keypoints(frame)
        self.assertEqual(people[0]["points"]["head"], [100, 150])
        pixels = np.asarray(Image.open(io.BytesIO(png)))
        self.assertGreater(pixels[235:270, 445:490].sum(), 0)
        self.assertGreater(pixels[118:123, 318:323].sum(), 0)
        self.assertEqual(pixels[:10, :10].sum(), 0)

    def test_normalized_body25_people_keep_missing_joints_and_input_arrays(self):
        bodies = []
        for person in range(2):
            values = np.zeros((25, 3), np.float32)
            values[:, :2] = [.25 + person * .4, .4]
            values[:, 2] = .8
            values[11] = [50, 60, 0]
            values[14] = [0, 0, 0]
            bodies.append({"pose_keypoints_2d": values.reshape(-1).tolist()})
        frame = {"canvas_width": 800, "canvas_height": 600, "people": bodies}
        signature = dwpose.keypoints_signature(frame)
        people, png = dwpose.people_from_keypoints(frame)
        self.assertEqual(len(people), 2)
        for person, raw in zip(people, bodies):
            self.assertNotIn("ra", person["points"])
            self.assertNotIn("la", person["points"])
            self.assertFalse(person["fullBody"])
            self.assertEqual(person["pose_keypoints_2d"], raw["pose_keypoints_2d"])
        self.assertAlmostEqual(people[0]["points"]["rh"][0], 200, places=4)
        self.assertAlmostEqual(people[1]["points"]["rh"][0], 520, places=3)
        self.assertEqual(dwpose.keypoints_signature(frame), signature)
        pixels = np.asarray(Image.open(io.BytesIO(png)))
        self.assertGreater(pixels[237:244, 197:204].sum(), 0)
        self.assertGreater(pixels[237:244, 517:524].sum(), 0)

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
            points, png, missing, full_body = dwpose.extract_pose(image.getvalue())
        result = np.asarray(Image.open(io.BytesIO(png)))
        self.assertFalse(full_body)
        self.assertGreater(missing, 0)
        self.assertNotIn('la', points)
        self.assertNotIn('lh', points)
        self.assertIn('lw', points)
        self.assertGreater(result[:130].sum(), 0)
        self.assertEqual(result[160:].sum(), 0)


if __name__ == "__main__":
    unittest.main()
