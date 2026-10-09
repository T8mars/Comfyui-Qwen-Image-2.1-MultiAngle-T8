import io
import json
import hashlib

import folder_paths
import numpy as np
from PIL import Image
import torch
from comfy_api.latest import io as comfy_io

from .storage import StudioStore, conditioning_for, prompt_for
from .multiperson import canonical_scene, build_manifest
from .reference_library import encoder_prompt
from .dwpose import people_from_keypoints, keypoints_signature
from .routes import register_routes
from .reconstruction import AnyAngleReconstructionOutput
from .optional_lora import AnyAngleOptionalLoRA


def store():
    return StudioStore(folder_paths.get_input_directory() + "/anyangle_studio")


def image_asset(image, index=0, preserve_alpha=False):
    pixels = np.clip(image[index].cpu().float().numpy()[..., :4 if preserve_alpha else 3] * 255, 0, 255).astype(np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return store().asset(buffer.getvalue(), "png", preserve_alpha=preserve_alpha)


class AnyAngleStudio(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAngleStudioT8", display_name="Comfyui-Qwen-Image-2.1-MultiAngle-T8", category="T8/AnyAngle",
            inputs=[comfy_io.String.Input("snapshot", default="", multiline=True),
                    comfy_io.Image.Input("reference_image", optional=True, display_name="场景来源图（可选）"), comfy_io.Image.Input("structure_image", optional=True, display_name="外部引导图（可选）"),
                    comfy_io.Autogrow.Input("actor_references", template=comfy_io.Autogrow.TemplateNames(
                        comfy_io.Image.Input("actor_reference", tooltip="通用参考：身份、服装、配饰、场景、风格等；在 Studio 中指定用途。"), names=[f"actor_reference_{index}" for index in range(1, 101)], min=0), optional=True),
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
        no_guide = document["scene"].get("version") == 3 and document["scene"]["referenceLibrary"].get("mode", "guided") != "guided"
        if reference_image is not None:
            pixels = np.clip(reference_image[0].cpu().float().numpy() * 255, 0, 255).astype(np.uint8)
            buffer = io.BytesIO()
            Image.fromarray(pixels).save(buffer, format="PNG")
            reference = store().asset(buffer.getvalue(), "png")
            source = document["scene"]["source"]
            if not no_guide and source["kind"] == "splat" and source["reference"]["name"] != reference["name"]:
                raise ValueError("参考图已改变，请打开 AnyAngle Studio 重新重建并应用机位")
            reference["label"] = "IMAGE input"
            document["scene"]["reference"] = reference
            ui["anyangle_reference"] = [reference]
        pose_source = document["scene"].get("openpose") or {}
        local_guide = (guide_mode == "pose" and (pose_source.get("origin") in ("dwpose", "json", "keypoints") or pose_source.get("useRig") or conditioning.get("mapOrigin") == "rig")
                       or guide_mode == "depth" and conditioning.get("mapOrigin") in ("da3", "scene")
                       or guide_mode == "canny" and conditioning.get("mapOrigin") in ("auto", "reference"))
        if not no_guide and structure_image is not None and model == "base" and guide_mode in ("pose", "depth", "canny") and not local_guide:
            pixels = np.clip(structure_image[0].cpu().float().numpy() * 255, 0, 255).astype(np.uint8)
            buffer = io.BytesIO()
            Image.fromarray(pixels).save(buffer, format="PNG")
            connected = store().asset(buffer.getvalue(), "png")
            expected = (document["scene"].get("openpose") or {}).get("sourceName") if guide_mode == "pose" else (conditioning.get("map") or {}).get("name")
            if connected["name"] != expected:
                raise ValueError("结构图已改变，请打开工作台重新读取并应用")
        scene = document["scene"]
        if scene.get("version") in (2, 3):
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
            if scene.get("version") == 3:
                for item in scene["referenceLibrary"]["items"]:
                    key = item.get("inputKey")
                    if not key:
                        continue
                    image = (actor_references or {}).get(key)
                    if image is None or item.get("batchIndex", 0) >= image.shape[0]:
                        item["missing"] = True
                    else:
                        item["asset"] = image_asset(image, item.get("batchIndex", 0), preserve_alpha=True)
                        item["batchCount"] = int(image.shape[0])
                        item.pop("missing", None)
            scene["manifest"] = build_manifest(scene)
            if scene["manifest"].get("missing"):
                raise ValueError("缺少参考连线：" + ", ".join(scene["manifest"]["missing"]) + "；请重新连接或在 Studio 选择使用已保存版本")
            scene["resolvedPrompt"] = prompt_for(scene)
            document["scene"] = scene
            document["prompt"] = scene["resolvedPrompt"]
            ui["anyangle_actor_references"] = [{"inputKey": key, "asset": asset} for key, asset in connected_refs.items()]
            if reference_warnings:
                ui["anyangle_warnings"] = reference_warnings
        if pose_keypoints is not None:
            signature = keypoints_signature(pose_keypoints)
            if (not no_guide and model == "base" and guide_mode == "pose" and pose_source.get("origin") == "keypoints"
                    and not pose_source.get("useRig") and pose_source.get("inputSignature")
                    and pose_source["inputSignature"] != signature):
                raise ValueError("姿势关键点已变化，请打开工作台重新读取并应用")
            people, detected_png = people_from_keypoints(pose_keypoints)
            pose_asset = store().asset(detected_png, "png")
            ui["anyangle_pose_people"] = [{"people": people, "asset": pose_asset, "signature": signature}]
        guide_image = None
        if png is not None:
            with Image.open(io.BytesIO(png)) as image:
                pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
            guide_image = torch.from_numpy(pixels)[None]
        result = (guide_image, document["prompt"],
                  json.dumps(document["scene"], ensure_ascii=False), 1.0 if model == "anyangle" else 0.0)
        return {"ui": ui, "result": result}


class AnyAngleMultiPersonEncode(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAngleMultiPersonEncodeT8", display_name="AnyAngle 多图编码 · Qwen 2.1", category="T8/AnyAngle",
            inputs=[comfy_io.Clip.Input("clip"), comfy_io.Vae.Input("vae"), comfy_io.String.Input("scene_json", force_input=True),
                    comfy_io.Image.Input("guide_image", optional=True, display_name="当前构图引导（可选）"), comfy_io.Int.Input("reference_resolution", display_name="其他参考图预算", default=512, min=0, max=4096, step=32,
                        tooltip="一般参考图像素面积预算，0保留原尺寸。AnyAngle双图换机位推荐0保留清晰原图；引导图及仅参考模式的首图单独处理。"),
                    comfy_io.String.Input("prompt", display_name="正向提示词", default="", multiline=True, optional=True, tooltip="可手写或转为输入接线。全文模式原样使用，补充模式追加到 Studio 文本。"),
                    comfy_io.String.Input("negative_prompt", display_name="负向提示词", default="", multiline=True, optional=True),
                    comfy_io.Combo.Input("prompt_mode", display_name="提示词方式", options=["studio-plus-input", "input-full"], default="studio-plus-input", optional=True,
                        tooltip="studio-plus-input：Studio 提示词 + 输入补充；input-full：使用输入全文（包括空串）。")],
            outputs=[comfy_io.Conditioning.Output(display_name="positive"), comfy_io.Conditioning.Output(display_name="negative"),
                     comfy_io.Latent.Output(display_name="latent")])

    @classmethod
    def execute(cls, clip, vae, scene_json, guide_image=None, reference_resolution=512, prompt="", negative_prompt="", prompt_mode="studio-plus-input"):
        from comfy_extras.nodes_qwen import TextEncodeQwenImage21
        scene = canonical_scene(json.loads(scene_json))
        manifest = build_manifest(scene)
        studio_prompt = prompt_for(scene)
        if prompt_mode == "studio-plus-input" and scene.get("resolvedPrompt") is not None and scene["resolvedPrompt"] != studio_prompt:
            raise ValueError("人物参考清单与提示词不同步，请重新应用工作台")
        prompt = encoder_prompt(studio_prompt, prompt, prompt_mode)
        if manifest.get("missing"):
            raise ValueError("缺少参考素材：" + ", ".join(manifest["missing"]))
        images, receipt = {}, []
        if manifest["guide"]:
            if guide_image is None:
                raise ValueError("当前模式需要引导图，请连接 Studio 的当前构图引导输出")
            images[f"image_{manifest['guide']['index']}"] = guide_image[:1]
            receipt.append({"index": manifest["guide"]["index"], "kind": "guide", "source_sha256": hashlib.sha256(guide_image[:1].detach().cpu().numpy().tobytes()).hexdigest(), "source_hash_kind": "tensor-float32"})
        for reference in manifest["references"]:
            with Image.open(io.BytesIO(store().read_asset(reference["asset"]["name"]))) as source:
                image = source.convert("RGBA" if scene.get("version") == 3 and "A" in source.getbands() else "RGB")
                resolution = reference.get("resolution", "reference")
                resolution = reference_resolution if resolution == "reference" else resolution
                if resolution > 0:
                    scale = resolution / (image.width * image.height) ** .5
                    size = (max(32, round(image.width * scale / 32) * 32), max(32, round(image.height * scale / 32) * 32))
                    image = image.resize(size, Image.Resampling.LANCZOS)
                pixels = np.asarray(image, dtype=np.float32) / 255
            images[f"image_{reference['index']}"] = torch.from_numpy(pixels)[None]
            receipt.append({"index": reference["index"], "kind": "reference", "sha256": reference["asset"]["name"].split(".")[0],
                "source_sha256": reference["asset"]["name"].split(".")[0], "source_hash_kind": "png", "reference_ids": reference.get("referenceIds", []), "resolution": resolution})
        if manifest.get("mode") == "references-only" and not images:
            raise ValueError("仅参考模式至少需要一张启用的参考图")
        encoded = TextEncodeQwenImage21.execute(clip=clip, vae=vae, prompt=prompt, negative_prompt=negative_prompt, resolution=0, images=images)
        actual = encoded.result[2]["samples"].shape
        for entry in receipt:
            image = images[f"image_{entry['index']}"]
            entry.update(input_width=int(image.shape[2]), input_height=int(image.shape[1]), channels=int(image.shape[-1]),
                native_width=max(32, round(int(image.shape[2]) / 32) * 32), native_height=max(32, round(int(image.shape[1]) / 32) * 32))
        return comfy_io.NodeOutput(*encoded.result, ui={"anyangle_encoding": [{"manifest": manifest, "prompt": prompt, "negative_prompt": negative_prompt,
            "prompt_mode": prompt_mode, "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "negative_prompt_sha256": hashlib.sha256(negative_prompt.encode()).hexdigest(), "images": sorted(receipt, key=lambda entry: entry["index"]),
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


class AnyAngleReferenceRead(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAngleReferenceReadT8", category="T8/AnyAngle", is_output_node=True, is_dev_only=True,
            inputs=[comfy_io.Image.Input("images")], outputs=[])

    @classmethod
    def execute(cls, images):
        assets = [image_asset(images, index, preserve_alpha=True) for index in range(images.shape[0])]
        return comfy_io.NodeOutput(ui={"anyangle_reference_batch": [{"asset": assets[0] if assets else None, "assets": assets, "batchCount": len(assets)}]})


class AnyAngleTextRead(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAngleTextReadT8", category="T8/AnyAngle", is_output_node=True, is_dev_only=True,
            inputs=[comfy_io.String.Input("text", force_input=True)], outputs=[])

    @classmethod
    def execute(cls, text):
        return comfy_io.NodeOutput(ui={"anyangle_text": [text]})


class AnyAnglePromptModeRead(comfy_io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return comfy_io.Schema(node_id="AnyAnglePromptModeReadT8", category="T8/AnyAngle", is_output_node=True, is_dev_only=True,
            inputs=[comfy_io.Combo.Input("mode", options=["studio-plus-input", "input-full"])], outputs=[])

    @classmethod
    def execute(cls, mode):
        return comfy_io.NodeOutput(ui={"anyangle_text": [mode]})


NODE_CLASS_MAPPINGS = {"AnyAngleStudioT8": AnyAngleStudio, "AnyAngleOptionalLoRAT8": AnyAngleOptionalLoRA,
                       "AnyAngleReconstructionOutputT8": AnyAngleReconstructionOutput,
                       "AnyAngleMultiPersonEncodeT8": AnyAngleMultiPersonEncode, "AnyAnglePoseReadT8": AnyAnglePoseRead,
                       "AnyAngleReferenceReadT8": AnyAngleReferenceRead, "AnyAngleTextReadT8": AnyAngleTextRead,
                       "AnyAnglePromptModeReadT8": AnyAnglePromptModeRead}
NODE_DISPLAY_NAME_MAPPINGS = {"AnyAngleStudioT8": "Comfyui-Qwen-Image-2.1-MultiAngle-T8",
                              "AnyAngleOptionalLoRAT8": "AnyAngle 可选 LoRA · T8"}
WEB_DIRECTORY = "./web"
register_routes(store)
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
