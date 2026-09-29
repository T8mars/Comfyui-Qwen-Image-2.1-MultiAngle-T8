"""Explicit, hash-checked asset installation; never runs during ComfyUI startup."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


def install(entry, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == entry["sha256"]:
        print(f"Verified {target.name}")
        return
    temporary = target.with_suffix(target.suffix + ".download")
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(entry["url"], timeout=90) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError(f"Checksum mismatch: {target.name}")
        temporary.replace(target)
        print(f"Installed {target.name}")
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-lora", action="store_true", help="Also download the official AnyAngle LoRA")
    parser.add_argument("--comfy-dir", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "assets-manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["editor"]:
        install(entry, root / entry["path"])
    if args.download_lora:
        entry = manifest["lora"]
        install(entry, args.comfy_dir / "models" / "loras" / "QI2.1_AnyAngle.safetensors")
