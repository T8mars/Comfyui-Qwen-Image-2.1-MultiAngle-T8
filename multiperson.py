"""Actor documents and the image order shared by the Studio and Qwen encoder."""
import copy
from decimal import Decimal
import math
import re


ACTOR_KEY = re.compile(r"actor_reference_[1-9][0-9]*\Z")
COLORS = ("#ef6262", "#599cff", "#55c989", "#f4cf60", "#bb82f3", "#f3a05c", "#50d1d5", "#ed8dc5", "#b99476")


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def number_text(value):
    number = float(value or 0)
    if not number:
        return "0"
    text = repr(number)
    if "e" not in text:
        return text.removesuffix(".0")
    mantissa, exponent = text.split("e")
    exponent = int(exponent)
    if -6 <= exponent < 21:
        return format(Decimal(text), "f")
    return f"{mantissa.removesuffix('.0')}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"


def normalize_transform(owner):
    transform = owner.setdefault("transform", {})
    if not isinstance(transform, dict):
        raise ValueError("Scene transform must be an object")
    for key, default in (("x", 0), ("y", 0), ("z", 0), ("scale", 1), ("yaw", 0)):
        transform.setdefault(key, default)
        if not finite(transform[key]) or key == "scale" and transform[key] <= 0:
            raise ValueError(f"Invalid scene transform {key}")


