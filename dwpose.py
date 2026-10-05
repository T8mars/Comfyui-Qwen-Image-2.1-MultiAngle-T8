"""Photo-to-body-pose inference for the Studio's explicit DWPose action.

Uses the upstream ONNX weights, without depending on another ComfyUI node.
Models are downloaded only when the user requests pose extraction.
"""

from functools import lru_cache
import colorsys
import hashlib
import json
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageOps


MODEL_REPO = "yzd-v/DWPose"
MODEL_REVISION = "1a7144101628d69ee7a3768d1ee3a094070dc388"
MODEL_FILES = ("yolox_l.onnx", "dw-ll_ucoco_384.onnx")
ORDER = ("head", "neck", "rs", "re", "rw", "ls", "le", "lw", "rh", "rk", "ra", "lh", "lk", "la")
COCO_INDEX = {"head": 0, "rs": 6, "re": 8, "rw": 10, "ls": 5, "le": 7, "lw": 9,
              "rh": 12, "rk": 14, "ra": 16, "lh": 11, "lk": 13, "la": 15}
LIMBS = ((1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8),
         (8, 9), (9, 10), (1, 11), (11, 12), (12, 13), (1, 0))
COLORS = ("#ff0000", "#ff5500", "#ffaa00", "#ffff00", "#aaff00", "#55ff00",
          "#00ff00", "#00ff55", "#00ffaa", "#00ffff", "#00aaff", "#0055ff", "#0000ff")


def _model_paths():
    sibling = Path(__file__).resolve().parent.parent / "comfyui_controlnet_aux" / "ckpts" / "yzd-v" / "DWPose"
    local = Path(__file__).resolve().parent / ".local" / "dwpose"
    if all((sibling / name).is_file() for name in MODEL_FILES):
        return tuple(sibling / name for name in MODEL_FILES)
    if not all((local / name).is_file() for name in MODEL_FILES):
        try:
            from huggingface_hub import hf_hub_download
        except ImportError as error:
            raise RuntimeError("DWPose 首次下载需要 huggingface_hub；请在 ComfyUI Python 环境安装此依赖") from error
        local.mkdir(parents=True, exist_ok=True)
        for name in MODEL_FILES:
            if not (local / name).is_file():
                hf_hub_download(repo_id=MODEL_REPO, revision=MODEL_REVISION, filename=name, local_dir=local)
    return tuple(local / name for name in MODEL_FILES)


@lru_cache(maxsize=1)
def _sessions():
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError("DWPose 需要 onnxruntime；请在 ComfyUI Python 环境安装此依赖") from error
    paths = _model_paths()
    return tuple(ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]) for path in paths)


def _detect_people(image, session):
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    ratio = min(640 / height, 640 / width)
    work = np.full((640, 640, 3), 114, np.uint8)
    resized = cv2.resize(image, (max(1, round(width * ratio)), max(1, round(height * ratio))))
    work[:resized.shape[0], :resized.shape[1]] = resized
    tensor = np.ascontiguousarray(work.transpose(2, 0, 1)[None], np.float32)
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
    grids = []
    strides = []
    for stride in (8, 16, 32):
        x, y = np.meshgrid(np.arange(640 // stride), np.arange(640 // stride))
        grids.append(np.stack((x, y), -1).reshape(-1, 2))
        strides.append(np.full((x.size, 1), stride))
    stride = np.concatenate(strides)
    centers = (output[:, :2] + np.concatenate(grids)) * stride
    sizes = np.exp(output[:, 2:4]) * stride
    scores = output[:, 4] * output[:, 5]  # YOLOX class 0 is person.
    candidates = np.flatnonzero(scores > .3)
    if not len(candidates):
        raise ValueError("DWPose 没有识别到人物；请换一张身体更清晰的照片")
    boxes = np.concatenate((centers - sizes / 2, centers + sizes / 2), axis=1) / ratio
    selected = []
    for index in candidates[np.argsort(scores[candidates])[::-1]]:
        box = boxes[index].copy()
        box[0::2] = np.clip(box[0::2], 0, width)
        box[1::2] = np.clip(box[1::2], 0, height)
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        area = (box[2] - box[0]) * (box[3] - box[1])
        duplicate = False
        for previous, _ in selected:
            intersection = np.maximum(0, np.minimum(box[2:], previous[2:]) - np.maximum(box[:2], previous[:2])).prod()
            union = area + (previous[2] - previous[0]) * (previous[3] - previous[1]) - intersection
            if intersection / max(union, 1) > .45:
                duplicate = True
                break
        if not duplicate:
            selected.append((box, float(scores[index])))
    if not selected:
        raise ValueError("DWPose 没有识别到人物；请换一张身体更清晰的照片")
    return sorted(selected, key=lambda item: float(item[0][0]))


def _detect_person(image, session):
    people = _detect_people(image, session)
    return max(people, key=lambda item: float(item[1] * (item[0][2] - item[0][0]) * (item[0][3] - item[0][1])))[0]


def _estimate_body(image, box, session):
    import cv2
    import numpy as np

    width, height = 288, 384
    center = np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], np.float32)
    scale = np.array([box[2] - box[0], box[3] - box[1]], np.float32) * 1.25
    scale[0] = max(scale[0], scale[1] * width / height)
    scale[1] = max(scale[1], scale[0] * height / width)
    source = np.float32([center, center + [0, -scale[0] / 2], center + [scale[0] / 2, 0]])
    target = np.float32([[width / 2, height / 2], [width / 2, height / 2 - width / 2], [width, height / 2]])
    warp = cv2.getAffineTransform(source, target)
    crop = cv2.warpAffine(image, warp, (width, height))
    crop = (crop.astype(np.float32) - [123.675, 116.28, 103.53]) / [58.395, 57.12, 57.375]
    tensor = np.ascontiguousarray(crop.transpose(2, 0, 1)[None], np.float32)
    x, y = session.run(None, {session.get_inputs()[0].name: tensor})[:2]
    x, y = x[0], y[0]
    score = np.minimum(x.max(axis=-1), y.max(axis=-1))
    coords = np.stack((x.argmax(axis=-1), y.argmax(axis=-1)), -1).astype(np.float32) / 2
    coords = coords / [width, height] * scale + center - scale / 2
    return coords, score


