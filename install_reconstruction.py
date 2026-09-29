"""Explicitly install the official TripoSplat checkpoints used by native ComfyUI nodes."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
MODELS = ROOT.parents[1] / "models"
REVISION = "56a96e603204ec410c4da60c13ea4fa09a2169a9"
FILES = {
    "background_removal/birefnet.safetensors": (444473596, "9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154"),
    "clip_vision/dino_v3_vit_h.safetensors": (1681247696, "a29ef35101a16966972a0d50732a6f3a608ff7cfffb2afa9bbe9007cb842cc53"),
    "diffusion_models/triposplat_fp16.safetensors": (741106994, "c870b97ac1d6bc9177608a5ec625e19ef9f3c5019aa68f64b0fb7803abcd6d20"),
    "vae/flux2-vae.safetensors": (336213556, "d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5"),
    "vae/triposplat_vae_decoder_fp16.safetensors": (576148442, "ed0d0c3d43b599e326845d0ec70f3cf77be9a55e2d97627ac3b34d2830763cc8"),
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(item):
    name, (size, digest) = item
    destination = MODELS / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size == size and sha256(destination) == digest:
        print(f"Verified existing {name}", flush=True)
        return {"file": name, "sha256": digest, "bytes": size}
    partial = destination.with_suffix(destination.suffix + ".partial")
    url = f"https://huggingface.co/VAST-AI/TripoSplat/resolve/{REVISION}/{name}"
    for attempt in range(4):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
            with urllib.request.urlopen(request, timeout=60) as response:
                append = offset > 0 and response.status == 206
                if not append:
                    offset = 0
                with partial.open("ab" if append else "wb") as handle:
                    report = time.monotonic()
                    while chunk := response.read(8 * 1024 * 1024):
                        handle.write(chunk)
                        offset += len(chunk)
                        if time.monotonic() - report > 10:
                            print(f"{name}: {offset / size:.0%}", flush=True)
                            report = time.monotonic()
            if partial.stat().st_size != size or sha256(partial) != digest:
                raise ValueError(f"Checkpoint verification failed: {name}")
            partial.replace(destination)
            print(f"Verified {name}", flush=True)
            return {"file": name, "sha256": digest, "bytes": size}
        except (OSError, ValueError) as error:
            if attempt == 3:
                raise
            print(f"Retry {name}: {error}", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        receipts = list(pool.map(download, FILES.items()))
    (ROOT / ".local").mkdir(exist_ok=True)
    (ROOT / ".local/triposplat-downloads.json").write_text(json.dumps({"repo": "VAST-AI/TripoSplat", "revision": REVISION, "files": receipts}, indent=2), "utf-8")
    print("TripoSplat checkpoints ready", flush=True)
