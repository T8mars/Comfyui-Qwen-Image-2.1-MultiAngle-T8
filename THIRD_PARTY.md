# Third-party sources

| Component | Pinned source | License / local notice |
|---|---|---|
| VNCCS PoseViewerCore, morph runtime, hand presets | Fisher `d116451f25b1c9da36dd852fdc9df321068f4d98`, upstream AHEKOT/VNCCS `70b752f2` | MIT, `web/vendor/LICENSE`, upstream notes in `web/vendor/README.md` |
| OpenPose color-skeleton parser and 2D-to-3D lift | Fisher `d116451f25b1c9da36dd852fdc9df321068f4d98`, `web/editor/pose-import.mjs` and `web/editor/openpose-lift.mjs`; adapted into `web/editor/openpose.mjs` | MIT, `web/editor/openpose.LICENSE`; retains Work-Fisher copyright |
| MakeHuman body pack | Same Fisher commit | CC0; `web/vendor/assets/pose_studio_makehuman.v2.LICENSE.md` and CC0 text |
| Fisher skin texture | Same Fisher commit; source's modified mannequin texture | Retain upstream provenance notes in `web/vendor/README.md`; not claimed as original T8 art |
| Three.js + OrbitControls + TransformControls | r160 from the above vendored distribution | MIT, `web/vendor/THREE-LICENSE` |
| GLTFLoader + BufferGeometryUtils | `mrdoob/three.js` r160 | MIT; imports changed to relative `.mjs` paths |
| Tabler Icons | `tabler/tabler-icons` v3.31.0 | MIT, `web/icons/LICENSE` |
| GaussianSplats3D | `@mkkellogg/gaussian-splats-3d` 0.4.7, commit `eb2fc4593e3ea5e75388296fcdde2459542d1290` | MIT, `web/vendor/GaussianSplats3D-LICENSE.txt`; Three import changed to local module |
| TripoSplat inference | Native ComfyUI nodes; official `VAST-AI-Research/TripoSplat` commit `d8db9e018b413dd9c4a9fe22463781bf98e8e68d` | MIT; model weights explicitly installed from `VAST-AI/TripoSplat` revision `56a96e603204ec410c4da60c13ea4fa09a2169a9` |
| QI2.1 AnyAngle LoRA | `lilylilith/QI_2.1_AnyAngle` commit `e42ac7827e2cad7ce22dc099109ae29681239eba` | Refer to the original model repository; fetched only by explicit installation command, not bundled |
| DWPose ONNX body estimator and YOLOX detector weights | `yzd-v/DWPose` revision `1a7144101628d69ee7a3768d1ee3a094070dc388` | Apache-2.0 per the model repository; downloaded on the explicit “Extract pose from photo” action, never bundled |
| Depth Anything 3 Small weights | `Comfy-Org/Depth-Anything-3` revision `afd32929c589f43c2a6fda5246e7df2c01cce529` | Apache-2.0 per the model repository; downloaded on the explicit “Estimate depth from photo” action, never bundled |

Our `web/editor/scene.mjs` adapts the upstream morph-to-rig data mapping. The vendor core includes small local patches for resource disposal, character roots and landmark metadata. Clean capture, camera sign conventions, GLB import, scene persistence, editor UI and ComfyUI bridge are implemented separately. No upstream remote API, analytics or VNCCS inference protocol is used.

Multi-person design was researched against [GStaaaaa/ComfyUI-Gaoshang-Pose](https://github.com/GStaaaaa/ComfyUI-Gaoshang-Pose/tree/8f33ef271853780620b96d2af4afdc8a20ef4794), MIT, which retains Work-Fisher and GStaaaaa credits. Its active/passive-character approach uses the same VNCCS core already included here. Our scene schema, camera integration, identity manifest and UI are implemented locally. The upstream pose gallery and demonstration images are not redistributed.

Upstream source links:
- https://github.com/mkkellogg/GaussianSplats3D/tree/v0.4.7
- https://github.com/VAST-AI-Research/TripoSplat
- https://huggingface.co/VAST-AI/TripoSplat
- https://github.com/runjie-yan/TripoSplat-Training/blob/bc94db87dd4b748d1edac5d28231c1e152e46508/deg/utils/render_utils.py
- https://github.com/Work-Fisher/ComfyUI-Fisher-Pose/tree/d116451f25b1c9da36dd852fdc9df321068f4d98
- https://github.com/AHEKOT/ComfyUI_VNCCS_Utils/tree/70b752f2
- https://github.com/mrdoob/three.js/tree/r160
- https://github.com/tabler/tabler-icons/tree/v3.31.0
- https://huggingface.co/lilylilith/QI_2.1_AnyAngle/tree/e42ac7827e2cad7ce22dc099109ae29681239eba
- https://huggingface.co/yzd-v/DWPose/tree/1a7144101628d69ee7a3768d1ee3a094070dc388
- https://huggingface.co/Comfy-Org/Depth-Anything-3/tree/afd32929c589f43c2a6fda5246e7df2c01cce529/geometry_estimation