def canonical_scene(raw):
    if not isinstance(raw, dict) or raw.get("version") not in (1, 2):
        raise ValueError("Unsupported AnyAngle scene version")
    scene = copy.deepcopy(raw)
    if scene["version"] == 1:
        return scene
    actors = scene.setdefault("actors", [])
    if not isinstance(actors, list):
        raise ValueError("Scene actors must be a list")
    ids = set()
    for index, actor in enumerate(actors):
        if not isinstance(actor, dict):
            raise ValueError("Invalid scene actor")
        actor_id = actor.get("id")
        if not isinstance(actor_id, str) or not actor_id or len(actor_id) > 128 or actor_id in ids:
            raise ValueError("Actor IDs must be unique nonempty strings")
        ids.add(actor_id)
        actor.setdefault("label", f"角色 {index + 1:02d}")
        actor.setdefault("editorColor", COLORS[index % len(COLORS)])
        if not isinstance(actor["label"], str) or not isinstance(actor["editorColor"], str):
            raise ValueError(f"Invalid label or color for actor {actor_id}")
        for key in ("visible", "locked"):
            actor.setdefault(key, key == "visible")
            if not isinstance(actor[key], bool):
                raise ValueError(f"Invalid actor {key}")
        actor.setdefault("source", {"kind": "human"})
        if not isinstance(actor["source"], dict) or actor["source"].get("kind") != "human":
            raise ValueError("Editable actors require a human source")
        normalize_transform(actor)
        for key in ("pose", "mesh"):
            actor.setdefault(key, {})
            if not isinstance(actor[key], dict):
                raise ValueError(f"Actor {key} must be an object")
        bones = actor["pose"].get("bones", {})
        if not isinstance(bones, dict):
            raise ValueError("Actor bones must be an object")
        for rotation in bones.values():
            if not isinstance(rotation, list) or len(rotation) != 3 or not all(finite(value) for value in rotation):
                raise ValueError("Invalid actor bone rotation")
        identity = actor.setdefault("identity", {})
        if not isinstance(identity, dict):
            raise ValueError("Actor identity must be an object")
        identity.setdefault("asset", None)
        identity.setdefault("inputKey", None)
        identity.setdefault("sourcePerson", None)
        identity.setdefault("description", "")
        if identity["inputKey"] is not None and (not isinstance(identity["inputKey"], str) or not ACTOR_KEY.fullmatch(identity["inputKey"])):
            raise ValueError("Invalid actor reference input key")
        if not isinstance(identity["description"], str) or len(identity["description"]) > 16000:
            raise ValueError("Actor identity description must be text up to 16000 characters")
        asset = identity["asset"]
        if asset is not None and (not isinstance(asset, dict) or not isinstance(asset.get("name"), str)):
            raise ValueError("Actor identity asset must be an image reference")
        person = identity["sourcePerson"]
        if person is not None and not isinstance(person, (dict, str)):
            raise ValueError("Invalid source person binding")
        actor.setdefault("poseSource", None)
    props = scene.get("props", [])
    if not isinstance(props, list):
        raise ValueError("Scene props must be a list")
    prop_ids = set()
    for index, prop in enumerate(props):
        if not isinstance(prop, dict):
            raise ValueError("Invalid scene prop")
        prop_id = prop.get("id")
        if not isinstance(prop_id, str) or not prop_id or len(prop_id) > 128 or prop_id in prop_ids or prop_id in ids:
            raise ValueError("Prop IDs must be unique nonempty strings")
        prop_ids.add(prop_id)
        prop.setdefault("label", f"道具 {index + 1}")
        if not isinstance(prop["label"], str):
            raise ValueError("Invalid prop label")
        for key in ("visible", "locked"):
            prop.setdefault(key, key == "visible")
            if not isinstance(prop[key], bool):
                raise ValueError(f"Invalid prop {key}")
        asset = prop.get("asset")
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str) or not re.fullmatch(r"[a-f0-9]{64}\.glb", asset["name"]):
            raise ValueError("Scene props require an embedded GLB asset")
        normalize_transform(prop)
    target = scene.get("cameraTarget")
    if target is not None and (not isinstance(target, list) or len(target) != 3 or not all(finite(value) for value in target)):
        raise ValueError("Scene cameraTarget must contain three finite coordinates")
    selection = scene.get("selectedActorIds", [])
    if not isinstance(selection, list) or any(not isinstance(actor_id, str) or actor_id not in ids for actor_id in selection):
        raise ValueError("Selected actors must exist in the scene")
    contacts = scene.get("contacts", [])
    if not isinstance(contacts, list):
        raise ValueError("Scene contacts must be a list")
    contact_ids = set()
    for contact in contacts:
        if not isinstance(contact, dict):
            raise ValueError("Invalid scene contact")
        contact_id = contact.get("id")
        if not isinstance(contact_id, str) or not contact_id or len(contact_id) > 128 or contact_id in contact_ids:
            raise ValueError("Contact IDs must be unique nonempty strings")
        contact_ids.add(contact_id)
        participants = contact.get("actors")
        if (not isinstance(participants, list) or len(participants) != 2
                or any(not isinstance(actor_id, str) or actor_id not in ids for actor_id in participants)
                or participants[0] == participants[1]):
            raise ValueError("Contact participants must be two existing distinct actors")
        sides = contact.get("sides")
        if not isinstance(sides, list) or len(sides) != 2 or any(side not in ("l", "r") for side in sides):
            raise ValueError("Contact sides must identify both hands")
        anchor = contact.get("anchor")
        if not isinstance(anchor, list) or len(anchor) != 3 or not all(finite(value) for value in anchor):
            raise ValueError("Contact anchor must contain three finite coordinates")
        contact.setdefault("mode", "align-once")
        if not isinstance(contact["mode"], str):
            raise ValueError("Invalid contact mode")
    templates = scene.get("compositionTemplates", [])
    if not isinstance(templates, list):
        raise ValueError("Composition templates must be a list")
    for template in templates:
        if not isinstance(template, dict) or not isinstance(template.get("name", ""), str):
            raise ValueError("Invalid composition template")
        if any(key in template for key in ("actors", "props", "contacts")):
            cast = canonical_scene({"version": 2, "actors": template.get("actors", []), "props": template.get("props", []),
                                    "contacts": template.get("contacts", [])})
            for key in ("actors", "props", "contacts"):
                if key in template:
                    template[key] = cast[key]
        camera = template.get("camera")
        if camera is not None and (not isinstance(camera, dict) or any(not finite(value) for value in camera.values())):
            raise ValueError("Invalid composition camera")
        target = template.get("cameraTarget")
        if target is not None and (not isinstance(target, list) or len(target) != 3 or not all(finite(value) for value in target)):
            raise ValueError("Invalid composition cameraTarget")
    return scene


def output_actors(scene):
    if scene.get("source", {}).get("kind") != "human":
        return []
    return [actor for actor in scene.get("actors", []) if actor.get("visible", True)]


def actor_mode(scene):
    settings = scene.get("conditioning", {})
    guide = settings.get("guide", "coarse")
    static_guide = guide != "coarse" and (
        settings.get("map") and (settings.get("mapKind") or guide) == guide
        or guide == "canny" and scene.get("reference") and settings.get("mapOrigin") != "auto")
    return (settings.get("identityMode") == "actors" and settings.get("model", "anyangle") == "base"
            and scene.get("source", {}).get("kind") == "human" and (settings.get("promptMode") == "custom" or not static_guide))


