<p align="center"><img src="web/icons/aperture.svg" width="48" alt="AnyAngle Studio"></p>
<h1 align="center">AnyAngle Studio · T8</h1>
<p align="center"><strong>Compose multiple actors with independent references, a 3D camera and structure guides.</strong></p>
<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p align="center">ComfyUI custom node · Qwen Image 2.1 · optional AnyAngle LoRA · TripoSplat · MIT</p>

![v1.5.3 actual ComfyUI three-person workbench and camera bookmarks](docs/images/studio-multi-person-v153.png)

<p align="center"><sub>v1.5.3 · Actual ComfyUI workbench screenshot · Bundled mannequin; Fisher is not required</sub></p>

**Original model: [lilylilith / QI_2.1_AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)** · [Basic workflow](workflows/AnyAngle-Studio-Qwen21.json) · [Advanced workflow](workflows/AnyAngle-Studio-Qwen21-Advanced.json) · [中文说明](README.md)

## Multi-person workbench · 1.5.3

**[Multi-person workflow](workflows/AnyAngle-Studio-Qwen21-MultiPerson.json)** · **[Three-person scene ZIP with reference images](examples/multi-person-photo-pose.zip)** · [Measured results and limitations](docs/multi-person-validation.md#english)

The middle images below are actual node exports; the right images are actual native Qwen Image 2.1 workflow results. All references depict original AI-generated fictional people. Settings: seed 42, 20 steps, CFG 3, euler/simple, AnyAngle strength 0.

| Identity references | POSE from the 3D camera · `image_1` | Final Qwen image |
|:---:|:---:|:---:|
| <img src="docs/images/multi-identity-reference.png" width="220" alt="Shared two-person identity reference"> | <img src="docs/images/multi-two-pose-guide.png" width="220" alt="Actual two-person camera pose guide"> | <img src="docs/images/multi-two-pose-final.png" width="220" alt="Actual two-person generated pose result"> |
| <img src="docs/images/multi-identity-reference.png" width="110" alt="Shared two-person reference"><img src="docs/images/demo-reference.png" width="110" alt="Third person's identity reference"> | <img src="docs/images/multi-three-pose-guide.png" width="220" alt="Actual three-person camera pose guide"> | <img src="docs/images/multi-three-pose-final.png" width="220" alt="Actual three-person generated pose result"> |

| Identity references | 3D-camera Canny · `image_1` | Native Qwen result · layout differs |
|:---:|:---:|:---:|
| <img src="docs/images/multi-identity-reference.png" width="110" alt="Shared two-person reference"><img src="docs/images/demo-reference.png" width="110" alt="Third actor reference"> | <img src="docs/images/multi-three-canny-fixed-guide.png" width="220" alt="Actual three-person Canny edges"> | <img src="docs/images/multi-three-canny-fixed-final.png" width="220" alt="Actual Canny result; rear actor placement and action differ"> |

The Canny example keeps three people, clothing order and the blue actor's raised arm, but misses the rear actor's pose and occlusion. The displayed output preserves these observed differences.

Two actors share one group image; the three-person case adds one individual reference. Clothing, left-to-right mapping and the raised arm follow the two POSE examples, while faces, hairstyles and body proportions can drift. **This is not exact identity locking or pixel-perfect pose control.** Import the ZIP through **全场模板与便携场景 → 导入场景 ZIP**, Apply, and run the multi-person workflow.

The same scene can also produce these structure maps; the maps themselves are not final generated results.

| Scene render · Optional actor colors | Standard POSE | 3D scene depth from the same camera |
|:---:|:---:|:---:|
| <img src="docs/images/multi-coarse.png" width="250" alt="Two-actor scene render"> | <img src="docs/images/multi-pose.png" width="250" alt="Two-actor standard skeleton"> | <img src="docs/images/multi-depth.png" width="250" alt="Shared depth range for both actors"> |

- **Independent actors in one scene:** add, copy, delete any actor, reorder, hide and lock. Click actors to edit; Ctrl-click to select several. Shape, pose, position, scale, heading and identity are independent. Switching actors keeps the camera; copying clears identity photos by default.
- **Group photo to multiple poses:** DWPose detects and deduplicates candidates. Confirm people before copying to the current actor or adding actors. Multi-person Fisher skeleton PNGs, standard OpenPose JSON and native `POSE_KEYPOINT` connections are supported. Pose copying and matching source placement are separate; partial detections are flagged, and inferred PNG points are excluded from pose copying. Saving, importing and depth flipping affect only the current actor.
- **Shared camera and guides:** scene render, standard POSE, scene Canny and 3D scene depth use the same capture camera. Depth supports near-white or far-white. POSE can include real finger joints, known eye/nose landmarks and filtering behind actors and visible props. Photo DA3 depth remains static.
- **Identity and prompt mapping:** select Qwen base and separate actor identities. Upload photos, bind `actor_reference_1…` inputs, or describe each actor in text. Actors can share a group photo: prompts include both the selected region and its description, and editing the description preserves that region. The multi-person encoder reads the saved manifest and delegates to native Qwen, keeping image indices and prompts synchronized.
- **Composition and reuse:** randomize current, selected or all unlocked actors with a repeatable seed. Full-scene templates save poses, placement, props and camera, retaining identities after actor reordering. Ground feet, arrange groups/dialogue/handshakes and export portable scene ZIPs. Hand contact performs one approximate IK alignment and can be realigned or refined manually; it is not continuous constraint solving or collision simulation. Batch views freeze the actors and reference photos.
- **Independent camera bookmarks:** bookmarks and batch views include the camera target. Restore the original framing after applying another scene template while keeping the actors’ current poses.

**1.5.3 fixes:** failed bookmark thumbnails restore the camera and undo/redo; browser pose libraries recover from invalid entries and storage failures; malformed uploads and invalid guide types return clear errors; Windows concurrent saves no longer race within the plugin process. [Fresh 20-scope joint audit](docs/audit-1.5.3.md#english) · [1.5.2 audit](docs/audit-1.5.2.md#english).

OpenPose JSON uses pixel coordinates. If canvas dimensions are absent, the source photo dimensions take priority; without a photo, the current output dimensions are used. An import notice identifies the canvas to check. Convert coordinates normalized to `[0,1]` or `[-1,1]` to pixels first. [Official output format](https://github.com/CMU-Perceptual-Computing-Lab/openpose/blob/master/doc/02_output.md#json-output-format).

**Use:** load the multi-person workflow → add actors in Studio → bind photos or describe appearance → choose scene render/POSE/3D Depth/Canny → adjust actors and camera → Apply → run. Connect `guide_image_2` and `scene_json` to **AnyAngle Multi-person Encode**; separate encoder photo wires are unnecessary. Single-guide mode ignores identity photos; custom mode preserves the prompt verbatim. Alt+Left/Right switches actors and Delete removes the current actor; these shortcuts do not trigger while typing.

POSE, Depth or Canny extracted from a photo or imported as an image use that image's composition, without imposing the retained 3D cast count. Default mode uses the shared original; without one, it uses a single structure image plus the accompanying text. Returning to a 3D guide restores actor bindings. Custom mode can use actor reference photos; bind the left-side original to an actor to include it, and maintain image indices in your custom text.

Qwen base with AnyAngle disabled is recommended for changing poses. Existing two-image camera-edit workflows remain available. **[Qwen officially supports up to 10 reference images](https://huggingface.co/Qwen/Qwen-Image-2.1)** including the guide; this does not guarantee nine correct identities or an exact person count. Native encoder slots are not a quality guarantee. Each IMAGE input uses its first batch item. Guide-first is recommended: the first reference determines the latent frame. Actual encoded dimensions appear beside the multi-person encoder’s latent output. Actor photos use a 512-pixel area budget by default; set it to 0 to keep their original sizes.

No additional weights are required beyond the bundled mannequin and existing DWPose. Rendered scene depth does not use DA3. Existing GLB/TripoSplat sources remain single-asset routes; GLB props can share the mannequin scene, but reconstructions are not editable rigs. The multi-person organization was researched against [Gaoshang Pose](https://github.com/GStaaaaa/ComfyUI-Gaoshang-Pose); its gallery is not redistributed.

**Measured limits:** all 32 main-matrix jobs executed successfully, but only 7 broadly matched person count, key poses and occlusion, with 2 partially matching. Nine-person cases added people or lost poses. The base model interprets structure maps as image references. Start with fewer people, clear spacing and POSE, then inspect each result. [Full matrix, photo cases and performance measurements](docs/multi-person-validation.md#english).

**Scene Canny:** mannequins and GLBs use a high-contrast clay pass with the same camera to extract geometry contours, avoiding empty maps caused by low contrast between actor colors and grey backgrounds. Texture details are excluded. TripoSplat uses its color render; photo Canny keeps the source pixels. Empty detection displays a threshold/framing warning and still allows an intentional blank guide to be exported.

## What it produces

| Original reference · `image_1` | New-view guide · `image_2` | Final AnyAngle result |
|:---:|:---:|:---:|
| <img src="docs/images/demo-reference.png" width="220" alt="Original reference image of a fictional demo character"> | <img src="docs/images/demo-guide.png" width="220" alt="Guide image exported by the actual node"> | <img src="docs/images/demo-final-qwen.png" width="220" alt="Final image generated by Qwen Image 2.1 AnyAngle using the reference and guide"> |

The middle image was **exported by the node** to condition AnyAngle. The right image was **generated by the example workflow** using the reference, guide, and AnyAngle LoRA (seed 42, 20 steps, CFG 3). The demo subject is a fictional, originally generated character. Single-image reconstruction must infer unseen sides and cannot guarantee exact agreement with the source.

- **Direct reference connection:** the left `reference_image` socket accepts a ComfyUI IMAGE; uploads work in the editor too.
- **Reference-based subject:** local TripoSplat reconstruction provides a scene whose pose stays fixed while you move the camera.
- **Interactive camera:** orbit, middle-button or Shift+left-button pan, wheel zoom, numeric angles, framing, saved views, undo, and redo.
- **Three scene sources:** photo reconstruction, textured GLB, and a built-in MakeHuman mannequin for manual posing. The mannequin ships with this repository; Fisher is not required.
- **Unified guide controls:** choose coarse render, POSE, Depth, or Canny in the right panel. DWPose and DA3 extract from the photo; Canny can use the photo or 3D camera. Import/connect existing maps too. With AnyAngle off, the base model uses the selected guide and matching prompt.
- **Reusable outputs:** `guide_image_2`, `prompt`, `scene_json`, and `anyangle_lora_strength`. Applied scenes run from saved workflows without reopening the editor.

A TripoSplat photo reconstruction has **no editable skeleton**. Use camera mode for that source; choose the separate mannequin mode when you need to pose joints by hand.

### 3D camera workbench

![The 3D workbench with a reference, interactive camera and clean output](docs/images/studio-photo.png)

Drag to orbit, middle-button or Shift+left-button drag to pan, and scroll to zoom. Reconstruction opens the interactive 3D view; choose **Preview current camera render** for the clean output. The screenshot illustrates 3D scene mode; all four guide types are selected in the right panel.

**Keep background during reconstruction (1.2.0, experimental):** enable **保留背景参与重建** below the reference image, then click **保留背景重建 3D**. The full image enters TripoSplat without BiRefNet segmentation. Disable the checkbox to return to subject-only reconstruction. Both modes have separate caches; the preference is saved with the scene and requires reconstruction after switching. Camera rotation, guide export and batch views remain available. Base-model coarse prompts request both foreground and background; AnyAngle retains its official prompt.

BiRefNet is not required in this mode, and no additional weights are needed. **TripoSplat primarily generates objects; preserving the input background does not accurately recover a complete room or a 360° environment.** Walls, floors and occluded regions remain inferred, so wider camera changes may show distortions or gaps. The [official preprocessing](https://github.com/VAST-AI-Research/TripoSplat/blob/main/triposplat.py) segments the foreground by default; this node adds the experimental option.

| Input image | Actual 3D result with background |
|:---:|:---:|
| <img src="docs/images/demo-reference.png" width="240" alt="Original fictional character and studio background"> | <img src="docs/images/demo-scene-background.png" width="240" alt="TripoSplat reconstructs the character, wall and floor together"> |

The same original demo image produced 262,144 Gaussians, rendered from a new view with ComfyUI's native Render Splat. The background belongs to the generated 3D geometry.

### Manual mannequin workbench

![The built-in MakeHuman mannequin, pose presets, and joint editing controls](docs/images/studio-human.png)

The included mannequin supports pose presets, hands, body proportions, and joint editing. **POSE → Extract pose from photo** directly outputs the photo skeleton. Choose **Edit pose with 3D mannequin**, or click **Copy photo pose to mannequin** on the left for extraction and retargeting in one action. The screenshot shows standalone preview mode; when opened from a node, the top-right action reads **Apply to node**.

For pose edits, select **Qwen base + POSE** and connect the LoRA strength output. Choosing a preset or editing joints outputs the current mannequin skeleton; this selection survives guide changes and reopening a saved scene. **Use photo skeleton** restores the visible photo pose. DWPose on a cropped photo detects visible joints, without reconstructing limbs outside the image. AnyAngle LoRA is primarily for camera changes.

### Lens perspective and photo pose copying · 1.4.0

![Focal length and scene perspective illustration](docs/images/lens-perspective.svg)

- **Lens perspective:** choose Custom focal length on the right, adjust 12–200 mm or select 24 / 50 / 85 mm. Camera distance changes with the lens to keep the target plane size; foreground and background proportions change. Mannequins, GLBs and TripoSplat use the same lens for preview, export, bookmarks and batch views. Original lens remains the default for existing workflows.
- **Photo → mannequin:** the left-side Copy photo pose to mannequin action runs DWPose and retargets in one step, selecting Qwen base + POSE. Conservative planar mode follows visible segment directions and mannequin bone lengths. Cropped photos retain the current pose of unseen limbs. Estimated depth mode requires full-body joints and allows depth flips. A 2D photo cannot recover accurate depth; complex occlusion still needs adjustment. Use the original photo skeleton when matching its framing is the priority.
- **Random poses:** choose mixed, standing, action or seated in the mannequin pose library. Generate a new pose or reproduce one by seed, then undo, edit or save it. Random poses are not guaranteed to be collision-free or anatomically natural.
- **Asset recovery:** mannequin or skin timeouts stop loading and offer Retry or Repair mannequin assets. Repair only runs on an explicit click and verifies/restores the bundled mannequin and skin. It does not download LoRA or inference weights; `python install_assets.py` is the CLI alternative.

Lens values use a 24 mm vertical sensor. Objects outside the target plane can change size with perspective. No additional models are needed; photo copying uses the existing DWPose weights.

### Base model and structure maps

![Actual POSE, Depth and Canny guides](docs/images/structure-guides.png)

Select **Qwen base** under Guide Strategy to output `anyangle_lora_strength = 0`; switch back to **AnyAngle LoRA** for `1`. The updated basic and advanced workflows use the bundled **AnyAngle Optional LoRA** loader and connect this output to `strength_model`. At strength 0 it passes the base model through without requiring the AnyAngle file. For an older workflow, replace its loader and connect the strength output, or remove its LoRA loader. Switching the editor alone cannot override a fixed strength in an old workflow.

| Base-model guide | Source and behavior |
|---|---|
| Coarse 3D render | Choose **Reconstruct 3D from photo** to run TripoSplat, then preview the clean camera render. Existing GLB scenes and mannequins can be rendered directly. |
| POSE | DWPose directly outputs visible body, hand, and face keypoints at the original framing. Fisher-compatible skeletons can also be imported. Full-body skeletons can optionally be edited with the 3D mannequin and exported from the adjusted camera. |
| Depth Anything | Click **Estimate depth from photo** to run the bundled Depth Anything 3 Small integration, or connect another depth node to `structure_image` / upload a PNG. Original-photo depth remains at the original view; rotating the camera does not synthesize a new depth view. |
| Canny | Extract photo edges by default. Explicitly choose **Generate Canny from 3D camera** for scene edges, or connect/import an existing map. |

**Photo extraction:** connect `reference_image` → select **Qwen base** → choose **POSE / Depth / Canny** → click the mode's photo-extraction action → inspect the central preview → **Apply to node**. PNG export, output size and prompts use the selected guide.

Full-resolution examples: [POSE](docs/images/demo-pose.png) · [Depth](docs/images/demo-depth.png) · [Canny](docs/images/demo-canny.png). These are conditioning images; final base-model results also depend on prompts and sampling settings.

Reconstruction opens the interactive **3D workbench** by default. Choose **Preview current camera render** to inspect the actual `image_2` output, then switch back to adjust the camera. Photo skeletons and depth appear directly in the central **Guide preview** at the original view; a cropped portrait is not automatically converted into a full mannequin pose.

The original still goes to `reference_image` and encoder `image_1`; `guide_image_2` goes to encoder `image_2`. Each guide mode supplies a matching edit prompt. DWPose extracts **2D joints**; inspect occluded limbs and front/back depth in the editor. The base model treats the structure map as an **image reference** rather than a dedicated ControlNet input. Pose, depth, and edge adherence are therefore model-dependent, not guaranteed hard constraints. Imported maps are letterboxed to the output size instead of stretched.

### Prompts and single-guide workflows · 1.3.0

![Dual-image and single-guide wiring](docs/images/prompt-modes.svg)

**Wiring and prompt** offers three modes. Settings and output prompts persist with the scene:

| Mode | Wiring and use |
|---|---|
| Dual-image template (default) | Keeps the existing AnyAngle / base templates. Select original 1 / guide 2 or reverse the order; template image tags follow that selection. Connect the encoder accordingly. |
| Single guide | Selects Qwen base and LoRA strength 0. Connect the guide to `image_1`, without an original photo. Add text describing the subject and style. Supports coarse 3D, POSE, Depth and Canny. |
| Custom | Outputs text verbatim, preserving image tags, spacing and line breaks. Leave it empty to compose the prompt elsewhere in your workflow. |

The [single-guide workflow](workflows/AnyAngle-Studio-Qwen21-SingleGuide.json) connects the guide and LoRA strength. Choose **Single guide** in the studio, load a mannequin / GLB / structure map, then **Apply to node**. The compatible output name remains `guide_image_2`; this template connects it to encoder `image_1`. Single-guide mode needs no AnyAngle weights. Qwen derives its output aspect from the first image received by the encoder.

### Camera bookmarks and performance · 1.3.0

Bookmarking from scene-edit mode adopts the current view. Clicking a thumbnail returns to the photo camera and restores azimuth, elevation, zoom, offsets and dimensions. Bookmarks are draft changes until **Apply to node**; cancelling discards the current edits. Disable **Allow mouse pitch** for horizontal mouse rotation while retaining the elevation slider.

Splat workbenches render on demand, stopping continuous refresh when idle and updating after sorting completes. For slower computers, choose **Economy** under **Workbench performance**, disable **Automatic guide preview**, and refresh the guide manually. Display quality affects viewport pixels; export keeps the configured dimensions. Initial model loading, reconstruction and sorting may temporarily use CPU. If usage stays high while idle, report the browser, GPU, hardware-acceleration setting and stage where it occurs. This update needs no additional models.

### Batch views and generation · 1.1.0

![Batch views: choose angles, render independent guides, queue Qwen jobs and save outputs](docs/images/batch-flow.svg)

Click **批量机位** (Batch views) below the 3D viewport. Choose an angle range or saved camera views: `0° → 330° / 30°` produces 12 views; `0° → 360° / 1°` produces 360 views, omitting the duplicate endpoint. Angle ranges keep the current pose, elevation and framing; saved views use their own camera settings and dimensions.

- **批量渲染粗图 (Render guides):** saves independent guides for every view, with a PNG ZIP and task manifest. Qwen inference is not required.
- **批量生成最终图 (Generate final images):** available when the studio is opened from its node. Each view queues the workflow, seed and sampling settings captured when the batch starts. Connect **Save Image** to save results in `ComfyUI/output/`. Each PNG records its own view in workflow metadata; the currently edited node snapshot stays unchanged.
- **停止后续机位 (Stop remaining views):** queued jobs keep running. Saved guides and the manifest remain downloadable. The studio reports submission progress; check ComfyUI's queue for generation progress.

Supports 3D coarse renders, 3D mannequin POSE and Canny from 3D views, with no additional weights. Extracted or imported 2D POSE / Depth / Canny maps retain their original view and cannot produce new camera angles.

## Quick start

1. Install the node and models below, restart ComfyUI, and load the [basic workflow](workflows/AnyAngle-Studio-Qwen21.json).
2. Connect the original image to both Studio `reference_image` and encoder `image_1`. Connect Studio `guide_image_2` to encoder `image_2`, Studio `prompt` to encoder `prompt`, and `anyangle_lora_strength` to **AnyAngle Optional LoRA** `strength_model`. Optionally connect a structural IMAGE to `structure_image`.
3. Open AnyAngle Studio from the **Comfyui-Qwen-Image-2.1-MultiAngle-T8** node, wait for reconstruction, drag to choose a camera, inspect the guide, click **Apply to node**, and run the workflow.

![How to connect the original, optional structure map, Studio, and Qwen Image 2.1](docs/images/wiring.svg)

A Load Image connection is read automatically. For other upstream IMAGE nodes, click **读取上游图像** (Read upstream image). A batch uses its first image. In photo mode, **0°** means the model's predicted reference camera. Grids, controls, and camera frames are excluded from the guide.

The basic workflow starts in **AnyAngle mode: LoRA 1 · CFG 3 · 20 steps · euler / simple**. Its default prompt is:

```text
Change the camera angle from <image2> to <image1>.
```

The [advanced workflow](workflows/AnyAngle-Studio-Qwen21-Advanced.json) includes an optimization chain, prompt composition, and a three-image comparison; it uses **LoRA 1 · CFG 1 · 40 steps**. It also requires separately installed `QwenImage21SpectrumT8`, `QwenImage21SageAttentionT8`, `QwenImage21BlockCacheT8`, KJNodes, Easy Use, and Comfyroll nodes. Use the basic workflow if these are unavailable. The template contains no machine-specific image or scene snapshot; select an image and apply a new camera view before running.

## Install

**1.2.1 fixes:** pose preset thumbnails now frame the full mannequin; editing the rig replaces a previously extracted photo skeleton in POSE output. Versions 1.0.1 and earlier also had a high-DPI capture error that enlarged the preview toward the upper-right corner; this was fixed in 1.0.2. The yellow frame marks the actual output area. Use **Fit frame** if the figure extends outside it.

Run `git pull` in the node directory, restart ComfyUI, close the old studio and reload with `Ctrl+F5`. The reopened studio header should show **T8 · v1.5.3**. **Apply to node** again to replace previously saved guide images.

Search for **Comfyui-Qwen-Image-2.1-MultiAngle-T8** in ComfyUI Manager and select a published version, or use Git below. The Registry node ID is `qwen-image-21-multiangle-t8`. The mannequin, frontend assets and example workflows ship with the node; prepare model weights only for the features you use.

A successful Registry upload does not mean security approval; [check the live version status](https://api.comfy.org/nodes/qwen-image-21-multiangle-t8/versions). If a release is not listed in Manager, use the Git installation below.

Use ComfyUI with native **Qwen Image 2.1, TripoSplat, BiRefNet, and DINOv3 nodes**. Tested with **ComfyUI 0.36.0**. Enable WebGL hardware acceleration in your browser. Run from your ComfyUI directory:

```bash
cd custom_nodes
git clone https://github.com/T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8.git ComfyUI-AnyAngle-Studio-T8
cd ComfyUI-AnyAngle-Studio-T8
python -m pip install -r requirements.txt
python install_assets.py --download-lora
python install_reconstruction.py
```

The node title shows the full GitHub repository name. The black **source badge** above it comes from ComfyUI's installation folder name. When the folder contains `2.1`, the current frontend splits it at the dot and shows only `Comfyui-Qwen-Image-2`. Use the dot-free folder name in the command above. For an existing installation, rename the node folder to `ComfyUI-AnyAngle-Studio-T8` and restart ComfyUI; the badge will then read `AnyAngle-Studio-T8`. Node types and workflow connections are unchanged.

The MakeHuman pack and skin texture are included. `install_assets.py --download-lora` verifies them and downloads the AnyAngle LoRA. For base-model-only use, run `python install_assets.py` without the LoRA download. `install_reconstruction.py` downloads approximately **3.78 GB** of weights and can be skipped when using only the bundled mannequin or imported maps. The two DWPose ONNX files download to the node's `.local/dwpose/` directory on the first explicit **Extract pose from photo** click (about 351 MB); existing `comfyui_controlnet_aux` weights are reused when present. Depth Anything 3 Small downloads about **137 MB** on the first explicit depth action, or reuses a matching model in `models/geometry_estimation/`. Use **ComfyUI's Python environment**; in a portable build, replace `python` with its bundled executable.

### Models by feature

Paths below are relative to `ComfyUI/`; `<node-directory>` is the installed node folder.

| Feature | Files and location | Source |
|---|---|---|
| AnyAngle camera changes (optional) | `models/loras/QI2.1_AnyAngle.safetensors` | [Original model](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) |
| POSE extraction | `yolox_l.onnx` and `dw-ll_ucoco_384.onnx`; first-use downloads go to `<node-directory>/.local/dwpose/` | [DWPose ONNX weights](https://huggingface.co/yzd-v/DWPose/tree/main) |
| Depth extraction | `depth_anything_3_small.safetensors`; recommended location: `models/geometry_estimation/` | [ComfyUI-compatible weights](https://huggingface.co/Comfy-Org/Depth-Anything-3/tree/main/geometry_estimation) · [Original DA3 project](https://github.com/ByteDance-Seed/Depth-Anything-3) |
| Canny / manual mannequin | **No additional model weights**; Canny runs in the browser and the mannequin is bundled | [Edge implementation](web/editor/guides.mjs) · [Mannequin provenance](THIRD_PARTY.md) |
| Qwen Image 2.1 diffusion model / Qwen3-VL 8B / VAE | Provide separately in `models/diffusion_models`, `models/text_encoders`, and `models/vae` | Use base-model weights compatible with the workflow |

DWPose first reuses the two files from `custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/`, then uses its own cache. DA3 first checks `models/geometry_estimation/`; if absent, the first depth action downloads to `<node-directory>/.local/da3/geometry_estimation/depth_anything_3_small.safetensors`. Built-in extraction uses **Small**; other DA3 variants can be generated externally and connected to `structure_image`.

**Photo-to-3D reconstruction** requires five more files from the [official TripoSplat weight bundle](https://huggingface.co/VAST-AI/TripoSplat/tree/main). `python install_reconstruction.py` installs them here:

| File | ComfyUI directory |
|---|---|
| `triposplat_fp16.safetensors` | `models/diffusion_models/` |
| `birefnet.safetensors` | `models/background_removal/` |
| `dino_v3_vit_h.safetensors` | `models/clip_vision/` |
| `flux2-vae.safetensors` | `models/vae/` |
| `triposplat_vae_decoder_fp16.safetensors` | `models/vae/` |

Replace model filenames in the example workflow with compatible weights installed locally. AnyAngle and TripoSplat weights download from installation commands; DWPose and Depth Anything 3 download only when their actions are requested. Pose and depth inference, reconstruction, and rendering run locally.

**Reconstruction model selection (1.1.0):** supports subdirectories and extra model paths registered with ComfyUI. Standard filenames are discovered automatically. For renamed weights or multiple matching copies, expand **重建模型** (Reconstruction models) in the left panel, choose compatible weights for all five roles, save the selection, then reconstruct. Preferences stay in the current browser; changing models does not reuse the old reconstruction cache. Restart ComfyUI and refresh with `Ctrl+F5` after updating.

If an older installation shows `MakeHuman asset: HTTP 404`, run `git pull` inside the node directory, confirm that `web/vendor/assets/pose_studio_makehuman.v2.bin` and `web/vendor/textures/skin.png` exist, restart ComfyUI, and hard-refresh the browser. If either file is still missing, click Repair mannequin assets in the error dialog or run `python install_assets.py`.

## Storage, portability, and limits

- Scenes, guides, and assets live in `ComfyUI/input/anyangle_studio/`. Copy the associated assets when moving a workflow. The [API workflow](workflows/AnyAngle-Studio-Qwen21-API.json) requires an applied snapshot.
- If a workflow's snapshot is missing on this machine, the editor opens a blank scene so you can read the reference, reconstruct or import a subject, and apply again before running. Authorization and server errors are reported separately.
- GLBs must embed textures; Draco, Meshopt, and KTX2 compression are unsupported. GLB front calibration applies only to imported GLBs. Use camera angles and framing for photo reconstructions.
- A single image cannot precisely recover occluded or cropped body parts or the complete background. Guide dimensions and downstream generation resolution are configured separately.
- Verified on an RTX 5090 Laptop with 24 GB VRAM; adjust models and resolution for other hardware.

### Network access

Repair mannequin assets runs only when clicked. It downloads missing or damaged mannequin / skin files from a pinned commit in this repository and verifies SHA-256. Complete assets do not require network access.

Node endpoints use the ComfyUI server's access boundary and do not provide a separate login system. For local use, keep ComfyUI's default `--listen 127.0.0.1`. LAN and cloud deployments need a trusted network, VPN or authenticated reverse proxy protecting the entire ComfyUI service, including `/anyangle-studio/*`. Do not expose an unauthenticated port directly to the Internet; a loopback client-IP restriction does not replace authentication.

## Credits and license

Thanks to [AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle), [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat), [Fisher Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose), [VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils), and [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D). This is an independent integration, not an official plugin from the model authors.

Project code uses [MIT](LICENSE). Third-party code, assets, and models retain their own licenses; see [third-party notices](THIRD_PARTY.md).

## T8 links

[Bilibili](https://space.bilibili.com/385085361) · [YouTube](https://www.youtube.com/@T8star-Aix/) · [Hugging Face](https://huggingface.co/t8star)

[API service](https://api.seedance.nz/sign-up?aff=5f4w) · [Free gallery](https://www.openzhenzhen.com) · [Online AI apps](https://www.runninghub.ai/zh-cn/user-center/1907375370302308353/userPost?inviteCode=rh-v1121) · [ComfyUI bundle](https://pan.quark.cn/s/264edb7e36bd)
