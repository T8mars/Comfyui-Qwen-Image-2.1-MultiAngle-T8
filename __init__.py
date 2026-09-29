import io
import json

import folder_paths
import numpy as np
from PIL import Image
import torch

from .storage import StudioStore
from .routes import register_routes
from .reconstruction import AnyAngleReconstructionOutput


def store():
    return StudioStore(folder_paths.get_input_directory() + "/anyangle_studio")


class AnyAngleStudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"snapshot": ("STRING", {"default": "", "multiline": True})},
                "optional": {"reference_image": ("IMAGE", {"tooltip": "Original image for the studio. Also connect this image to Qwen image_1."})}}

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("guide_image_2", "prompt", "scene_json")
    FUNCTION = "render"
    CATEGORY = "T8/AnyAngle"
    DESCRIPTION = "Edit a 3D camera and apply its clean guide. Connect the original separately to Qwen image_1."

    @classmethod
    def VALIDATE_INPUTS(cls, snapshot):
        try:
            store().load_scene(snapshot)
        except (ValueError, OSError) as error:
            return str(error)
        return True

    def render(self, snapshot, reference_image=None):
        document, png = store().load_scene(snapshot)
        ui = {}
        if reference_image is not None:
            pixels = np.clip(reference_image[0].cpu().float().numpy() * 255, 0, 255).astype(np.uint8)
            buffer = io.BytesIO()
            Image.fromarray(pixels).save(buffer, format="PNG")
            reference = store().asset(buffer.getvalue(), "png")
            source = document["scene"]["source"]
            if source["kind"] == "splat" and source["reference"]["name"] != reference["name"]:
                raise ValueError("参考图已改变，请打开 AnyAngle Studio 重新重建并应用机位")
            reference["label"] = "IMAGE input"
            document["scene"]["reference"] = reference
            ui["anyangle_reference"] = [reference]
        with Image.open(io.BytesIO(png)) as image:
            pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        result = torch.from_numpy(pixels)[None], document["prompt"], json.dumps(document["scene"], ensure_ascii=False)
        return {"ui": ui, "result": result}


NODE_CLASS_MAPPINGS = {"AnyAngleStudioT8": AnyAngleStudio, "AnyAngleReconstructionOutputT8": AnyAngleReconstructionOutput}
NODE_DISPLAY_NAME_MAPPINGS = {"AnyAngleStudioT8": "Comfyui-Qwen-Image-2.1-MultiAngle-T8"}
WEB_DIRECTORY = "./web"
register_routes(store)
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