def build_manifest(scene):
    settings = scene.get("conditioning", {})
    order = settings.get("imageOrder", "guide-first" if actor_mode(scene) else "reference-first")
    actors = output_actors(scene) if actor_mode(scene) else []
    references = []
    by_name = {}
    records = []
    for actor in actors:
        identity = actor.get("identity") or {}
        asset = None if settings.get("promptMode") == "single" else identity.get("asset")
        name = asset.get("name") if isinstance(asset, dict) else None
        if name and name not in by_name:
            by_name[name] = len(references)
            references.append({"asset": asset, "actorIds": []})
        reference = references[by_name[name]] if name else None
        if reference is not None:
            reference["actorIds"].append(actor["id"])
        records.append({"id": actor["id"], "label": actor.get("label", actor["id"]),
                        "editorColor": actor.get("editorColor"), "description": identity.get("description", ""),
                        "sourcePerson": identity.get("sourcePerson"), "inputKey": identity.get("inputKey"),
                        "referenceName": name, "transform": actor.get("transform", {})})
    if not actor_mode(scene) and settings.get("promptMode") != "single" and scene.get("reference"):
        references = [{"asset": scene["reference"], "actorIds": []}]
    guide_index = 1 if order == "guide-first" or not references else len(references) + 1
    for index, reference in enumerate(references, 1 if guide_index > 1 else 2):
        reference["index"] = index
    indices = {reference["asset"]["name"]: reference["index"] for reference in references}
    for actor in records:
        actor["referenceIndex"] = indices.get(actor.pop("referenceName"))
    count = len(references) + 1
    return {"version": 1, "imageOrder": order, "guide": {"index": guide_index,
            "width": scene.get("width"), "height": scene.get("height")}, "references": references,
            "actors": records, "imageCount": count,
            "warnings": ["超过 Qwen Image 2.1 官方说明的 10 张参考图范围，效果未验证。"] if count > 10 else []}


def source_person_text(source):
    if isinstance(source, str):
        return source
    if not isinstance(source, dict):
        return ""
    parts = [str(source["description"])] if source.get("description") else []
    box = source.get("bbox")
    if isinstance(box, list) and len(box) == 4 and all(finite(value) for value in box):
        region = "selected source pixel region [" + ", ".join(number_text(value) for value in box) + "]"
        width, height = source.get("canvasWidth"), source.get("canvasHeight")
        if all(finite(value) and value > 0 for value in (width, height)):
            region += f" in a {number_text(width)} x {number_text(height)} image"
            normalized = [value / (height if index % 2 else width) for index, value in enumerate(box)]
            if all(finite(value) and abs(value) <= 1e6 for value in normalized):
                rounded = [math.copysign(math.floor(abs(value) * 1e6 + .5) / 1e6, value) for value in normalized]
                region += " (normalized region [" + ", ".join(number_text(value) for value in rounded) + "])"
        parts.append(region)
    return "; ".join(parts)


def actor_prompt(scene, manifest):
    settings = scene.get("conditioning", {})
    if settings.get("promptMode") == "custom":
        return settings.get("customPrompt", "")
    guide = settings.get("guide", "coarse")
    instructions = {"coarse": "camera angle, composition, body poses, scale and facing directions",
                    "pose": "body poses, limb directions, position and framing",
                    "depth": "spatial depth, layout and occlusion relationships",
                    "canny": "silhouettes, contours and major edge layout"}
    actors = manifest["actors"]
    lines = [f"Create one coherent scene with exactly {len(actors)} people.",
             f"Use <image{manifest['guide']['index']}> as the {guide} guide for {instructions[guide]}."]
    for index, actor in enumerate(actors, 1):
        descriptor = actor["description"].strip()
        if actor["referenceIndex"]:
            source = actor.get("sourcePerson")
            source_text = source_person_text(source)
            identity = f"the character {source_text or ''} from <image{actor['referenceIndex']}>".replace("  ", " ")
        else:
            identity = descriptor or f"the person described as {actor['label']}"
        position = actor.get("transform", {})
        location = "world position ({}, {}, {}), facing {} degrees".format(*(number_text(position.get(key, 0)) for key in ("x", "y", "z", "yaw")))
        color = f"{actor['editorColor']} mannequin" if guide == "coarse" and settings.get("colorActors") is True and actor.get("editorColor") else f"person {index} in the guide"
        lines.append(f"Person {index} ({actor['label']}): use {identity}; match the {color}'s pose and placement ({location})." +
                     (f" {descriptor}" if descriptor and actor["referenceIndex"] else ""))
    lines.append("Keep each person's face, hairstyle and clothing separate. Do not add extra people, mannequin colors, skeleton lines, labels or guide borders.")
    extra = settings.get("promptExtra", "").strip()
    if extra:
        lines.append(extra)
    return "\n".join(lines)


def asset_names(document):
    names = set()
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in ("manifest", "resolvedPrompt"):
                    continue
                if key in ("name", "sourceName") and isinstance(item, str) and re.fullmatch(r"[a-f0-9]{64}\.(png|glb|ply)", item):
                    names.add(item)
                elif isinstance(item, (dict, list)):
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    visit(document)
    return names
