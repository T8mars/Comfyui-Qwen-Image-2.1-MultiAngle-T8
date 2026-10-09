"""Image uses, targets and the exact image list passed to native Qwen 2.1."""
import re

KINDS = ("free", "identity", "clothing", "accessory", "scene", "style", "layout")
IMAGE = re.compile(r"[a-f0-9]{64}\.png\Z")
INPUT = re.compile(r"actor_reference_[1-9][0-9]*\Z")


def validate_library(scene):
    library = scene.get("referenceLibrary")
    if not isinstance(library, dict) or library.get("version") != 1:
        raise ValueError("Unsupported reference library; use AnyAngle Studio 1.6.0 or later")
    if library.get("mode", "guided") not in ("guided", "references-only", "text"):
        raise ValueError("Unknown reference workflow mode")
    if library.get("mode", "guided") != "guided" and scene.get("conditioning", {}).get("model", "anyangle") != "base":
        raise ValueError("仅参考 / 纯文本创作使用 Qwen 底模，请关闭 AnyAngle LoRA")
    resolution = library.get("firstResolution", 0)
    if type(resolution) is not int or not 0 <= resolution <= 4096:
        raise ValueError("Invalid first-reference resolution")
    items = library.get("items")
    if not isinstance(items, list):
        raise ValueError("Reference library items must be a list")
    ids, usage_ids = set(), set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or item["id"] in ids:
            raise ValueError("Reference IDs must be unique nonempty strings")
        ids.add(item["id"])
        if not isinstance(item.get("label", ""), str) or type(item.get("enabled", True)) is not bool:
            raise ValueError("Invalid reference label or enabled state")
        asset = item.get("asset")
        if asset is not None and (not isinstance(asset, dict) or not isinstance(asset.get("name"), str) or not IMAGE.fullmatch(asset["name"])):
            raise ValueError("Reference library requires PNG assets")
        key = item.get("inputKey")
        if key is not None and (not isinstance(key, str) or not INPUT.fullmatch(key)):
            raise ValueError("Invalid connected reference input")
        if type(item.get("batchIndex", 0)) is not int or item.get("batchIndex", 0) < 0:
            raise ValueError("Invalid reference batch index")
        if type(item.get("batchCount", 1)) is not int or item.get("batchCount", 1) < 1:
            raise ValueError("Invalid reference batch count")
        for flag in ("missing", "reviewSource"):
            if type(item.get(flag, False)) is not bool:
                raise ValueError("Invalid reference source state")
        parent = item.get("parent")
        if parent is not None:
            if (not isinstance(parent, dict) or not isinstance(parent.get("name"), str) or not IMAGE.fullmatch(parent["name"])
                    or not isinstance(parent.get("box"), list) or len(parent["box"]) != 4
                    or any(type(value) is not int or value < 0 for value in parent["box"]) or min(parent["box"][2:]) < 1):
                raise ValueError("Invalid cropped reference provenance")
        uses = item.get("usages")
        if not isinstance(uses, list):
            raise ValueError("Reference uses must be a list")
        for use in uses:
            if not isinstance(use, dict) or not isinstance(use.get("id"), str) or not use["id"] or use["id"] in usage_ids:
                raise ValueError("Reference use IDs must be unique nonempty strings")
            usage_ids.add(use["id"])
            if use.get("kind") not in KINDS or type(use.get("enabled", True)) is not bool:
                raise ValueError("Unknown reference use")
            target = use.get("target")
            if not isinstance(target, dict) or target.get("kind") not in ("scene", "actors", "props", "text"):
                raise ValueError("Invalid reference target")
            if not isinstance(target.get("ids", []), list) or any(not isinstance(value, str) for value in target.get("ids", [])):
                raise ValueError("Invalid reference target IDs")
            for value in (target.get("text", ""), use.get("sourceText", ""), use.get("instruction", "")):
                if not isinstance(value, str) or len(value) > 16000:
                    raise ValueError("Reference descriptions must be text up to 16000 characters")
    first = library.get("firstReferenceId")
    if first is not None and first not in ids:
        raise ValueError("First-reference ID is missing from the library")
    templates = library.get("templates", [])
    if not isinstance(templates, list):
        raise ValueError("Reference templates must be a list")
    template_ids = set()
    for template in templates:
        if (not isinstance(template, dict) or not isinstance(template.get("id"), str) or not template["id"] or template["id"] in template_ids
                or not isinstance(template.get("name"), str) or not template["name"].strip()):
            raise ValueError("Invalid reference template")
        template_ids.add(template["id"])
        validate_library({**scene, "referenceLibrary": {"version": 1, "items": template.get("items"), "mode": "guided"}})