def _render(points, confidence, keypoints, scores, width, height):
    image = Image.new("RGB", (width, height), "black")
    draw = ImageDraw.Draw(image)
    radius = max(3, round(min(width, height) / 120))
    for index, (a, b) in enumerate(LIMBS):
        if min(confidence[ORDER[a]], confidence[ORDER[b]]) < .3:
            continue
        draw.line((tuple(points[ORDER[a]]), tuple(points[ORDER[b]])), fill=COLORS[index], width=radius * 2, joint="curve")
    for index, name in enumerate(ORDER):
        if confidence[name] < .3:
            continue
        x, y = points[name]
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=COLORS[index % len(COLORS)])
    fine = max(1, round(min(width, height) / 400))
    for offset in (91, 112):
        for finger in range(5):
            chain = [offset] + list(range(offset + 1 + finger * 4, offset + 5 + finger * 4))
            for index, (a, b) in enumerate(zip(chain, chain[1:])):
                if min(scores[a], scores[b]) >= .3:
                    color = tuple(round(v * 255) for v in colorsys.hsv_to_rgb((finger * 4 + index) / 20, 1, 1))
                    draw.line((tuple(keypoints[a]), tuple(keypoints[b])), fill=color, width=fine * 2)
    for index in range(23, 91):
        if scores[index] >= .3:
            x, y = keypoints[index]
            draw.ellipse((x - fine, y - fine, x + fine, y + fine), fill="white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _photo(photo):
    with Image.open(BytesIO(photo)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    if image.width * image.height > 32_000_000:
        raise ValueError("照片超过 3200 万像素")
    return image


def _pose_result(keypoints, scores, width, height):
    required = list(COCO_INDEX.values())
    if sum(scores[i] >= .3 for i in required) < 3:
        raise ValueError("未提取到清晰的身体骨架；请换一张人物更清晰的照片")
    points = {name: [float(v) for v in keypoints[index]] for name, index in COCO_INDEX.items()}
    points["neck"] = [(points["rs"][axis] + points["ls"][axis]) / 2 for axis in (0, 1)]
    confidence = {name: float(scores[index]) for name, index in COCO_INDEX.items()}
    confidence["neck"] = min(confidence["rs"], confidence["ls"])
    low_confidence = sum(scores[i] < .3 for i in required)
    full_body = all(scores[i] >= .3 and 0 <= keypoints[i, 0] < width
                    and 0 <= keypoints[i, 1] < height for name, i in COCO_INDEX.items() if name != "head")
    preview = _render(points, confidence, keypoints, scores, width, height)
    visible = {name: point for name, point in points.items()
               if confidence[name] >= .3 and 0 <= point[0] < width and 0 <= point[1] < height}
    return {"points": visible, "confidence": confidence, "lowConfidence": int(low_confidence),
            "fullBody": bool(full_body), "canEstimate3D": len(visible) == len(ORDER),
            "visibleOnly": True, "canvasWidth": width, "canvasHeight": height,
            "normalizedPoints": {name: [point[0] / width, point[1] / height] for name, point in visible.items()}}, preview


def extract_pose(photo):
    """The original single-person four-tuple remains supported."""
    import numpy as np
    image = _photo(photo)
    pixels = np.asarray(image)
    detector, estimator = _sessions()
    box = _detect_person(pixels, detector)
    keys, scores = _estimate_body(pixels, box, estimator)
    person, preview = _pose_result(keys, scores, image.width, image.height)
    return person["points"], preview, person["lowConfidence"], person["fullBody"]


def extract_people(photo):
    import numpy as np
    image = _photo(photo)
    pixels = np.asarray(image)
    detector, estimator = _sessions()
    people = []
    merged = Image.new("RGB", image.size, "black")
    for index, (box, score) in enumerate(_detect_people(pixels, detector), 1):
        try:
            keys, scores = _estimate_body(pixels, box, estimator)
            person, preview = _pose_result(keys, scores, image.width, image.height)
            merged = ImageChops.lighter(merged, Image.open(BytesIO(preview)).convert("RGB"))
        except ValueError as error:
            person = {"points": {}, "confidence": {}, "lowConfidence": len(COCO_INDEX), "fullBody": False, "canEstimate3D": False,
                      "visibleOnly": True, "canvasWidth": image.width, "canvasHeight": image.height,
                      "normalizedPoints": {}, "warning": str(error)}
        people.append({"id": f"det-{index}", "bbox": [float(value) for value in box], "score": score, **person})
    buffer = BytesIO()
    merged.save(buffer, "PNG")
    return people, buffer.getvalue()


def keypoints_signature(frames):
    frame = frames[0] if isinstance(frames, list) and frames else frames
    encoded = json.dumps(frame, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def people_from_keypoints(frames, canvas_size=None):
    """Read the first OpenPose frame while preserving every person in that frame."""
    import numpy as np
    frame = frames[0] if isinstance(frames, list) and frames else frames
    if not isinstance(frame, dict) or not isinstance(frame.get("people"), list):
        raise ValueError("Choose OpenPose JSON or POSE_KEYPOINT frames")
    width, height = frame.get("canvas_width"), frame.get("canvas_height")
    if width is None and height is None and canvas_size is not None:
        width, height = canvas_size
    if any(type(value) is not int or value <= 0 for value in (width, height)) or width * height > 32_000_000:
        raise ValueError("Invalid OpenPose canvas dimensions")
    people = []
    merged = Image.new("RGB", (width, height), "black")
    indices = {"head": 0, "neck": 1, "rs": 2, "re": 3, "rw": 4, "ls": 5, "le": 6, "lw": 7,
               "rh": 8, "rk": 9, "ra": 10, "lh": 11, "lk": 12, "la": 13}
    for index, raw in enumerate(frame["people"], 1):
        if not isinstance(raw, dict):
            raise ValueError("Invalid OpenPose person")
        values = np.asarray(raw.get("pose_keypoints_2d", []), dtype=np.float32)
        if values.size not in (54, 75) or not np.isfinite(values).all():
            raise ValueError("OpenPose body must contain 18 or 25 finite keypoints")
        values = values.reshape(-1, 3)
        mapping = {**indices, "rh": 9, "rk": 10, "ra": 11, "lh": 12, "lk": 13, "la": 14} if len(values) == 25 else indices
        points = {name: [float(value) for value in values[k, :2]] for name, k in mapping.items()}
        confidence = {name: float(values[k, 2]) for name, k in mapping.items()}
        visible = {name: point for name, point in points.items() if confidence[name] >= .3 and 0 <= point[0] < width and 0 <= point[1] < height}
        whole_points, whole_scores = np.zeros((133, 2)), np.zeros(133)
        arrays = {"pose_keypoints_2d": values.flatten().tolist()}
        extra_face = []
        for field, offset, counts in (("face_keypoints_2d", 23, (68, 70)), ("hand_left_keypoints_2d", 91, (21,)), ("hand_right_keypoints_2d", 112, (21,))):
            source = raw.get(field)
            extra = np.asarray([] if source is None else source, dtype=np.float32)
            if extra.size and (extra.size not in [count * 3 for count in counts] or not np.isfinite(extra).all()):
                raise ValueError(f"Invalid OpenPose {field}")
            extra = extra.reshape(-1, 3)
            arrays[field] = extra.flatten().tolist()
            count = min(len(extra), counts[0])
            whole_points[offset:offset + count] = extra[:count, :2]
            whole_scores[offset:offset + count] = extra[:count, 2]
            if field == "face_keypoints_2d":
                extra_face = extra[count:]
        preview = _render(points, confidence, whole_points, whole_scores, width, height)
        if len(extra_face):
            face_image = Image.open(BytesIO(preview)).convert("RGB")
            draw = ImageDraw.Draw(face_image)
            radius = max(1, round(min(width, height) / 400))
            for x, y, score in extra_face:
                if score >= .3:
                    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill="white")
            buffer = BytesIO(); face_image.save(buffer, "PNG"); preview = buffer.getvalue()
        merged = ImageChops.lighter(merged, Image.open(BytesIO(preview)).convert("RGB"))
        positions = list(visible.values())
        bbox = [min(point[0] for point in positions), min(point[1] for point in positions), max(point[0] for point in positions), max(point[1] for point in positions)] if positions else [0, 0, 0, 0]
        people.append({"id": f"det-{index}", "bbox": bbox, "score": min(confidence.values()), "points": visible,
                       "confidence": confidence, "visibleOnly": True, "lowConfidence": len(ORDER) - len(visible),
                       "fullBody": all(name in visible for name in ORDER if name not in ("head", "neck")),
                       "canEstimate3D": len(visible) == len(ORDER), "canvasWidth": width, "canvasHeight": height,
                       "normalizedPoints": {name: [point[0] / width, point[1] / height] for name, point in visible.items()}, **arrays})
    buffer = BytesIO(); merged.save(buffer, "PNG")
    return people, buffer.getvalue()
