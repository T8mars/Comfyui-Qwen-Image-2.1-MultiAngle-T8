# Qwen Image 2.1 MultiAngle · T8

[简体中文](README.md) | **English**

A standalone visual camera editor for ComfyUI. Reconstruct a reference image into a 3D subject, adjust the camera interactively, and render a new-view guide for Qwen Image 2.1 AnyAngle.

**Original model: [lilylilith / QI_2.1_AnyAngle · Hugging Face](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)**

Reference image → TripoSplat reconstruction → Interactive camera → Guide `image_2` → AnyAngle generation

## Features

- **IMAGE input:** connect to `reference_image`, or upload in the editor.
- **Photo reconstruction:** local TripoSplat generates a corresponding subject. Camera changes preserve the reconstructed pose.
- **Interactive editing:** orbit, pan, zoom, exact angles, saved views, undo and redo.
- **Other scene sources:** import a textured GLB or explicitly choose manual mannequin posing. No Fisher plugin installation required.
- **Reusable outputs:** clean guide image, prompt and scene JSON. Applied scenes run from saved workflows without opening the editor.

TripoSplat photo reconstructions have no editable skeleton, so their pose stays fixed and Edit Scene is unavailable. The pose library applies only to the manual mannequin. GLB front calibration applies only to imported GLBs; use the camera angle, zoom and framing controls for photo reconstructions.

## Installation

Use ComfyUI with native **Qwen Image 2.1, TripoSplat, BiRefNet and DINOv3 nodes**. Tested with **ComfyUI 0.36.0**. Enable WebGL hardware acceleration in your browser.

Run from your ComfyUI directory:

```bash
cd custom_nodes
git clone https://github.com/T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8.git ComfyUI-AnyAngle-Studio-T8
cd ComfyUI-AnyAngle-Studio-T8
python install_assets.py --download-lora
python install_reconstruction.py
```

The repository includes the required MakeHuman pack and skin texture. `install_assets.py --download-lora` verifies these assets and downloads the AnyAngle LoRA; `install_reconstruction.py` downloads approximately **3.78 GB** of reconstruction weights. Use **ComfyUI's Python environment**; for portable installations, replace `python` with the bundled executable. Restart ComfyUI and search for **AnyAngle Studio · T8**.

If an older installation shows `MakeHuman asset: HTTP 404`, run `git pull` in the node directory, confirm that `web/vendor/assets/pose_studio_makehuman.v2.bin` and `web/vendor/textures/skin.png` exist, then hard-refresh the browser. Run `python install_assets.py` if either file is still missing.

| Model | Source / location |
|---|---|
| AnyAngle LoRA | [Original model](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) · `models/loras/QI2.1_AnyAngle.safetensors` |
| TripoSplat and companion reconstruction weights | [Official weights](https://huggingface.co/VAST-AI/TripoSplat) · Installed into their respective directories by the script |
| Qwen Image 2.1 diffusion model / Qwen3-VL 8B encoder / Qwen Image 2.1 VAE | Provide separately in `models/diffusion_models`, `models/text_encoders`, and `models/vae` |

Replace example model filenames with compatible weights installed locally. Downloads occur only through the installation commands; reconstruction and rendering run locally.

## Workflow

Load the [example workflow](workflows/AnyAngle-Studio-Qwen21.json), then select your image and models.

| Connection | Destination |
|---|---|
| Original IMAGE | Studio `reference_image` **and** encoder `image_1` |
| Studio `guide_image_2` | Encoder `image_2` |
| Studio `prompt` | Encoder `prompt` |
| Studio `scene_json` | Optional scene record |

1. Open **AnyAngle Studio**. Load Image connections are read automatically; for other upstream nodes, click **读取上游图像** (Read upstream image). Batches use the first image.
2. Wait for reconstruction, then drag to orbit. **Shift + drag** pans; the **mouse wheel** zooms. For reconstructed subjects, **0°** is the predicted reference camera.
3. Check the guide, click **应用到节点** (Apply to node), and run. Grids, camera frames and controls are excluded from the output.

Suggested settings: **LoRA 1 · CFG 3 · 20 steps · euler / simple**. The default prompt follows the author's wiring: original in `image_1`, guide in `image_2`.

```text
Change the camera angle from <image2> to <image1>.
```

## Storage and limitations

- Scenes, guides and assets are stored in `ComfyUI/input/anyangle_studio/`. Copy associated assets when moving a workflow. The [API workflow](workflows/AnyAngle-Studio-Qwen21-API.json) requires an applied snapshot.
- Single-image reconstruction cannot precisely recover hidden surfaces, cropped body parts or the full background. Manual mannequin posing is a separate mode, not photo reconstruction.
- GLB files must embed textures. Draco, Meshopt and KTX2 compression are unsupported. Guide dimensions and downstream generation resolution are configured separately.
- Verified on an RTX 5090 Laptop with 24 GB VRAM. Adjust models and resolution for other hardware.

## Credits and license

Thanks to [AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle), [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat), [Fisher Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose), [VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils), and [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D). This is an independent integration, not an official plugin from the model authors.

Project code uses the [MIT license](LICENSE). Third-party code, assets and models retain their respective licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).

## T8 links

[Bilibili](https://space.bilibili.com/385085361) · [YouTube](https://www.youtube.com/@T8star-Aix/) · [Hugging Face](https://huggingface.co/t8star)

[API service](https://api.seedance.nz/sign-up?aff=5f4w) · [Free gallery](https://www.openzhenzhen.com) · [Online AI apps](https://www.runninghub.ai/zh-cn/user-center/1907375370302308353/userPost?inviteCode=rh-v1121) · [ComfyUI bundle](https://pan.quark.cn/s/264edb7e36bd)
