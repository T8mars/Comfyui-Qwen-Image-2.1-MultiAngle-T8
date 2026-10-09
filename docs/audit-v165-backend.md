# v1.6.5 后端审计：第 11–20 轮

2026-10-09。在 v1.6.4（`300cc950`）基础上检查，每轮选择不同的执行边界；不将重复跑同一组测试计作不同轮次。第 1–10 轮由主 Agent 检查 UI 与浏览器行为。本记录覆盖代码审查、可执行回归和只读本机服务核对，不等同于 20 次模型出图，也不承诺模型对所有素材组合都精确服从。

基线：Python `unittest discover` 共 118 项通过。发现问题先增加失败回归，再修改对应 owner 层。此次后端未启动、停止或重启 ComfyUI，未更改用户 Chrome 工作流、参考图或私有素材。

最终结果：Python **130/130**（新增12项有意义回归）、公共工作流连线 **8/8**；共享 AnyAngle fixture 的完整前后端清单和提示词一致。模型切换修复后重新执行独立构造的 **384组**前后端契约矩阵，完整清单和提示词均一致，包含缺省/反向图序、有无原图、custom/default、各场景来源、三种模式、同 hash 不同标签及空名导入。矩阵不替代真实模型生成。

| 轮次 | 范围与实际证据 | 结论 / 修复 |
| --- | --- | --- |
| 11 | 素材停用、删除、替换、同图多用途、失效连线；`test_disabled_assets_and_templates_survive_no_png_zip_and_batch`、`test_same_asset_multi_uses_unique_index_and_deleted_targets_do_not_go_global`、`test_connected_reference_batch_is_explicit_and_disconnect_requires_saved_version` | 停用素材不进入编码；删除目标不升级为全局用途；明确使用保存版本与重新读取连线是不同路径。新 AnyAngle 额外素材回归同时确认停用素材仍被排除、同 hash 多用途只编码一次。 |
| 12 | 可见人物、删除人物、身份与人数，v2 及 v3；既有排序/删除/隐藏回归，以及新增混合目标、空名导入回归 | 修复：一个用途同时选有效、隐藏及已删除人物时，目标文字正确但回执 `actorIds` 仍带无效 ID；现在只记录存在且可见的 ID。另复现导入合法空名角色时 UI 会显示 ID，后端却排除其身份素材；现在角色及素材空名均按 ID 回退。Splat 中保留的角色只用于描述性目标，不列入 `manifest.actors`，不伪造已验证的几何人数或硬遮罩。 |
| 13 | AnyAngle 作者触发词、双图顺序、额外参考用途、全文自定义提示词；新增 `test_anyangle_*` Library 回归和共享 fixture，先复现素材被丢弃及用途未进入提示词 | 修复功能阻断：guided AnyAngle 保留原图/粗图为前两个输入，并将人脸、服装、配饰、场景、风格等已启用素材送到 3+。原图1/粗图2使用 `Change the camera angle from <image2> to <image1>.`；用户主动反向图序仍反向标签；缺少图序字段时 AnyAngle 默认作者图序，普通 Qwen 保留 guide-first 默认。纯双图保持原句；新增素材追加用途；自定义全文原样保留。缺少原图时保留其他素材、guide1/素材2+，改用构图说明而不是引用不存在原图的双图触发句。 |
| 14 | 图像预算、实际编码顺序、RGBA、原生 latent；新增 `test_anyangle_native_encoder_keeps_original_full_size_and_budgets_only_extra_materials` 调用本机真实 `TextEncodeQwenImage21`，仅 CLIP/VAE 权重执行用可检查的 CPU 替身 | 实测原图160×96、粗图160×96、2张额外素材、预算32；原生 VAE 收到尺寸依次160×96、160×96、32×32、32×32。原图预算固定为0保留输入尺寸，extra使用节点预算；4个参考 latent 都存在，输出160×96，PNG RGBA第四通道保留给原生 VAE，vision按原生规则合成白底。普通 Qwen 首图定输出尺寸规则不变。 |
| 15 | 快照来源与运行时连线更新；新增 `test_changed_connected_source_cannot_reuse_an_unaccepted_extracted_guide` | 先复现 Depth/POSE 两个子例均未抛错：保存时校验通过后，上游原图变化可以绕过 DA3/DWPose 来源校验。修复节点执行边界：只对当前激活的原图提取结构检查来源；同图、用户明确沿用保存结构、无引导文本模式均继续执行。此检查不限制相机角度或人物站位调整。 |
| 16 | 多机位归档、不同 PNG、快照 ID、冻结正负提示词；`test_batch_archive_contains_distinct_guides_and_camera_manifest`、`test_batch_receipt_contains_actual_frozen_text_and_hashes`、HTTP `test_saved_batch_download_streams_real_pngs_and_task_metadata` | 通过：不同机位与不同引导 PNG 保留各自快照及任务 ID，归档内实际 PNG 像素与记录一致；全文及负向提示词 hash 对应保存的真实文本。这里只验证归档/契约，不代表本轮实际生成了整批模型结果。 |
| 17 | 重建模型选择、改名/子目录、背景选项、相机 crop/bbox、空遮罩与无效高斯；`test_reconstruction.py`、`test_reconstruction_routes.py` | CPU 元数据及 HTTP 回归通过：背景模式跳过不使用的 BiRefNet，所有角色仍使用原生模型路径；空高斯/非法相机 token/空前景在发布文件前给出错误；单像素前景和全图 mask 保持有效 crop。GPU TripoSplat 重建效果不由这些 CPU 替身测试保证。 |
| 18 | 节点输出4项接口、Autogrow零输入及真实 flattened 输入归一化、批次显式选择；`test_v3_schema_preserves_legacy_inputs_outputs_and_autogrow_zero_minimum`、`test_real_v3_flattened_autogrow_inputs_normalize_to_actor_bindings`、新增批次提示回归 | 修复：v3 素材显式选择批次第二张/多张且真实发送2张时，仍提示“只使用第一张”；现在该提示只用于旧 v2 人物身份路径。v3 数量与批次索引照实执行。节点名、输入名及4项返回类型不变。 |
| 19 | Optional LoRA 的0强度、非0强度委托及空文件名；`test_optional_lora.py` 3项；与主 Agent 互审 AnyAngle 前后端后追加384组契约矩阵 | 通过：0强度不访问缺失权重，非0委托原生 `LoraLoaderModelOnly`，不绕过模型 patcher，不重复实现加载器。互审使 splat 角色绑定范围、缺省图序、同 hash 原图元数据 owner、空标签回退完全对齐；384组合无 manifest/prompt 差异。未在本轮重新加载GPU权重做模型效果对比。 |
| 20 | 公共工作流连线与本机注册；`node --test tests/workflows.test.mjs` 8项通过；只读 `http://127.0.0.1:8192/object_info` 核对11个JSON | 10个基础/多人/多参考/仅参考/Turbo模板的后端节点全部注册。Advanced 缺少的6项均是 README 已声明的额外依赖；当前服务只 whitelist 本节点及 Viggle，不将这些选装依赖误记为安装成功。`Note` 是前端注释节点。修正通用 MultiReference GUI/API 的 Preview 标题，不再把动态 guide 硬写为 image1；模板说明同步 AnyAngle 额外用途、原图独立预算与 Turbo 实际加载能力。没有更改模板链接或安装额外节点。 |

