"""Photo-to-body-pose inference for the Studio's explicit DWPose action.

Uses the upstream ONNX weights, without depending on another ComfyUI node.
Models are downloaded only when the user requests pose extraction.
"""

from functools import lru_cache
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


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


def _detect_person(image, session):
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
    # The workbench edits one mannequin. Choose the most prominent person.
    index = max(candidates, key=lambda i: float(scores[i] * sizes[i, 0] * sizes[i, 1]))
    x0, y0 = (centers[index] - sizes[index] / 2) / ratio
    x1, y1 = (centers[index] + sizes[index] / 2) / ratio
    return np.array([max(0, x0), max(0, y0), min(width, x1), min(height, y1)], np.float32)


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


def _render(points, width, height):
    image = Image.new("RGB", (width, height), "black")
    draw = ImageDraw.Draw(image)
    radius = max(3, round(min(width, height) / 120))
    for index, (a, b) in enumerate(LIMBS):
        draw.line((tuple(points[ORDER[a]]), tuple(points[ORDER[b]])), fill=COLORS[index], width=radius * 2, joint="curve")
    for index, name in enumerate(ORDER):
        x, y = points[name]
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill="#ffffff")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def extract_pose(photo):
    """Return Studio keypoints and a preview PNG for a stored photo asset."""
    import numpy as np

    with Image.open(BytesIO(photo)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    if image.width * image.height > 32_000_000:
        raise ValueError("照片超过 3200 万像素")
    pixels = np.asarray(image)
    detector, estimator = _sessions()
    box = _detect_person(pixels, detector)
    keypoints, scores = _estimate_body(pixels, box, estimator)
    required = list(COCO_INDEX.values())
    if sum(scores[i] >= .25 for i in required) < 9:
        raise ValueError("检测到人物，但可见身体关节不足；请使用身体更完整的照片")
    points = {name: [float(v) for v in keypoints[index]] for name, index in COCO_INDEX.items()}
    points["neck"] = [(points["rs"][axis] + points["ls"][axis]) / 2 for axis in (0, 1)]
    low_confidence = sum(scores[i] < .25 for i in required)
    return points, _render(points, image.width, image.height), int(low_confidence)
