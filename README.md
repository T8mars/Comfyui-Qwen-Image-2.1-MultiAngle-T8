<p align="center"><img src="web/icons/aperture.svg" width="48" alt="AnyAngle Studio"></p>
<h1 align="center">AnyAngle Studio · T8</h1>
<p align="center"><strong>从参考图重建三维主体，在 ComfyUI 里直观地寻找新机位。</strong></p>
<p align="center"><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>
<p align="center">ComfyUI 自定义节点 · Qwen Image 2.1 · 可关闭的 AnyAngle LoRA · TripoSplat · MIT</p>

![AnyAngle Studio 真实工作台：左侧参考图、中间三维机位、右侧粗图](docs/images/studio-photo.png)

<p align="center"><sub>真实工作台截图 · 原创示例图经本地 TripoSplat 重建 · 方位角 28° / 俯仰角 6°</sub></p>

**原模型：[lilylilith / QI_2.1_AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)** · [基础工作流](workflows/AnyAngle-Studio-Qwen21.json) · [进阶工作流](workflows/AnyAngle-Studio-Qwen21-Advanced.json) · [English README](README_EN.md)

## 效果与定位

| 原创参考图 · `image_1` | 新机位粗图 · `image_2` | AnyAngle 最终生成图 |
|:---:|:---:|:---:|
| <img src="docs/images/demo-reference.png" width="220" alt="用于演示的原创虚构人物参考图"> | <img src="docs/images/demo-guide.png" width="220" alt="节点实际导出的新机位粗图"> | <img src="docs/images/demo-final-qwen.png" width="220" alt="Qwen Image 2.1 AnyAngle 使用原图与粗图生成的最终图"> |

中图由本节点**实际导出**，用作 AnyAngle 的机位条件；右图是示例工作流使用原图、中图及 AnyAngle LoRA **实际生成**的结果（seed 42、20 步、CFG 3）。示例人物为原创生成的虚构角色。单图重建会推测未见过的侧面与背面，不能保证与原图完全一致。

- **参考图直接连线**：左侧 `reference_image` 接收 ComfyUI IMAGE，也支持在工作台上传。
- **原图对应主体**：本地 TripoSplat 重建后，拖动相机探索视角；调整机位时保持重建姿势。
- **真正可交互**：环绕、中键或 Shift+左键平移、滚轮缩放、精确角度、构图、机位收藏、撤销与重做。
- **三种场景来源**：原图重建、带材质 GLB、内置 MakeHuman 手动人偶。人偶资源随仓库安装，无需 Fisher 插件。
- **统一的引导策略**：右侧直接选择粗图、POSE、Depth 或 Canny；姿势、深度和轮廓都能从原图或当前画面直接生成，也保留导入与连线。关闭 AnyAngle 后，Qwen Image 2.1 底模使用所选结构图与对应提示词。
- **可复用输出**：`guide_image_2`、`prompt`、`scene_json`、`anyangle_lora_strength`；应用后可直接运行已保存的工作流。

原图重建的 TripoSplat 主体**没有可编辑骨架**，所以该模式只能调整相机；需要手动摆姿时请选择独立的人偶模式。

### 手动人偶工作台

![AnyAngle Studio 默认 MakeHuman 人偶、姿势库和关节编辑 UI](docs/images/studio-human.png)

内置人偶支持姿势预设、手势、体型和关节编辑；在右侧选择 **POSE 姿势 → 从原图提取姿势**，可将照片中的身体姿势应用到人偶，再继续手动调整。截图为独立预览页面；从节点打开时，右上角为“应用到节点”。

### 底模与结构图

在右侧“引导策略”选择 **Qwen 底模**，节点将 `anyangle_lora_strength` 输出为 **0**；切回 **AnyAngle LoRA** 时输出 **1**。新版基础和进阶工作流使用随节点提供的“AnyAngle 可选 LoRA”加载器，已把该输出接到 `strength_model`：强度为 0 时直接透传底模，无需安装 AnyAngle 权重。旧工作流需替换加载器并补上强度连线，或移除 LoRA 加载器；仅切换工作台按钮不会改写旧工作流中固定的强度。

| 底模引导图 | 来源及行为 |
|---|---|
| 三维粗渲染 | 当前机位的无网格渲染，适合已有 3D 主体。 |
| POSE 姿势 | 点击“从原图提取姿势”直接运行 DWPose，或导入 Fisher 兼容的黑底彩色骨架图；自动摆放内置人偶，可调整肢体前后深度并旋转相机，输出**当前机位**骨架图。 |
| Depth Anything 深度 | 点击“从原图估计深度”运行内置 Depth Anything 3 Small；也可将其他深度节点接到 `structure_image`，或上传深度 PNG。原图深度属于原机位，不会随相机旋转自动生成新视角深度。 |
| Canny 轮廓 | 点击“从当前画面生成 Canny”，从当前 3D 机位粗图提取边缘；没有 3D 时从原图提取。也可接入或上传现成 Canny 图。 |

`reference_image` 仍接原图并另接编码器 `image_1`；`guide_image_2` 接编码器 `image_2`。各引导方式会自动生成相应编辑提示词。DWPose 提取的是**二维关节位置**，遮挡处和肢体前后深度仍需在工作台检查。底模把结构图作为**图像参考**理解，没有独立的 ControlNet 控制端口；姿势、深度和轮廓的遵循程度取决于底模与提示词，不能保证像专用控制模型一样严格。导入图会按输出尺寸等比留黑边，不会被拉伸。

