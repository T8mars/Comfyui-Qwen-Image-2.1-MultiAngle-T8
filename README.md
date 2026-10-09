<p align="center"><img src="web/icons/aperture.svg" width="48" alt="AnyAngle Studio"></p>
<h1 align="center">AnyAngle Studio · T8</h1>
<p align="center"><strong>多人同场编排、多用途参考素材、三维相机与结构引导。</strong></p>
<p align="center"><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>
<p align="center">ComfyUI 自定义节点 · Qwen Image 2.1 · 可关闭的 AnyAngle LoRA · TripoSplat · MIT</p>

![v1.6.0 实际多人工作台与通用参考素材](docs/images/studio-reference-guided-v160.png)

<p align="center"><sub>v1.6.0 · 实际工作台截图 · 内置人偶，无需另装 Fisher</sub></p>

**原模型：[lilylilith / QI_2.1_AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)** · [基础工作流](workflows/AnyAngle-Studio-Qwen21.json) · [进阶工作流](workflows/AnyAngle-Studio-Qwen21-Advanced.json) · [English README](README_EN.md)

## 多图创作 · 1.6.0

参考图可以是**身份、服装、配饰 / 产品、场景、风格、布局**，也可以自由参考。左侧分为「参考素材」和「场景对象」：一张素材可有多个用途、用于多个人物或道具；相同图片只编码一次。右侧发送清单显示实际图号和未发送原因，切换粗图、POSE、Depth、Canny 时保留素材。

| 工作流 | 用途 |
|---|---|
| [构图引导 + 多图参考](workflows/AnyAngle-Studio-Qwen21-MultiReference.json) | 摆放人物 / 道具，叠加任意用途的素材 |
| [仅参考创作](workflows/AnyAngle-Studio-Qwen21-ReferencesOnly.json) | 无需人偶或 GLB；不发送灰色占位图；首张参考决定画幅 |
| [Viggle Turbo · 6 步](workflows/AnyAngle-Studio-Qwen21-ViggleTurbo6.json) | 使用作者专用节点的加速路线，默认 Qwen 底模 |

**提示词可独立编辑。** 默认工作流显式连接 `Studio.prompt → 多图编码.prompt`，设置 `input-full`。断开此线后手写，或替换为文本 / 拼接节点；`negative_prompt` 单独填写。`studio-plus-input` 用于在 Studio 自动提示词后追加描述，请勿同时接入完整 Studio 文本。全文模式保留输入原文，包括空串，不隐式追加素材用途。

`reference_image` 是重建 / 提取的**场景来源图**，加入素材库后才参与新版多图参考；`actor_reference_N` 是**通用参考输入**，不限人物。`structure_image` 接已处理的骨架 / 深度 / 轮廓图，`pose_keypoints` 接原生姿势关键点。每个 IMAGE 批次默认取首张，可显式拆分；支持真实裁切、参考组合模板、仅参考和纯文本创作。

![仅参考创作的实际工作台](docs/images/studio-reference-only-v160.png)

| 原生 Qwen · 20 步 | Viggle Turbo · 6 步 |
|:---:|:---:|
| <img src="docs/images/references-native-v160.png" width="340" alt="三张参考的原生 Qwen 实际生成结果"> | <img src="docs/images/references-turbo-v160.png" width="340" alt="相同参考与 seed 的 Turbo 实际生成结果"> |

上面两图均由本机 ComfyUI 实际生成，使用相同三张素材与 seed 42。用途和目标是提示词描述，不是硬遮罩或独立参考权重；衣饰细节、身份近似及复杂布局仍可能偏离。[操作与模型来源](docs/reference-library.md) · [执行与效果验收](docs/reference-library-validation.md)。

Turbo 需额外安装作者的 [Viggle 专用节点与模型](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/tree/main/comfyui)，使用 `ViggleTurboLora`、`ViggleTurboSigmas`、Euler、BasicGuider。此路线不使用负向 CFG，编码器的 negative 输出未接入采样；不要用普通 LoRA 加载器或 KSampler 的 6 步替代。普通多图功能无需新增推理权重。

