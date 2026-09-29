# Qwen Image 2.1 MultiAngle · T8

**简体中文** | [English](README_EN.md)

独立的 ComfyUI 可视化机位编辑节点。将参考图重建为三维主体，交互调整相机，为 Qwen Image 2.1 AnyAngle 输出新视角粗图。

**原模型：[lilylilith / QI_2.1_AnyAngle · Hugging Face](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)**

参考图 → TripoSplat 三维重建 → 交互调整机位 → 粗图 `image_2` → AnyAngle 生成

## 功能

- **直接接图**：左侧 `reference_image` 接收 IMAGE，也支持工作台上传。
- **原图重建**：本地 TripoSplat 生成对应主体；调整相机时保持重建姿势。
- **交互编辑**：环绕、平移、缩放、精确角度、机位收藏、撤销与重做。
- **场景扩展**：导入带材质的 GLB，或单独选择手动人偶摆姿。无需安装 Fisher 插件。
- **可复用输出**：干净的粗图、提示词与场景 JSON；应用后可运行已保存工作流。

## 安装

需要包含 **Qwen Image 2.1、TripoSplat、BiRefNet、DINOv3 原生节点**的 ComfyUI；已验证版本为 **0.36.0**。浏览器需开启 WebGL 硬件加速。

在 ComfyUI 目录中运行：

```bash
cd custom_nodes
git clone https://github.com/T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8.git ComfyUI-AnyAngle-Studio-T8
cd ComfyUI-AnyAngle-Studio-T8
python install_assets.py --download-lora
python install_reconstruction.py
```

仓库已包含编辑器必需的 MakeHuman 资源和皮肤贴图；`install_assets.py --download-lora` 会校验这些资源并下载 AnyAngle LoRA，`install_reconstruction.py` 下载约 **3.78 GB** 的重建权重。请使用 **ComfyUI 环境的 Python**；整合包用户将 `python` 替换为内置 Python 路径。重启后搜索 **AnyAngle Studio · T8**。

若旧版安装打开工作台时显示 `MakeHuman asset: HTTP 404`，在节点目录执行 `git pull`，确认 `web/vendor/assets/pose_studio_makehuman.v2.bin` 和 `web/vendor/textures/skin.png` 存在，再强制刷新浏览器。若文件仍缺失，运行 `python install_assets.py` 补齐。

| 模型 | 来源 / 位置 |
|---|---|
| AnyAngle LoRA | [原模型](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) · `models/loras/QI2.1_AnyAngle.safetensors` |
| TripoSplat 及配套重建权重 | [官方权重](https://huggingface.co/VAST-AI/TripoSplat) · 脚本自动安装到对应目录 |
| Qwen Image 2.1 主模型 / Qwen3-VL 8B 编码器 / Qwen Image 2.1 VAE | 自行准备，分别放入 `models/diffusion_models`、`models/text_encoders`、`models/vae` |

示例中的模型名需替换为本机已有的兼容权重。模型仅通过安装命令显式下载，工作台重建和渲染在本地运行。

## 使用与接线

导入 [示例工作流](workflows/AnyAngle-Studio-Qwen21.json)，选择原图和本机模型。

| 连线 | 目标 |
|---|---|
| 原图 IMAGE | Studio 的 `reference_image`，同时连接编码器 `image_1` |
| Studio 的 `guide_image_2` | 编码器 `image_2` |
| Studio 的 `prompt` | 编码器 `prompt` |
| Studio 的 `scene_json` | 可选的场景记录 |

1. 打开 **AnyAngle Studio**。Load Image 连线自动读取；其他上游节点点击“读取上游图像”。批量输入使用第一张。
2. 等待重建，拖动调整机位；**Shift + 拖动**平移，**滚轮**缩放。重建场景的 **0°** 是模型预测的原图机位。
3. 检查粗图，点击 **应用到节点**，再运行工作流。网格、取景框和控制器不会进入输出。

推荐起始参数：**LoRA 1 · CFG 3 · 20 步 · euler / simple**。默认提示词遵循原作者接线，原图与粗图分别输入 `image_1`、`image_2`：

```text
Change the camera angle from <image2> to <image1>.
```

## 保存与限制

- 场景、粗图和资产保存在 `ComfyUI/input/anyangle_studio/`。迁移工作流时需同时复制相关资产；[API 工作流](workflows/AnyAngle-Studio-Qwen21-API.json) 需填入已应用的快照。
- 单图重建不能精确恢复背面、遮挡、画外身体或完整背景。手动人偶是独立摆姿模式，不代表原图重建。
- GLB 需内嵌纹理，不支持 Draco / Meshopt / KTX2 压缩。粗图尺寸与下游生成分辨率分别设置。
- 已在 RTX 5090 Laptop 24 GB 上验证；其他硬件需根据本机模型和分辨率调整。

## 致谢与许可

感谢 [AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)、[TripoSplat](https://github.com/VAST-AI-Research/TripoSplat)、[Fisher Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose)、[VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils) 与 [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D)。本项目为独立集成，并非原模型官方插件。

项目代码采用 [MIT](LICENSE) 许可；第三方代码、资产与模型遵循各自许可，详见 [来源说明](THIRD_PARTY.md)。

## T8 链接

[B站](https://space.bilibili.com/385085361) · [YouTube](https://www.youtube.com/@T8star-Aix/) · [Hugging Face](https://huggingface.co/t8star)

[API 服务](https://api.seedance.nz/sign-up?aff=5f4w) · [免费画廊](https://www.openzhenzhen.com) · [在线 AI 应用](https://www.runninghub.ai/zh-cn/user-center/1907375370302308353/userPost?inviteCode=rh-v1121) · [ComfyUI 整合包](https://pan.quark.cn/s/264edb7e36bd)
