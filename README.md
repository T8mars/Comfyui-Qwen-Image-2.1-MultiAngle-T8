<p align="center"><img src="web/icons/aperture.svg" width="48" alt="AnyAngle Studio"></p>
<h1 align="center">AnyAngle Studio · T8</h1>
<p align="center"><strong>从参考图重建三维主体，在 ComfyUI 里直观地寻找新机位。</strong></p>
<p align="center"><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>
<p align="center">ComfyUI 自定义节点 · Qwen Image 2.1 AnyAngle · TripoSplat · MIT</p>

![AnyAngle Studio 真实工作台：左侧参考图、中间三维机位、右侧粗图](docs/images/studio-photo.png)

<p align="center"><sub>真实工作台截图 · 原创示例图经本地 TripoSplat 重建 · 方位角 28° / 俯仰角 6°</sub></p>

**原模型：[lilylilith / QI_2.1_AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)** · [下载示例工作流](workflows/AnyAngle-Studio-Qwen21.json) · [English README](README_EN.md)

## 效果与定位

| 原创参考图 · `image_1` | 新机位粗图 · `image_2` | AnyAngle 最终生成图 |
|:---:|:---:|:---:|
| <img src="docs/images/demo-reference.png" width="220" alt="用于演示的原创虚构人物参考图"> | <img src="docs/images/demo-guide.png" width="220" alt="节点实际导出的新机位粗图"> | <img src="docs/images/demo-final-qwen.png" width="220" alt="Qwen Image 2.1 AnyAngle 使用原图与粗图生成的最终图"> |

中图由本节点**实际导出**，用作 AnyAngle 的机位条件；右图是示例工作流使用原图、中图及 AnyAngle LoRA **实际生成**的结果（seed 42、20 步、CFG 3）。示例人物为原创生成的虚构角色。单图重建会推测未见过的侧面与背面，不能保证与原图完全一致。

- **参考图直接连线**：左侧 `reference_image` 接收 ComfyUI IMAGE，也支持在工作台上传。
- **原图对应主体**：本地 TripoSplat 重建后，拖动相机探索视角；调整机位时保持重建姿势。
- **真正可交互**：环绕、Shift 平移、滚轮缩放、精确角度、构图、机位收藏、撤销与重做。
- **三种场景来源**：原图重建、带材质 GLB、内置 MakeHuman 手动人偶。人偶资源随仓库安装，无需 Fisher 插件。
- **可复用输出**：粗图 `guide_image_2`、`prompt`、`scene_json`；应用后可直接运行已保存的工作流。

原图重建的 TripoSplat 主体**没有可编辑骨架**，所以该模式只能调整相机；需要手动摆姿时请选择独立的人偶模式。

### 手动人偶工作台

![AnyAngle Studio 默认 MakeHuman 人偶、姿势库和关节编辑 UI](docs/images/studio-human.png)

内置人偶支持姿势预设、手势、体型和关节编辑；它是独立的手动摆姿模式，不会自动复制参考图动作。截图为独立预览页面；从节点打开时，右上角为“应用到节点”。

## 快速开始

1. 按下方说明安装节点与所需模型，重启 ComfyUI，导入 [示例工作流](workflows/AnyAngle-Studio-Qwen21.json)。
2. 把原图同时接入 Studio 的 `reference_image` 和编码器的 `image_1`。Studio 的 `guide_image_2` 接编码器 `image_2`，`prompt` 接 `prompt`。
3. 打开 **AnyAngle Studio · T8**，等待原图重建；拖动选角，检查右侧粗图，点击 **应用到节点**，再运行工作流。

![原图、Studio 与 Qwen Image 2.1 AnyAngle 的接线示意](docs/images/wiring.svg)

Load Image 连线会自动读取；连接其他上游图像节点时，点击“读取上游图像”。批量输入使用第一张。原图重建模式的 **0°** 是模型预测的原图机位。网格、控制器和取景线不会进入粗图。

推荐起始参数：**LoRA 1 · CFG 3 · 20 步 · euler / simple**。示例工作流的默认提示词为：

```text
Change the camera angle from <image2> to <image1>.
```

## 安装

需要包含 **Qwen Image 2.1、TripoSplat、BiRefNet、DINOv3 原生节点**的 ComfyUI；已验证版本为 **0.36.0**。浏览器需开启 WebGL 硬件加速。在 ComfyUI 目录运行：

```bash
cd custom_nodes
git clone https://github.com/T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8.git ComfyUI-AnyAngle-Studio-T8
cd ComfyUI-AnyAngle-Studio-T8
python install_assets.py --download-lora
python install_reconstruction.py
```

仓库已包含 MakeHuman 人偶资源及贴图。`install_assets.py --download-lora` 会校验资源并下载 AnyAngle LoRA；`install_reconstruction.py` 下载约 **3.78 GB** 的重建权重。请使用 **ComfyUI 的 Python 环境**；整合包用户将 `python` 换成内置 Python 路径。

| 模型 | 来源 / 安装位置 |
|---|---|
| AnyAngle LoRA | [原模型](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) · `models/loras/QI2.1_AnyAngle.safetensors` |
| TripoSplat 及配套权重 | [官方权重](https://huggingface.co/VAST-AI/TripoSplat) · 安装脚本放入对应模型目录 |
| Qwen Image 2.1 主模型 / Qwen3-VL 8B 编码器 / Qwen Image 2.1 VAE | 自行准备，分别放入 `models/diffusion_models`、`models/text_encoders`、`models/vae` |

示例工作流中的模型名需替换为本机已有的兼容权重。模型仅在运行安装命令时显式下载；工作台重建和渲染在本地完成。

若旧版安装提示 `MakeHuman asset: HTTP 404`，在节点目录执行 `git pull`，确认 `web/vendor/assets/pose_studio_makehuman.v2.bin` 与 `web/vendor/textures/skin.png` 存在，重启 ComfyUI 并强制刷新浏览器。文件缺失时运行 `python install_assets.py` 补齐。

## 保存、迁移与限制

- 场景、粗图和资产保存在 `ComfyUI/input/anyangle_studio/`。迁移工作流时需一同复制相关资产；[API 工作流](workflows/AnyAngle-Studio-Qwen21-API.json) 需填入已应用的快照。
- GLB 需内嵌纹理；不支持 Draco、Meshopt、KTX2 压缩。GLB 正面校准只用于导入的 GLB，原图重建模式请使用相机角度与构图控制。
- 单图重建无法精确恢复遮挡、画外身体或完整背景。粗图尺寸与下游生成分辨率分别设置。
- 已在 RTX 5090 Laptop 24 GB 上验证；其他硬件需按本机模型及分辨率调整。

## 致谢与许可

感谢 [AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)、[TripoSplat](https://github.com/VAST-AI-Research/TripoSplat)、[Fisher Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose)、[VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils) 与 [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D)。本项目为独立集成，并非原模型官方插件。

项目代码采用 [MIT](LICENSE) 许可；第三方代码、资产与模型遵循各自许可，详见 [来源说明](THIRD_PARTY.md)。

## T8 链接

[B站](https://space.bilibili.com/385085361) · [YouTube](https://www.youtube.com/@T8star-Aix/) · [Hugging Face](https://huggingface.co/t8star)

[API 服务](https://api.seedance.nz/sign-up?aff=5f4w) · [免费画廊](https://www.openzhenzhen.com) · [在线 AI 应用](https://www.runninghub.ai/zh-cn/user-center/1907375370302308353/userPost?inviteCode=rh-v1121) · [ComfyUI 整合包](https://pan.quark.cn/s/264edb7e36bd)