旧场景 v1 / v2 按原规则打开，点击「升级为多用途参考」才启用新素材库。新版便携 ZIP 包含停用素材，要求插件 1.6.0 或更新版本。仅参考首图独立处理尺寸，其余素材采用编码器参考预算，实际输出尺寸显示在 latent 端口。

## 20组教学实测 · 16:9

每组都结合多用途参考与双人或三人，覆盖人偶、POSE、Depth、Canny、真实高斯和仅参考创作。全部由本地 ComfyUI Turbo 6步生成，展示原图、实际引导、最终成图及素材用途。

![20组多用途参考与多人实际成图](docs/images/teaching-v160/overview.jpg)

[查看20组介绍图与实测说明](docs/teaching-gallery.md) · [图号、提示词与执行记录 / Records](docs/teaching-gallery-validation.json)。

## 多人工作台

**[多人工作流](workflows/AnyAngle-Studio-Qwen21-MultiPerson.json)** · **[含人物参考的三人场景 ZIP](examples/multi-person-photo-pose.zip)** · [实测结果与限制](docs/multi-person-validation.md)

下列中图是本节点实际输出，右图由原生 Qwen Image 2.1 工作流实际生成。参考人物均为原创 AI 虚构人物，示例使用 seed 42、20 步、CFG 3、euler/simple、AnyAngle 强度 0。

| 身份参考 | 三维机位 POSE · `image_1` | Qwen 最终图 |
|:---:|:---:|:---:|
| <img src="docs/images/multi-identity-reference.png" width="220" alt="共享的双人身份参考"> | <img src="docs/images/multi-two-pose-guide.png" width="220" alt="实际双人机位骨架"> | <img src="docs/images/multi-two-pose-final.png" width="220" alt="实际双人姿势生成结果"> |
| <img src="docs/images/multi-identity-reference.png" width="110" alt="共享双人参考"><img src="docs/images/demo-reference.png" width="110" alt="第三位人物身份参考"> | <img src="docs/images/multi-three-pose-guide.png" width="220" alt="实际三人机位骨架"> | <img src="docs/images/multi-three-pose-final.png" width="220" alt="实际三人姿势生成结果"> |

| 身份参考 | 三维机位 Canny · `image_1` | Qwen 最终图 · 构图有偏差 |
|:---:|:---:|:---:|
| <img src="docs/images/multi-identity-reference.png" width="110" alt="共享双人参考"><img src="docs/images/demo-reference.png" width="110" alt="第三位人物参考"> | <img src="docs/images/multi-three-canny-fixed-guide.png" width="220" alt="实际三人 Canny 轮廓"> | <img src="docs/images/multi-three-canny-fixed-final.png" width="220" alt="实际 Canny 生成结果，后方人物位置和动作未完全遵循"> |

Canny 示例保留三个人、衣装顺序和蓝衣人物举臂，但没有准确保留后方人物的动作与遮挡。右图保留实际结果，未修饰这些偏差。

双人共用一张合影，三人案例再增加一张独立照片。衣装、左右对应和举臂在上述两组 POSE 示例中生效；脸部、发型与人物比例仍可能漂移，**不是精确身份锁定或逐像素姿势控制**。下载 ZIP，在左侧「全场模板与便携场景 → 导入场景 ZIP」恢复人物、参考与机位，应用后运行多人工作流。

同一场景还可输出以下结构图；这些图片本身不是最终生成结果。

| 全场粗图 · 可选角色色 | 标准 POSE | 同机位三维深度 |
|:---:|:---:|:---:|
| <img src="docs/images/multi-coarse.png" width="250" alt="双人三维粗图"> | <img src="docs/images/multi-pose.png" width="250" alt="双人标准骨架"> | <img src="docs/images/multi-depth.png" width="250" alt="双人共用深度范围"> |

