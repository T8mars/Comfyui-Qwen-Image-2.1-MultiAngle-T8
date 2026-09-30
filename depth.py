"""Explicit photo-to-depth action using ComfyUI's native Depth Anything 3 runtime."""

from functools import lru_cache
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps


MODEL_REPO = "Comfy-Org/Depth-Anything-3"
MODEL_REVISION = "afd32929c589f43c2a6fda5246e7df2c01cce529"
MODEL_NAME = "depth_anything_3_small.safetensors"


def _model_path():
    import folder_paths

    if MODEL_NAME in folder_paths.get_filename_list("geometry_estimation"):
        return Path(folder_paths.get_full_path_or_raise("geometry_estimation", MODEL_NAME))
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise RuntimeError("Depth Anything 3 首次下载需要 huggingface_hub") from error
    local = Path(__file__).resolve().parent / ".local" / "da3"
    return Path(hf_hub_download(repo_id=MODEL_REPO, revision=MODEL_REVISION,
                                filename=f"geometry_estimation/{MODEL_NAME}", local_dir=local))


@lru_cache(maxsize=1)
def _model():
    import comfy.sd

    return comfy.sd.load_diffusion_model(str(_model_path()))


def extract_depth(photo):
    """Return a normalized grayscale PNG at the original photo's aspect ratio."""
    import numpy as np
    import torch
    try:
        from comfy_extras.nodes_depth_anything_3 import _run_da3, DA3Render
    except ImportError as error:
        raise RuntimeError("当前 ComfyUI 缺少内置 Depth Anything 3 节点；请更新 ComfyUI") from error

    with Image.open(BytesIO(photo)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    if image.width * image.height > 32_000_000:
        raise ValueError("照片超过 3200 万像素")
    image.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
    tensor = torch.from_numpy(np.array(image, copy=True)).float().div_(255).unsqueeze(0)
    depth, _, sky = _run_da3(_model(), tensor, process_res=504)
    gray = DA3Render._depth_to_image(depth, sky, "v2_style")[0]
    pixels = gray.clamp(0, 1).mul(255).byte().numpy()
    buffer = BytesIO()
    Image.fromarray(pixels, "RGB").save(buffer, format="PNG")
    return buffer.getvalue()