def target_text(scene, target):
    kind = target["kind"]
    if kind == "scene":
        return "the whole generated scene"
    if kind == "text":
        return target.get("text", "").strip() or None
    objects = scene.get("actors" if kind == "actors" else "props", [])
    if kind == "actors" and scene.get("source", {}).get("kind") != "human":
        return None
    labels = [obj.get("label", obj["id"]) for obj in objects if obj["id"] in target.get("ids", []) and obj.get("visible", True)]
    return ", ".join(labels) or None


def library_manifest(scene):
    library = scene["referenceLibrary"]
    mode, settings = library.get("mode", "guided"), scene.get("conditioning", {})
    references, excluded, by_name = [], [], {}
    for item in library["items"]:
        reason = None
        uses = [{**use, "targetText": target_text(scene, use["target"])} for use in item["usages"] if use.get("enabled", True)]
        uses = [use for use in uses if use["targetText"]]
        if not item.get("enabled", True):
            reason = "素材已停用"
        elif mode == "text":
            reason = "纯文本模式不发送图片"
        elif settings.get("model", "anyangle") == "anyangle":
            reason = "当前 AnyAngle 双图模式未发送；切换 Qwen 多图创作可使用"
        elif not uses:
            reason = "用途已停用或目标待重新分配"
        elif not item.get("asset") or item.get("missing"):
            reason = "连线或素材缺失，请重新读取或明确使用保存版本"
        if reason:
            excluded.append({"id": item["id"], "label": item.get("label", item["id"]), "reason": reason})
            continue
        name = item["asset"]["name"]
        if name not in by_name:
            by_name[name] = len(references)
            references.append({"asset": item["asset"], "referenceIds": [], "labels": [], "usages": [], "actorIds": []})
        entry = references[by_name[name]]
        entry["referenceIds"].append(item["id"])
        entry["labels"].append(item.get("label", item["id"]))
        entry["usages"].extend(uses)
        entry["actorIds"] = list(dict.fromkeys(entry["actorIds"] + [value for use in uses if use["target"]["kind"] == "actors" for value in use["target"].get("ids", [])]))
    if settings.get("model", "anyangle") == "anyangle" and scene.get("reference"):
        references = [{"asset": scene["reference"], "referenceIds": ["scene-source"], "labels": ["场景来源图"], "usages": [], "actorIds": []}]
    first = library.get("firstReferenceId")
    if mode == "references-only" and first:
        selected = next((entry for entry in references if first in entry["referenceIds"]), None)
        if selected:
            references.remove(selected)
            references.insert(0, selected)
    order = settings.get("imageOrder", "guide-first")
    guide = None if mode != "guided" else {"index": 1 if order == "guide-first" or not references else len(references) + 1, "width": scene["width"], "height": scene["height"]}
    for index, reference in enumerate(references):
        reference["index"] = index + (2 if guide and guide["index"] == 1 else 1)
        reference["resolution"] = library.get("firstResolution", 0) if mode == "references-only" and index == 0 else "reference"
    count = len(references) + (1 if guide else 0)
    warnings = ["超过 Qwen Image 2.1 官方建议的 10 图范围，图片仍完整发送；请留意效果和显存。"] if count > 10 else []
    missing = [entry["label"] for entry in excluded if entry["reason"].startswith("连线")]
    kind = settings.get("guide", "coarse")
    static = kind != "coarse" and (settings.get("map") and settings.get("mapKind", kind) == kind
              or kind == "canny" and scene.get("reference") and settings.get("mapOrigin") != "auto")
    return {"version": 2, "mode": mode, "imageOrder": order, "guide": guide, "references": references,
            "actors": [{"id": actor["id"], "label": actor.get("label", actor["id"]), "transform": actor.get("transform", {}), "editorColor": actor.get("editorColor"),
                        "description": actor.get("identity", {}).get("description", "")}
                       for actor in scene.get("actors", []) if not static and scene.get("source", {}).get("kind") == "human" and actor.get("visible", True)],
            "imageCount": count, "excluded": excluded, "missing": missing, "warnings": warnings}


