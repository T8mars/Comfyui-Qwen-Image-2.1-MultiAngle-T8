import io
import json

import folder_paths
import numpy as np
from PIL import Image
import torch
from comfy_api.latest import io as comfy_io

from .storage import StudioStore, conditioning_for, prompt_for
from .multiperson import canonical_scene, build_manifest
from .dwpose import people_from_keypoints, keypoints_signature
from .routes import register_routes
from .reconstruction import AnyAngleReconstructionOutput
from .optional_lora import AnyAngleOptionalLoRA


def store():
    return StudioStore(folder_paths.get_input_directory() + "/anyangle_studio")


def image_asset(image):
    pixels = np.clip(image[0].cpu().float().numpy()[..., :3] * 255, 0, 255).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return store().asset(buffer.getvalue(), "png")


class AnyAngleStudio(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAngleStudioT8", display_name="Comfyui-Qwen-Image-2.1-MultiAngle-T8", category="T8/AnyAngle",
            inputs=[comfy_io.String.Input("snapshot", default="", multiline=True),
                    comfy_io.Image.Input("reference_image", optional=True), comfy_io.Image.Input("structure_image", optional=True),
                    comfy_io.Autogrow.Input("actor_references", template=comfy_io.Autogrow.TemplateNames(
                        comfy_io.Image.Input("actor_reference"), names=[f"actor_reference_{index}" for index in range(1, 101)], min=0), optional=True),
                    comfy_io.Custom("POSE_KEYPOINT").Input("pose_keypoints", optional=True)],
            outputs=[comfy_io.Image.Output(display_name="guide_image_2"), comfy_io.String.Output(display_name="prompt"),
                     comfy_io.String.Output(display_name="scene_json"), comfy_io.Float.Output(display_name="anyangle_lora_strength")])

    @classmethod
    def VALIDATE_INPUTS(cls, snapshot):
        try:
            store().load_scene(snapshot)
        except (ValueError, OSError) as error:
            return str(error)
        return True

    @classmethod
    def validate_inputs(cls, snapshot, actor_references=None):
        return cls.VALIDATE_INPUTS(snapshot)

    @classmethod
    def execute(cls, snapshot, reference_image=None, structure_image=None, actor_references=None, pose_keypoints=None):
        return cls().render(snapshot, reference_image, structure_image, actor_references, pose_keypoints)

    def render(self, snapshot, reference_image=None, structure_image=None, actor_references=None, pose_keypoints=None):
        document, png = store().load_scene(snapshot)
        ui = {}
        model, guide_mode, conditioning = conditioning_for(document["scene"])
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
        pose_source = document["scene"].get("openpose") or {}
        local_guide = (guide_mode == "pose" and (pose_source.get("origin") in ("dwpose", "json", "keypoints") or pose_source.get("useRig") or conditioning.get("mapOrigin") == "rig")
                       or guide_mode == "depth" and conditioning.get("mapOrigin") in ("da3", "scene")
                       or guide_mode == "canny" and conditioning.get("mapOrigin") in ("auto", "reference"))
        if structure_image is not None and model == "base" and guide_mode in ("pose", "depth", "canny") and not local_guide:
            pixels = np.clip(structure_image[0].cpu().float().numpy() * 255, 0, 255).astype(np.uint8)
            buffer = io.BytesIO()
            Image.fromarray(pixels).save(buffer, format="PNG")
            connected = store().asset(buffer.getvalue(), "png")
            expected = (document["scene"].get("openpose") or {}).get("sourceName") if guide_mode == "pose" else (conditioning.get("map") or {}).get("name")
            if connected["name"] != expected:
                raise ValueError("结构图已改变，请打开工作台重新读取并应用")
        scene = document["scene"]
        if scene.get("version") == 2:
            scene = canonical_scene(scene)
            connected_refs = {}
            reference_warnings = []
            for key, image in (actor_references or {}).items():
                if image is not None:
                    connected_refs[key] = image_asset(image)
                    if image.shape[0] > 1:
                        reference_warnings.append(f"{key} 图片批次使用第一张；请将人物照片拆分为独立输入。")
            for actor in scene["actors"]:
                identity = actor["identity"]
                if identity.get("inputKey") in connected_refs:
                    identity["asset"] = connected_refs[identity["inputKey"]]
            scene["manifest"] = build_manifest(scene)
            scene["resolvedPrompt"] = prompt_for(scene)
            document["scene"] = scene
            document["prompt"] = scene["resolvedPrompt"]
            ui["anyangle_actor_references"] = [{"inputKey": key, "asset": asset} for key, asset in connected_refs.items()]
            if reference_warnings:
                ui["anyangle_warnings"] = reference_warnings
        if pose_keypoints is not None:
            signature = keypoints_signature(pose_keypoints)
            if (model == "base" and guide_mode == "pose" and pose_source.get("origin") == "keypoints"
                    and not pose_source.get("useRig") and pose_source.get("inputSignature")
                    and pose_source["inputSignature"] != signature):
                raise ValueError("姿势关键点已变化，请打开工作台重新读取并应用")
            people, detected_png = people_from_keypoints(pose_keypoints)
            pose_asset = store().asset(detected_png, "png")
            ui["anyangle_pose_people"] = [{"people": people, "asset": pose_asset, "signature": signature}]
        with Image.open(io.BytesIO(png)) as image:
            pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        result = (torch.from_numpy(pixels)[None], document["prompt"],
                  json.dumps(document["scene"], ensure_ascii=False), 1.0 if model == "anyangle" else 0.0)
        return {"ui": ui, "result": result}


