"""Persist native TripoSplat results for the interactive workbench."""
import io
import json
import hashlib

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
import comfy.utils
from PIL import Image
from comfy_extras.nodes_gaussian_splat import _gaussian_ply_bytes

from .storage import StudioStore

MODELS = {
    "background_removal": "birefnet.safetensors",
    "clip_vision": "dino_v3_vit_h.safetensors",
    "diffusion_models": "triposplat_fp16.safetensors",
    "vae_encoder": "flux2-vae.safetensors",
    "vae_decoder": "triposplat_vae_decoder_fp16.safetensors",
}


def reconstruction_config():
    missing = [name for category, name in MODELS.items()
               if not folder_paths.get_full_path("vae" if category.startswith("vae_") else category, name)]
    return {"models": MODELS, "available": not missing, "missing": missing}


def image_asset(store, image):
    pixels = np.clip(image[0].cpu().float().numpy() * 255, 0, 255).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return store.asset(buffer.getvalue(), "png")


class AnyAngleReconstructionOutput:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"splat": ("SPLAT",), "samples": ("LATENT",),
                             "reference": ("IMAGE",), "prepared": ("IMAGE",), "mask": ("MASK",)}}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "T8/AnyAngle/internal"

    def save(self, splat, samples, reference, prepared, mask):
        store = StudioStore(folder_paths.get_input_directory() + "/anyangle_studio")
        end = int(splat.counts[0]) if splat.counts is not None else splat.positions.shape[1]
        ply = _gaussian_ply_bytes(splat.positions[0, :end], splat.scales[0, :end],
                                  splat.rotations[0, :end], splat.opacities[0, :end], splat.sh[0, :end])
        asset = store.asset(ply, "ply")
        points = splat.positions[0, :end].cpu().float().numpy()
        visible = splat.opacities[0, :end].cpu().float().numpy().reshape(-1) > 0.1
        points = points[visible] if visible.any() else points
        # Native SPLAT already contains the exporter axis transform; rotate X by pi for +Y up.
        points = points * np.array([1, -1, -1])
        bounds = [np.quantile(points, 0.005, axis=0).tolist(), np.quantile(points, 0.995, axis=0).tolist()]
        token = samples["samples"].unbind()[1][0, 0].cpu().float().tolist()
        ys, xs = np.nonzero(mask[0].cpu().float().numpy() > 0.5)
        height, width = reference.shape[1:3]
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else [0, 0, width, height]
        resize = 1024 / min(width, height)
        resized_w, resized_h = round(width * resize), round(height * resize)
        rgba = torch.cat([reference[:1, :, :, :3].movedim(-1, 1).cpu(), mask[:1, None].cpu()], dim=1)
        alpha = comfy.utils.common_upscale(rgba, resized_w, resized_h, "lanczos", "disabled").clamp(0, 1)[:, 3:4]
        alpha = -F.max_pool2d(-alpha, 3, stride=1, padding=1)
        ys, xs = np.nonzero(alpha[0, 0].numpy() > 0)
        cx, cy = (int(xs.min()) + int(xs.max())) / 2, (int(ys.min()) + int(ys.max())) / 2
        half = max(int(xs.max()) - int(xs.min()), int(ys.max()) - int(ys.min())) * 0.6
        crop = [int(cx - half) * width / resized_w, int(cy - half) * height / resized_h,
                int(cx + half) * width / resized_w, int(cy + half) * height / resized_h]
        source = {**asset, "kind": "splat", "label": "TripoSplat · 原图主体", "bounds": bounds,
                  "camera_token": token, "reference": image_asset(store, reference),
                  "prepared": image_asset(store, prepared), "foreground_bbox": bbox, "crop": crop,
                  "gaussians": end, "engine": "TripoSplat", "coordinates": "native-triposplat"}
        encoded = json.dumps(source, sort_keys=True, allow_nan=False).encode()
        digest = hashlib.sha256(encoded).hexdigest()
        store.write(digest + ".json", encoded)
        return {"ui": {"anyangle_reconstruction": [{"id": digest, "source": source}]}, "result": ()}