## 快速开始

1. 按下方说明安装节点与所需模型，重启 ComfyUI，导入 [基础工作流](workflows/AnyAngle-Studio-Qwen21.json)。
2. 把原图同时接入 Studio 的 `reference_image` 和编码器的 `image_1`。Studio 的 `guide_image_2` 接编码器 `image_2`，`prompt` 接 `prompt`，`anyangle_lora_strength` 接“AnyAngle 可选 LoRA”的 `strength_model`。结构图可接 `structure_image`。
3. 在 **Comfyui-Qwen-Image-2.1-MultiAngle-T8** 节点中打开 AnyAngle Studio，等待原图重建；拖动选角，检查右侧粗图，点击 **应用到节点**，再运行工作流。

![原图、可选结构图、Studio 与 Qwen Image 2.1 的接线示意](docs/images/wiring.svg)

Load Image 连线会自动读取；连接其他上游图像节点时，点击“读取上游图像”。批量输入使用第一张。原图重建模式的 **0°** 是模型预测的原图机位。网格、控制器和取景线不会进入粗图。

基础工作流的起始参数：**AnyAngle 模式 LoRA 1 · CFG 3 · 20 步 · euler / simple**。默认提示词为：

```text
Change the camera angle from <image2> to <image1>.
```

[进阶工作流](workflows/AnyAngle-Studio-Qwen21-Advanced.json)包含优化链、提示词拼接和三图拼接，采样设置为 **LoRA 1 · CFG 1 · 40 步**。它还依赖另外安装的 `QwenImage21SpectrumT8`、`QwenImage21SageAttentionT8`、`QwenImage21BlockCacheT8`、KJNodes、Easy Use 和 Comfyroll；缺少这些节点时请使用基础版。模板不含特定电脑的原图和快照，使用前选择原图并重新应用机位。

## 安装

需要包含 **Qwen Image 2.1、TripoSplat、BiRefNet、DINOv3 原生节点**的 ComfyUI；已验证版本为 **0.36.0**。浏览器需开启 WebGL 硬件加速。在 ComfyUI 目录运行：

```bash
cd custom_nodes
git clone https://github.com/T8mars/Comfyui-Qwen-Image-2.1-MultiAngle-T8.git ComfyUI-AnyAngle-Studio-T8
cd ComfyUI-AnyAngle-Studio-T8
python -m pip install -r requirements.txt
python install_assets.py --download-lora
python install_reconstruction.py
```

节点标题显示完整的 GitHub 仓库名。节点上方的黑色**来源标签**由 ComfyUI 根据安装目录生成；若直接用含 `2.1` 的仓库名作文件夹名，当前前端会在小数点处截断为 `Comfyui-Qwen-Image-2`。使用上面的无点目录名；旧安装可将节点文件夹重命名为 `ComfyUI-AnyAngle-Studio-T8`，重启 ComfyUI 后来源标签将显示 `AnyAngle-Studio-T8`。节点类型与工作流连线不变。

仓库已包含 MakeHuman 人偶资源及贴图。`install_assets.py --download-lora` 会校验资源并下载 AnyAngle LoRA；只用底模时可运行 `python install_assets.py`，无需下载 LoRA。`install_reconstruction.py` 下载约 **3.78 GB** 的重建权重；只用内置人偶或外部结构图时可跳过。DWPose 的两份 ONNX 权重在首次点击“从原图提取姿势”时下载到节点 `.local/dwpose/`（约 351 MB）；若已安装 `comfyui_controlnet_aux` 及相同权重，会直接复用。Depth Anything 3 Small 在首次点击“从原图估计深度”时下载约 **137 MB**，可复用已安装在 `models/geometry_estimation/` 的相同模型。请使用 **ComfyUI 的 Python 环境**；整合包用户将 `python` 换成内置 Python 路径。

| 模型 | 来源 / 安装位置 |
|---|---|
| AnyAngle LoRA | [原模型](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) · `models/loras/QI2.1_AnyAngle.safetensors` |
| TripoSplat 及配套权重 | [官方权重](https://huggingface.co/VAST-AI/TripoSplat) · 安装脚本放入对应模型目录 |
| DWPose 人体姿势 | [ONNX 权重](https://huggingface.co/yzd-v/DWPose) · 首次明确点击提取时下载；也可复用已有 `comfyui_controlnet_aux` 权重 |
| Depth Anything 3 Small | [ComfyUI 官方适配权重](https://huggingface.co/Comfy-Org/Depth-Anything-3) · 首次明确点击估计深度时下载，或复用 `models/geometry_estimation/` |
| Qwen Image 2.1 主模型 / Qwen3-VL 8B 编码器 / Qwen Image 2.1 VAE | 自行准备，分别放入 `models/diffusion_models`、`models/text_encoders`、`models/vae` |

示例工作流中的模型名需替换为本机已有的兼容权重。AnyAngle 和 TripoSplat 权重由安装命令下载；DWPose 与 Depth Anything 3 仅在点击对应功能时下载。姿势与深度推理、重建和渲染在本地完成。

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