class AnyAngleMultiPersonEncode(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAngleMultiPersonEncodeT8", display_name="AnyAngle 多人编码 · T8", category="T8/AnyAngle",
            inputs=[comfy_io.Clip.Input("clip"), comfy_io.Vae.Input("vae"), comfy_io.String.Input("scene_json", force_input=True),
                    comfy_io.Image.Input("guide_image"), comfy_io.Int.Input("reference_resolution", default=512, min=0, max=4096, step=32,
                        tooltip="人物参考图像素预算，0保留原尺寸。引导图始终保留其画幅。")],
            outputs=[comfy_io.Conditioning.Output(display_name="positive"), comfy_io.Conditioning.Output(display_name="negative"),
                     comfy_io.Latent.Output(display_name="latent")])

    @classmethod
    def execute(cls, clip, vae, scene_json, guide_image, reference_resolution=512):
        from comfy_extras.nodes_qwen import TextEncodeQwenImage21
        scene = canonical_scene(json.loads(scene_json))
        manifest = build_manifest(scene)
        prompt = prompt_for(scene)
        if scene.get("resolvedPrompt") is not None and scene["resolvedPrompt"] != prompt:
            raise ValueError("人物参考清单与提示词不同步，请重新应用工作台")
        images = {f"image_{manifest['guide']['index']}": guide_image[:1]}
        for reference in manifest["references"]:
            with Image.open(io.BytesIO(store().read_asset(reference["asset"]["name"]))) as source:
                image = source.convert("RGB")
                if reference_resolution > 0:
                    scale = reference_resolution / (image.width * image.height) ** .5
                    size = (max(32, round(image.width * scale / 32) * 32), max(32, round(image.height * scale / 32) * 32))
                    image = image.resize(size, Image.Resampling.LANCZOS)
                pixels = np.asarray(image, dtype=np.float32) / 255
            images[f"image_{reference['index']}"] = torch.from_numpy(pixels)[None]
        encoded = TextEncodeQwenImage21.execute(clip=clip, vae=vae, prompt=prompt, negative_prompt="", resolution=0, images=images)
        actual = encoded.result[2]["samples"].shape
        return comfy_io.NodeOutput(*encoded.result, ui={"anyangle_encoding": [{"manifest": manifest, "prompt": prompt,
            "width": int(actual[-1]) * 16, "height": int(actual[-2]) * 16}]})


class AnyAnglePoseRead(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAnglePoseReadT8", category="T8/AnyAngle", is_output_node=True, is_dev_only=True,
            inputs=[comfy_io.Custom("POSE_KEYPOINT").Input("keypoints")], outputs=[])

    @classmethod
    def execute(cls, keypoints):
        people, png = people_from_keypoints(keypoints)
        asset = store().asset(png, "png")
        return comfy_io.NodeOutput(ui={"anyangle_pose_people": [{"people": people, "asset": asset,
            "signature": keypoints_signature(keypoints)}]})


NODE_CLASS_MAPPINGS = {"AnyAngleStudioT8": AnyAngleStudio, "AnyAngleOptionalLoRAT8": AnyAngleOptionalLoRA,
                       "AnyAngleReconstructionOutputT8": AnyAngleReconstructionOutput,
                       "AnyAngleMultiPersonEncodeT8": AnyAngleMultiPersonEncode, "AnyAnglePoseReadT8": AnyAnglePoseRead}
NODE_DISPLAY_NAME_MAPPINGS = {"AnyAngleStudioT8": "Comfyui-Qwen-Image-2.1-MultiAngle-T8",
                              "AnyAngleOptionalLoRAT8": "AnyAngle 可选 LoRA · T8"}
WEB_DIRECTORY = "./web"
register_routes(store)
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