## 追加：高斯场景切换 Qwen 底模

主 Agent 在 Chrome 的真实三人高斯工作流中点击 Qwen 底模，实际输入由8图降为3图；绑定到角色的女性/男性身份及服装用途均被标记为目标待重新分配。后端先添加回归，实际复现6个失败子例：切底模后角色素材被排除，粗图、POSE、Depth、Canny及仅参考模式均受影响。

修复 `target_text` 的模型限制：高斯场景中的可见角色名称可在 AnyAngle 与 Qwen 底模中继续作为描述性用途目标。角色 ID 仍只记录存在且可见的目标，GLB 及空场景继续排除旧角色绑定；`manifest.actors` 仍只导出 human 可编辑人物，高斯不会生成已验证人数、人物颜色或硬遮罩声明。扩展模型切换回归，并新增四种引导/仅参考/纯文本模式回归；完整 Python 套件130项通过，前端同步后384组契约重新执行，差异为0。此修复保证素材和用途进入模型输入，不保证生成模型精确识别每个名称或来源区域。

## 实际执行命令

在仓库根目录运行：

```powershell
& 'E:\comfyui-t8-onekey-5x\python\python.exe' -X utf8 -m unittest discover -s tests -p 'test_*.py' -v
& 'E:\comfyui-t8-onekey-5x\python\python.exe' -X utf8 -m unittest discover -s tests -p test_node_output.py -v
& 'E:\comfyui-t8-onekey-5x\python\python.exe' -X utf8 -m unittest discover -s tests -p test_reference_library.py -v
& 'C:\Users\27611\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/workflows.test.mjs
& 'E:\comfyui-t8-onekey-5x\python\python.exe' -X utf8 -m py_compile __init__.py reference_library.py storage.py
& 'E:\comfyui-t8-onekey-5x\python\python.exe' -X utf8 .local/audit_v165_contract_matrix.py
git diff --check
```

节点注册核对由 Python `urllib.request` 只读获取 `/object_info`，逐个检查11个公共工作流 JSON 中的 `type` / `class_type`，排除前端 `Note`，并将 Advanced 缺少的依赖与 README 声明逐项比对。本机回执保存在忽略目录 `.local/audit-v165-workflow-registration.json`。

384组合矩阵通过 Python 与 Node 分别计算完整清单和提示词，包含空名导入及同 hash 不同用户资产标签；执行脚本和回执在 `.local/audit_v165_contract_matrix.py`、`.local/audit-v165-contract-matrix.json`，不随发布上传私有本机测试材料。

## 验证边界

- `TextEncodeQwenImage21` 的排序、缩放、alpha合成、正负 conditioning 拼接和 latent创建使用本机原生代码；测试 CLIP/VAE 仅替换权重计算，不能据此声明生成人脸/服装/背景效果达标。
- Splat 的角色名称/来源描述绑定是提示词约束；这里没有增加分人物 mask 或拆分高斯骨骼。
- 多用途参考叠加是否削弱机位、风格或身份服从需要真实生成对比，主 Agent 负责单独核验。
- 审计结果仅覆盖本记录列出的输入与行为，不将“回归通过”表述为所有场景无 BUG。
