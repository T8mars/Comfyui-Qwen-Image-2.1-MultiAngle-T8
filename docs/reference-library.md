# 多图参考与独立提示词

[中文](#多图参考与独立提示词) · [English](#english)

1. 导入多图或仅参考工作流，打开 Studio，选择 Qwen 底模。
2. 在「参考素材」上传多张图片或读取 `参考图 N（通用）` 连线。展开卡片，选择用途与目标；可增加用途或勾选多个对象。来源区域说明是文字指令；「裁切素材」会生成真实独立图片。
3. 需要姿势、构图或空间引导时，到「场景对象」添加人物 / 道具，在右侧选粗图、POSE、Depth 或 Canny。只用参考创作则无需三维主体；纯文本模式不发送图片。
4. 查看发送清单后「应用到节点」，再运行工作流。仅参考模式由首图决定画幅，首图面积预算与其余参考预算分开；按原生规则对齐 32 像素。

| 提示词方式 | 编码行为 |
|---|---|
| `input-full` | 输入原文作为完整正向词，包括空串；不追加模板或素材用途 |
| `studio-plus-input` | Studio 提示词 + 输入补充；空补充保持原行为 |

默认示例连接 Studio 的完整提示词并选 `input-full`。可以断线手写或接文本拼接节点。正负词分别输入；Viggle BasicGuider 不使用 negative 输出。自定义全文的 `<imageN>` 不会被擅改，排序 / 去重后请核对清单。用途是语义描述，不是 attention mask、ControlNet 或精确身份锁定。

场景来源图用于重建 / 提取，普通风格素材不会移动相机或重建人物。换来源图后旧重建与提取结果会提示重新生成，或明确沿用保存结构。断开启用素材的连线会阻止应用；「使用已保存版本」可明确解除连线依赖。IMAGE 批次显示总帧数，点击拆分后才作为多张素材发送。

参考组合模板保存素材和用途；套用时生成独立 ID，目标需核对。场景 ZIP 包含全部素材，包括停用项。批量机位冻结素材与外部正负词：全文原样复用，补充模式按每个机位生成 Studio 文本再追加。批量 JSON / ZIP 中的 `encoding_plan` 是提交计划；成功出图及实际编码信息以 ComfyUI history 为准。

## 模型与节点

| 功能 | 来源 | 放置位置 |
|---|---|---|
| 多图底模 | [Qwen Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) | 主模型 `ComfyUI/models/diffusion_models/`，Qwen3-VL 编码器 `models/text_encoders/`，2.1 VAE `models/vae/` |
| 双图 AnyAngle 换机位 | [QI_2.1_AnyAngle](https://huggingface.co/lilylilith/QI_2.1_AnyAngle) | `ComfyUI/models/loras/`；普通多图路线强度 0，不要求该文件 |
| Turbo 加速 | [Viggle 模型](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo) / [专用节点](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/tree/main/comfyui) | `Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors` → `models/loras/`；作者 `viggle_turbo.py` → `ComfyUI/custom_nodes/` |

Turbo 工作流使用运行时 LoRA 1、Euler、BasicGuider、SamplerCustomAdvanced 和作者的动态 Sigma 节点。原始时间节点是 `1, 0.9375, 0.875, 0.75, 0.5, 0.25`，由专用节点按实际 latent 处理。作者验证重点是 1–3 张参考，复杂多参考效果需另验，不叠加 AnyAngle LoRA。建议先约 1MP。

多图参考本身无需新权重。姿势 / 深度 / 三维重建仍复用现有 [模型清单](../README.md#按功能准备模型)。超过建议的 10 图会提示，但不会主动丢图；17 图已做原生编码实测，不能据此推断 17 图语义控制质量。

## English

Import a guide + references or references-only workflow and open Studio in Qwen base mode. Add materials or read general reference sockets. Expand a card to set purposes and targets; add uses or select multiple objects. Region descriptions are text; cropping creates a real new image. Use the scene-object tab for people and props, with 3D, POSE, Depth or Canny guides on the right. Reference-only needs no 3D subject; text-only sends no images.

Apply after checking the send list. In references-only mode, choose the first reference and its separate area budget; native dimensions round to multiples of 32. `input-full` preserves the complete input, even an empty string. `studio-plus-input` appends a description to Studio's text. Examples wire Studio's complete prompt using full-input mode. Disconnect to type or connect another text node. Negative text is independent; Turbo's BasicGuider does not consume it.

Sources for reconstruction / extraction are separate from creative references. Changing the source marks old derived content for regeneration or explicit reuse. Missing enabled connections require rereading or explicitly choosing the saved version. IMAGE batches use frame one until split. Templates preserve materials and purposes with fresh IDs when applied; verify targets. ZIPs include disabled materials. Camera batches freeze references and external text once. Full text is reused; append mode adds frozen text to each view's Studio prompt. `encoding_plan` describes submission; check ComfyUI history for execution and actual encoding results.

Model sources and paths are listed above. General references need no additional weights. Turbo requires the author's `viggle_turbo.py` and r128 adapter, using runtime LoRA, dynamic sigmas, Euler and BasicGuider. Its negative output is unused, and the author's reference tests focus on 1–3 images. Keep AnyAngle off. The 10-image recommendation is a quality / memory guideline: images are not silently truncated. Seventeen images passed native encoding here; this does not establish multi-image generation quality.