- **同场独立人物**：添加、复制、任意删除、排序、显示与锁定；点选人物编辑，Ctrl 点击多选。每人独立体型、动作、位置、尺度、朝向与身份绑定，切人保持镜头。复制默认清空身份照片。
- **合影 → 多人姿势**：DWPose 提取所有候选并去重，在选人窗口确认后复制到当前人或新建多人。支持多人 Fisher 骨架 PNG、标准 OpenPose JSON 和原生 `POSE_KEYPOINT` 连线。复制动作与匹配原图站位分开；半身、遮挡和低置信度会提示，PNG 近似补全点不参与动作复制。保存、导入和深度翻转只作用当前人物。
- **全场统一输出**：粗图、标准 POSE、三维机位 Canny 与三维场景深度共用拍摄相机。三维 Depth 支持近白/远白；POSE 可输出真实手指、已知眼鼻点，或过滤被人物与可见道具挡住的关节。原图 DA3 深度仍是静态机位。
- **身份与提示词同步**：使用 Qwen 底模和「分别绑定人物身份」，为每人上传照片、选择 `actor_reference_1…` 连线或填写文字。合影可共享同一照片；选人区域与描述一同写入提示词，修改描述仍保留所选区域。多人编码节点从已保存清单加载照片，调用原生 Qwen 编码器，自动同步图片顺序与提示词。
- **编排与复用**：按种子随机当前、选中或全部未锁定人物；全场模板保存人物动作、站位、道具与相机，排序后仍保留角色身份。支持落地、合影/对话/握手编排及带资源的场景 ZIP。握手为一次 IK 近似对齐，可再次对齐或手动微调，不提供持续约束或碰撞仿真。批量机位冻结全场人物与照片。
- **机位独立保存**：收藏与批量机位包含拍摄中心；应用其他场景模板后，也可恢复原构图，人物动作保持当前状态。

**1.5.7 修复：**Canny 零阈值不再将纯色区域误判为白色边缘；单击 IK 手部或骨骼旋转环但没有拖动时，保留此前的重做记录。[本轮 20 项联合实测](docs/audit-1.5.7.md) · [1.5.6 检查记录](docs/audit-1.5.6.md)。