def library_prompt(scene, manifest):
    settings = scene.get("conditioning", {})
    if settings.get("promptMode") == "custom":
        return settings.get("customPrompt", "")
    guide = manifest["guide"]
    lines = []
    if guide:
        instructions = {"coarse": "camera angle, composition, poses and placement", "pose": "body poses, limb directions, position and framing",
                        "depth": "spatial depth, layout and occlusion", "canny": "silhouettes, contours and major edges"}
        kind = settings.get("guide", "coarse")
        lines.append(f"Create a finished image following the {instructions[kind]} in <image{guide['index']}>. Do not render guide marks, mannequin colors or skeleton lines.")
        actors = manifest["actors"]
        if actors:
            lines.append(f"The guide contains {len(actors)} people. Keep their identities and placements separate.")
            for index, actor in enumerate(actors):
                color = f" ({actor['editorColor']} mannequin)" if kind == "coarse" and settings.get("colorActors") and actor.get("editorColor") else ""
                description = f" {actor['description'].strip()}" if actor.get("description", "").strip() else ""
                lines.append(f"Person {index + 1}{color} in the guide is {actor['label']}.{description}")
    elif manifest["mode"] == "references-only":
        lines.append("Create one coherent finished image using the references only for their specified purposes.")
    rules = {
        "free": "Use the relevant content as a general reference",
        "identity": "Use only the face identity and hairstyle; do not copy the clothing, pose or background",
        "clothing": "Use only the clothing design; do not copy the model's identity, pose or background",
        "accessory": "Use only the accessory or product design; do not add people from this reference",
        "scene": "Use the environment and background; do not add people from this reference",
        "style": "Use the visual style, lighting and color palette; do not copy the subject or pose",
        "layout": "Use the arrangement and composition; do not copy subject identities",
    }
    for reference in manifest["references"]:
        for use in reference.get("usages", []):
            source = f" Source content: {use['sourceText'].strip()}." if use.get("sourceText", "").strip() else ""
            extra = f" {use['instruction'].strip()}" if use.get("instruction", "").strip() else ""
            lines.append(f"<image{reference['index']}>: {rules[use['kind']]} for {use['targetText']}.{source}{extra}")
    if settings.get("promptExtra", "").strip():
        lines.append(settings["promptExtra"].strip())
    return "\n".join(lines)


def encoder_prompt(studio_prompt, prompt="", prompt_mode="studio-plus-input"):
    if prompt_mode == "input-full":
        return prompt
    if prompt_mode != "studio-plus-input":
        raise ValueError("Unknown encoder prompt mode")
    if prompt == studio_prompt:
        return studio_prompt
    return f"{studio_prompt}\n{prompt}" if studio_prompt and prompt else studio_prompt or prompt


def guide_is_stale(scene):
    settings, pose = scene.get("conditioning", {}), scene.get("openpose") or {}
    guide = "coarse" if settings.get("model") == "anyangle" else settings.get("guide", "coarse")
    if guide == "depth" and settings.get("mapOrigin") == "da3":
        name, accepted = settings.get("mapReference"), settings.get("acceptStoredSource")
    elif guide == "pose" and pose.get("origin") == "dwpose" and not pose.get("useRig"):
        name, accepted = pose.get("referenceName"), pose.get("acceptStoredSource")
    else:
        return False
    return not accepted and (name != (scene.get("reference") or {}).get("name") if name else bool(scene.get("derivedGuideStale")))