支持像素坐标及原版预处理器的 `[0,1]` 归一化 OpenPose JSON，身体、手和脸分别识别转换。文件未带画布尺寸时，优先使用左侧原图尺寸，否则使用当前输出尺寸，导入后会提示核对。请让画布与坐标对应；`[-1,1]` 坐标需先转换为像素。[官方输出格式](https://github.com/CMU-Perceptual-Computing-Lab/openpose/blob/master/doc/02_output.md#json-output-format)。

**使用：**导入多人工作流 → 在 Studio 添加人物 → 分别绑定照片或写外观 → 选择粗图/POSE/三维 Depth/Canny → 调整人物与镜头 → 应用到节点 → 运行。`guide_image_2` 和 `scene_json` 接「AnyAngle 多人编码」，人物照片不用再手工接编码器。仅引导图模式会忽略身份照片；自定义模式保留原文。Alt+左右键切人，Delete 删除当前人，文本输入时不触发这些快捷键。

从原图提取或导入的 POSE / Depth / Canny 使用该图片的构图，不套用工作台里保留的三维人物数量。默认使用共享原图；没有共享原图时使用单张结构图与附加描述。切回三维引导后恢复人物绑定。自定义模式可使用人物照片清单，左侧原图需先绑定人物；图片编号由用户维护。

多人摆姿推荐关闭 AnyAngle LoRA；原来的双图换机位工作流继续保留。**[Qwen 官方参考预算为 10 张](https://huggingface.co/Qwen/Qwen-Image-2.1)**（含引导图），并非保证 9 人身份与人数都准确。原生编码器的图像入口数量不代表官方质量保证；每个 IMAGE 入口取 batch 首张。推荐引导图先入，首张参考决定生成画幅；实际编码尺寸显示在多人编码节点的 latent 输出旁。人物照片默认按 512 像素面积预算缩放，可设 0 保留原尺寸。

多人功能复用内置人偶与现有 DWPose，不新增权重；三维场景深度无需 DA3。原 GLB / TripoSplat 仍为单资产路线；GLB 道具可以加入多人偶场景，重建资产不能直接当作可编辑骨架。参考了 [Gaoshang Pose](https://github.com/GStaaaaa/ComfyUI-Gaoshang-Pose) 的多人组织方式，未打包其图库。

**实测边界：**32 张多人主矩阵全部执行成功，但综合人数、关键动作和遮挡，仅 7 张基本符合、2 张部分符合；九人场景会增加人物或丢失动作。结构图作为底模图像参考使用，推荐先用少人数、清晰站位和 POSE 验证；复杂遮挡与多人身份需要逐张检查。[完整矩阵、照片案例及性能测量](docs/multi-person-validation.md)。

**三维 Canny：**人偶和 GLB 使用同机位的高对比灰模提取几何轮廓，避免角色色与灰背景对比不足导致全黑；不包含纹理细节。TripoSplat 保留其颜色渲染，原图 Canny 使用原图像素。未检测到边缘时提示降低阈值或调整画幅，仍允许输出用户需要的空白图。

## 效果与定位

| 原创参考图 · `image_1` | 新机位粗图 · `image_2` | AnyAngle 最终生成图 |
|:---:|:---:|:---:|
| <img src="docs/images/demo-reference.png" width="220" alt="用于演示的原创虚构人物参考图"> | <img src="docs/images/demo-guide.png" width="220" alt="节点实际导出的新机位粗图"> | <img src="docs/images/demo-final-qwen.png" width="220" alt="Qwen Image 2.1 AnyAngle 使用原图与粗图生成的最终图"> |

中图由本节点**实际导出**，用作 AnyAngle 的机位条件；右图是示例工作流使用原图、中图及 AnyAngle LoRA **实际生成**的结果（seed 42、20 步、CFG 3）。示例人物为原创生成的虚构角色。单图重建会推测未见过的侧面与背面，不能保证与原图完全一致。

- **参考图直接连线**：左侧 `reference_image` 接收 ComfyUI IMAGE，也支持在工作台上传。
- **原图对应主体**：本地 TripoSplat 重建后，拖动相机探索视角；调整机位时保持重建姿势。
- **真正可交互**：环绕、中键或 Shift+左键平移、滚轮缩放、精确角度、构图、机位收藏、撤销与重做。
- **三种场景来源**：原图重建、带材质 GLB、内置 MakeHuman 手动人偶。人偶资源随仓库安装，无需 Fisher 插件。
- **统一的引导策略**：右侧选择粗图、POSE、Depth 或 Canny。DWPose 与 DA3 直接提取原图，Canny 可选原图或三维机位；也支持导入与连线。关闭 AnyAngle 后，底模使用所选结构图与对应提示词。
- **可复用输出**：`guide_image_2`、`prompt`、`scene_json`、`anyangle_lora_strength`；应用后可直接运行已保存的工作流。

原图重建的 TripoSplat 主体**没有可编辑骨架**，所以该模式只能调整相机；需要手动摆姿时请选择独立的人偶模式。

### 三维相机工作台

![AnyAngle Studio 三维工作台：参考图、交互相机与实际粗图](docs/images/studio-photo.png)

拍摄模式拖动环绕，中键或 Shift+左键沿画面方向平移，滚轮缩放。编辑和人物站位模式右键环绕、中键平移，拍摄机位保持不变；Escape 取消当前拖动并保留历史。重建完成后保持三维交互；点击“预览当前机位粗图”查看无网格的输出。截图展示三维场景模式，四种引导方式统一在右侧选择。

**保留背景参与重建（1.2.0，实验）：**在左侧原图下方勾选，再点击「保留背景重建 3D」。整张图像进入 TripoSplat，不执行 BiRefNet 去背景；取消勾选后恢复主体模式。两种结果分别缓存，选项随场景保存，切换后需重新重建。可继续旋转相机、导出粗图或批量机位；Qwen 底模的粗图提示词会改为重建前景与背景，AnyAngle 保留官方提示词。

此模式不需要 BiRefNet，也不需要新增模型。**TripoSplat 主要面向物体生成，保留背景不等于精确恢复整个房间或 360° 环境**：墙面、地板和遮挡区域仍由模型推测，大角度可能变形或缺失。[官方预处理](https://github.com/VAST-AI-Research/TripoSplat/blob/main/triposplat.py) 默认会分割主体；此选项是本节点提供的实验模式。

| 输入原图 | 保留背景后的真实三维结果 |
|:---:|:---:|
| <img src="docs/images/demo-reference.png" width="240" alt="原创虚构人物与影棚背景"> | <img src="docs/images/demo-scene-background.png" width="240" alt="TripoSplat 保留背景，人物、墙面和地板参与三维重建"> |

实测使用同一张原创示例图，TripoSplat 重建 262,144 个高斯点，再由 ComfyUI 原生 Render Splat 从新视角渲染；背景是三维结果的一部分。

### 手动人偶工作台

![AnyAngle Studio 默认 MakeHuman 人偶、姿势库和关节编辑 UI](docs/images/studio-human.png)

内置人偶支持姿势预设、手势、体型和关节编辑。**POSE → 从原图提取姿势**默认直接输出照片骨架；可再点击“用三维人偶调整姿势”，或在左侧直接点击“从原图复制姿势到人偶”。截图为独立预览页面；从节点打开时，右上角为“应用到节点”。

修改动作请选择 **Qwen 底模 + POSE 姿势**，并连接 LoRA 强度输出。选择预设或编辑关节后，输出会使用当前人偶骨架；切换引导、保存重开也会保留选择。“使用原图骨架”可恢复照片的可见姿势。半身照片的 DWPose 结果只包含可见关节，不会自动补出画外身体；AnyAngle LoRA 主要用于改变机位。

### 镜头透视与姿势复制 · 1.4.0

![焦距与空间透视示意](docs/images/lens-perspective.svg)

- **镜头透视**：右侧选择「自定义焦距」，调节 12–200 mm，或使用 24 / 50 / 85 mm 预设。相机距离随焦距联动，保持目标平面大小；前后景的比例会变化。支持人偶、GLB 和 TripoSplat，预览、导出、收藏及批量机位使用同一镜头。默认「原始镜头」保持旧工作流。
- **照片 → 人偶**：左侧「从原图复制姿势到人偶」一次完成 DWPose 提取与复制，自动使用 Qwen 底模 + POSE。默认「保守平面」按可见肢体方向和人偶骨长求解；半身照片保留画外肢体的当前姿势。全身照片可改用「推测立体」，再检查肢体前后翻转。二维照片不提供准确深度，复杂遮挡仍需调整；追求原构图时使用原图骨架输出。
- **随机姿势**：人偶姿势库选择混合、站姿、动作或坐姿，点击「随机姿势」。按种子可重现结果，支持撤销、手动编辑和保存；随机动作不保证无穿模或完全自然。
- **资源恢复**：人偶或贴图加载超时会停止等待；错误窗口提供「重试加载」和「修复人偶资源」。修复只在点击后校验并补齐内置人偶及贴图，不会下载 LoRA 或推理权重；也可在节点目录运行 `python install_assets.py`。

焦距按 24 mm 垂直画幅计算，目标平面之外的主体大小可能随透视变化。本次无需新增模型；首次使用照片复制仍需已有的 DWPose 权重。

### 底模与结构图

![同一张原创参考实际提取的 DWPose 骨架、Depth Anything 3 深度和 Canny 轮廓](docs/images/structure-guides.png)

在右侧“引导策略”选择 **Qwen 底模**，节点将 `anyangle_lora_strength` 输出为 **0**；切回 **AnyAngle LoRA** 时输出 **1**。新版基础和进阶工作流使用随节点提供的“AnyAngle 可选 LoRA”加载器，已把该输出接到 `strength_model`：强度为 0 时直接透传底模，无需安装 AnyAngle 权重。旧工作流需替换加载器并补上强度连线，或移除 LoRA 加载器；仅切换工作台按钮不会改写旧工作流中固定的强度。

| 底模引导图 | 来源及行为 |
|---|---|
| 三维粗渲染 | 点击“从原图重建 3D”运行 TripoSplat，再预览当前机位的无网格粗图；已有 GLB 或人偶可直接渲染。 |
| POSE 姿势 | DWPose 直接输出原图可见身体、手部和面部骨架，保留原构图；也可导入 Fisher 兼容骨架图。可见关节可复制到三维人偶编辑，输出调整后的机位骨架。 |
| Depth Anything 深度 | 点击“从原图估计深度”运行内置 Depth Anything 3 Small；也可将其他深度节点接到 `structure_image`，或上传深度 PNG。原图深度属于原机位，不会随相机旋转自动生成新视角深度。 |
| Canny 轮廓 | 默认从原图提取边缘；也可明确选择“从三维机位生成 Canny”，或接入、导入现成轮廓图。 |

**原图提取用法**：连接 `reference_image` → 选择 **Qwen 底模** → 选择 **POSE / Depth / Canny** → 点击该模式的原图提取按钮 → 检查中央引导图 → **应用到节点**。导出 PNG、输出尺寸和对应提示词均使用当前选中的引导图。

查看原始示例输出：[POSE](docs/images/demo-pose.png) · [Depth](docs/images/demo-depth.png) · [Canny](docs/images/demo-canny.png)。这些是结构条件图，底模的最终生成效果还取决于提示词和采样设置。

重建完成后默认进入可旋转的“3D 工作台”。点击“预览当前机位粗图”查看实际 `image_2` 输出，也可切回工作台继续调整。原图骨架和深度图直接显示在中央“引导图预览”，保留原机位；半身照片不会自动变成人偶的完整姿势。

`reference_image` 仍接原图并另接编码器 `image_1`；`guide_image_2` 接编码器 `image_2`。各引导方式会自动生成相应编辑提示词。DWPose 提取的是**二维关节位置**，遮挡处和肢体前后深度仍需在工作台检查。底模把结构图作为**图像参考**理解，没有独立的 ControlNet 控制端口；姿势、深度和轮廓的遵循程度取决于底模与提示词，不能保证像专用控制模型一样严格。导入图会按输出尺寸等比留黑边，不会被拉伸。

### 提示词与单图工作流 · 1.3.0

![双图与单引导图的接线示意](docs/images/prompt-modes.svg)

右侧「接线与提示词」提供三种模式，设置与提示词会随场景保存：

| 模式 | 接线与用途 |
|---|---|
| 双图模板（默认） | 保留现有 AnyAngle / 底模模板；可选「原图 1 / 引导图 2」或反向顺序，提示词图片编号同步变化。按所选顺序连接编码器。 |
| 仅引导图 | 自动使用 Qwen 底模、LoRA 强度 0；引导图接 `image_1`，无需原图。在附加描述中写人物、场景与风格。支持三维粗图、POSE、Depth 和 Canny。 |
| 自定义 | 原文输出，保留图片标签、空格与换行；可留空，在工作流中另行拼接。 |

[单引导图工作流](workflows/AnyAngle-Studio-Qwen21-SingleGuide.json)已接好引导图与 LoRA 强度，使用前在工作台选择「仅引导图」、准备人偶 / GLB / 结构图并应用到节点。输出端口 `guide_image_2` 保留兼容名称，在这个模板中接编码器 `image_1`。单图模式无需 AnyAngle 权重；Qwen 的生成画幅由编码器收到的第一张图决定。

### 机位收藏与性能 · 1.3.0

「收藏当前机位」支持在编辑场景时采纳当前视角；点击缩略图切回拍摄相机，恢复方位、俯仰、缩放、平移和尺寸。收藏作为草稿，点击「应用到节点」后保存，取消工作台则放弃本次修改。右侧可关闭「允许鼠标调整俯仰」，仅水平旋转；俯仰滑条仍可设置。

高斯工作台改为按需重绘，静止时停止持续刷新，排序完成后更新画面。卡顿时在「工作台性能」选择「流畅」，关闭「自动更新引导预览」，按需点击「刷新引导图预览」。预览质量只限制显示像素，导出仍按设置尺寸执行。首次模型加载、三维重建和高斯排序可能短时占用 CPU；若静止时仍持续很高，请提供浏览器、GPU、硬件加速状态与发生阶段。本次改动无需新增模型。

### 批量机位与出图 · 1.1.0

![批量机位：选择角度、逐张渲染引导图、提交 Qwen 队列并保存结果](docs/images/batch-flow.svg)

在三维工作台下方点击 **批量机位**，选择「角度步进」或「已收藏机位」。例如 `0° → 330° / 30°` 生成 12 个机位；`0° → 360° / 1°` 生成 360 个机位，自动去掉重复的 360° 端点。角度步进保持当前姿势、俯仰角与构图，收藏模式使用各机位的相机与尺寸。

- **批量渲染粗图：**逐机位保存独立引导图，可下载 PNG ZIP 和任务清单，无需运行 Qwen。
- **批量生成最终图：**从节点打开工作台后可用。按批量开始时的工作流、种子和采样设置逐张提交 ComfyUI 队列；请连接 **Save Image**，结果保存到 `ComfyUI/output/`。每张 PNG 的工作流记录对应机位，不会覆盖当前编辑中的节点快照。
- **停止后续机位：**已入队任务继续运行；已保存的粗图与任务清单仍可下载。界面显示的是提交进度，最终生成进度在 ComfyUI 队列查看。

支持三维粗图、三维人偶 POSE 和三维机位 Canny，不需新增模型。原图提取或导入的二维 POSE / Depth / Canny 保持原机位，不能通过角度步进生成新视角。

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

**1.2.1 修复：**姿势预设缩略图按完整人物范围取景；编辑人偶后，POSE 输出不再沿用之前提取的原图骨架。旧版（1.0.1 及更早）还存在高 DPI 下预览放大、偏移至右上角的错误，已在 1.0.2 修复。黄框内是实际输出范围；人物超出黄框时先点击「适合画幅」。

更新时在节点目录运行 `git pull`，重启 ComfyUI，关闭旧工作台并按 `Ctrl+F5` 刷新。重新打开后，标题应显示 **T8 · v1.6.0**；重新点击「应用到节点」，替换工作流中已保存的旧粗图。

在 ComfyUI Manager 中搜索 **Comfyui-Qwen-Image-2.1-MultiAngle-T8**，选择正式版本安装；Registry 节点 ID 为 `qwen-image-21-multiangle-t8`。也可使用下方 Git 安装。内置人偶、前端资源与示例工作流随节点分发，模型权重按所用功能另行准备。

Registry 上传成功不等于安全审核通过；[查看实时版本状态](https://api.comfy.org/nodes/qwen-image-21-multiangle-t8/versions)。管理器中未显示正式版本时，请先使用下方 Git 安装。

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

### 按功能准备模型

下表路径相对于 `ComfyUI/`，`<节点目录>` 表示实际安装的节点文件夹。

| 功能 | 文件与位置 | 来源 |
|---|---|---|
| AnyAngle 换机位（可选） | `models/loras/QI2.1_AnyAngle.safetensors` | [原模型](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) |
| POSE 原图提取 | `yolox_l.onnx`、`dw-ll_ucoco_384.onnx`，首次下载至 `<节点目录>/.local/dwpose/` | [DWPose ONNX 权重](https://huggingface.co/yzd-v/DWPose/tree/main) |
| Depth 原图提取 | `depth_anything_3_small.safetensors`，推荐放入 `models/geometry_estimation/` | [ComfyUI 适配权重](https://huggingface.co/Comfy-Org/Depth-Anything-3/tree/main/geometry_estimation) · [DA3 原项目](https://github.com/ByteDance-Seed/Depth-Anything-3) |
| Canny 轮廓 / 手动人偶 | **无需新增模型权重**；Canny 在浏览器计算，人偶资源已包含 | [轮廓实现](web/editor/guides.mjs) · [人偶来源与许可](THIRD_PARTY.md) |
| Qwen Image 2.1 主模型 / Qwen3-VL 8B / VAE | 自行准备，分别放入 `models/diffusion_models`、`models/text_encoders`、`models/vae` | 使用与工作流兼容的底模权重 |

DWPose 优先复用 `custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/` 中的上述两个文件；否则使用节点自身缓存。DA3 优先读取 `models/geometry_estimation/`；若未放置权重，首次点击会下载到 `<节点目录>/.local/da3/geometry_estimation/depth_anything_3_small.safetensors`。内置深度提取使用 **Small**；其他 DA3 变体可在外部节点生成后接入 `structure_image`。

**原图三维重建**还需下列 5 个文件，均来自 [TripoSplat 官方权重包](https://huggingface.co/VAST-AI/TripoSplat/tree/main)，`python install_reconstruction.py` 会下载到对应位置：

| 文件 | ComfyUI 目录 |
|---|---|
| `triposplat_fp16.safetensors` | `models/diffusion_models/` |
| `birefnet.safetensors` | `models/background_removal/` |
| `dino_v3_vit_h.safetensors` | `models/clip_vision/` |
| `flux2-vae.safetensors` | `models/vae/` |
| `triposplat_vae_decoder_fp16.safetensors` | `models/vae/` |

示例工作流中的模型名需替换为本机已有的兼容权重。AnyAngle 和 TripoSplat 权重由安装命令下载；DWPose 与 Depth Anything 3 仅在点击对应功能时下载。姿势与深度推理、重建和渲染在本地完成。

**重建模型选择（1.1.0）：**支持上述类别的子目录及 ComfyUI 已注册的额外模型路径。标准文件名会自动识别；若文件已改名或存在多个同名副本，在工作台左侧展开「重建模型」，为 5 个角色选择兼容权重并「保存选择」，再点击「从原图重建 3D」。选择保存在当前浏览器；更换模型不会复用旧模型的重建缓存。更新后需重启 ComfyUI，并按 `Ctrl+F5` 刷新。

若旧版安装提示 `MakeHuman asset: HTTP 404`，在节点目录执行 `git pull`，确认 `web/vendor/assets/pose_studio_makehuman.v2.bin` 与 `web/vendor/textures/skin.png` 存在，重启 ComfyUI 并强制刷新浏览器。文件缺失时可点击错误窗口的「修复人偶资源」，或运行 `python install_assets.py` 补齐。

## 保存、迁移与限制

- 场景、粗图和资产保存在 `ComfyUI/input/anyangle_studio/`。迁移工作流时需一同复制相关资产；[API 工作流](workflows/AnyAngle-Studio-Qwen21-API.json) 需填入已应用的快照。
- 本机缺少工作流中的快照时，工作台会恢复为空白场景，仍可读取原图、重建或导入主体。重新应用后再运行工作流；权限或服务器错误会单独显示。
- GLB 需内嵌纹理；不支持 Draco、Meshopt、KTX2 压缩。GLB 正面校准只用于导入的 GLB，原图重建模式请使用相机角度与构图控制。
- 单图重建无法精确恢复遮挡、画外身体或完整背景。粗图尺寸与下游生成分辨率分别设置。
- 已在 RTX 5090 Laptop 24 GB 上验证；其他硬件需按本机模型及分辨率调整。

### 网络访问

「修复人偶资源」仅在点击后从本仓库固定提交下载缺失或损坏的人偶 / 贴图，并进行 SHA-256 校验；资源完整时不访问网络。

节点接口使用 ComfyUI 服务器的访问边界，没有独立登录功能。本机使用 ComfyUI 默认的 `--listen 127.0.0.1`；局域网或云端使用需通过受信网络、VPN 或带身份验证的反向代理访问，并保护整个 ComfyUI 服务（包含 `/anyangle-studio/*`）。请勿直接将未经身份验证的端口暴露到公网；仅限制客户端 IP 为回环地址不能替代登录验证。

## 致谢与许可

感谢 [AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle)、[TripoSplat](https://github.com/VAST-AI-Research/TripoSplat)、[Fisher Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose)、[VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils) 与 [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D)。本项目为独立集成，并非原模型官方插件。

项目代码采用 [MIT](LICENSE) 许可；第三方代码、资产与模型遵循各自许可，详见 [来源说明](THIRD_PARTY.md)。

## T8 链接

[B站](https://space.bilibili.com/385085361) · [YouTube](https://www.youtube.com/@T8star-Aix/) · [Hugging Face](https://huggingface.co/t8star)

[API 服务](https://api.seedance.nz/sign-up?aff=5f4w) · [免费画廊](https://www.openzhenzhen.com) · [在线 AI 应用](https://www.runninghub.ai/zh-cn/user-center/1907375370302308353/userPost?inviteCode=rh-v1121) · [ComfyUI 整合包](https://pan.quark.cn/s/264edb7e36bd)
