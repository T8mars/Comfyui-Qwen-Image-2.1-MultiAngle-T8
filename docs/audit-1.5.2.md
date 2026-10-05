# 1.5.2 联合检查

[简体中文](#检查记录) · [English](#english)

基于 v1.5.1，主 Agent 与独立子 Agent 完成新一轮 20 项专题检查。后端使用新的临时 HTTP 服务、真实本地 ONNX 和原生 CPU 编码接口；前端使用实际 ComfyUI 操作、真实显卡 WebGL 和独立边界探针。以下是本轮实测结果。

确认并修复四类问题：

- 失败编辑会清空重做记录，撤销历史满 40 项时还会丢失最早记录。人物、编排、照片复制、旧版单人复制、3D 重建、GLB 导入及切换人偶均保留失败前的历史；恢复旧场景再次失败时保留原始错误。
- 锁定人物仍可被「场景与构图」的资产尺度控件缩放。两种尺度控件现在同步禁用，相机仍可编辑。
- 替换导入的蒙皮 GLB 时，骨骼纹理未释放。真实渲染确认纹理数由 10 增至 11，切回人偶后恢复 10。
- 损坏 DEFLATE / LZMA 压缩数据的场景 ZIP 导入返回 HTTP 500。现在返回明确的 HTTP 400 文件错误，且不写入资产。

## 检查记录

| 轮次 | 范围 | 本轮证据与结果 |
| --- | --- | --- |
| 1 | 场景数据与合法空引导 | 32 人规范化、25 人可见，保存不截断、不修改调用方；全黑引导可执行。 |
| 2 | 身份、引导和提示词契约 | 7,680 组实际 JS / Python 组合，映射与提示词 0 差异；涵盖共享照片、文字身份、双图顺序、单图与自定义。 |
| 3 | BODY18 / BODY25 JSON | 各 6 人的髋、膝、脚索引正确；显式尺寸优先；低置信度与空人群合法。 |
| 4 | 手部与脸部置信度 | 68/70 脸点及左右 21 手点保留；0.3 绘制，0.299 不绘制；不补造缺失细节。 |
| 5 | 真实 DWPose | 本地 ONNX 从实际双人参考图识别 2 人，各 14 个可见身体关节。 |
| 6 | 原生多图编码 | 17 张身份照 + 1 张引导共 18 张，真实原生 CPU 接口全部保留；零身份照仍输出引导。 |
| 7 | 图像规范化与隔离 | 索引 PNG / RGB PNG 去重、EXIF 方向校正和路径逃逸检查通过。 |
| 8 | 便携 ZIP 与损坏文件 | Stored / Deflate / BZIP2 / LZMA 跨存储导入一致；七种损坏/不支持路径均为 400，压缩错误零资产写入。实际磁盘写入错误不伪装为压缩损坏。 |
| 9 | 批量机位持久化 | 三个机位的真实 PNG、相机、manifest、prompt_id 冻结；后续编辑不污染批量 ZIP。 |
| 10 | HTTP 空字段与边界 | v1/v2 空设置保存/读回均 200；六类无效字段均为 400 JSON 错误。 |
| 11 | 失败编排与历史 | 实际 UI 复现单选人物握手失败后 Redo 丢失；修复后保留。历史满 40 项时仍完整回滚。 |
| 12 | 锁定范围 | 实际 UI 复现锁定人物被全局尺度改变；修复后两个尺度控件禁用，相机缩放可用。 |
| 13 | 复制与载入失败 | 照片复制到锁定人物、单人姿势复制、GLB、人偶、重建加载失败均保留场景及历史；原始错误不会被回滚错误覆盖。 |
| 14 | 模板与身份隔离 | 新探针执行 100 次倒序、删除、复制、模板应用；存活角色 ID、身份照、互动映射和拍摄中心一致。 |
| 15 | 收藏与模板 | 真实 DOM 操作更换拍摄中心后恢复收藏，输出引导逐字节相同；角色姿势保持。 |
| 16 | 引导与骨架导入 | 真实硬件确认场景 Depth、非空 Canny、9 人 Fisher PNG；原骨架不会被绑定为身份照。 |
| 17 | 构图与透视 | 36 组 DPR × 画幅 × 24/50/85mm；捕获前后相机稳定，最大投影误差小于 `7e-16`。 |
| 18 | 批量计算和中断 | 新探针验证 120 组递增/递减/小数步长；捕获、保存、排队分别取消或失败时停止，保留已保存项。 |
| 19 | 蒙皮 GLB 生命周期 | 实际 Skeleton 单测复现未释放纹理；真实 GLB 加载和硬件渲染确认释放、纹理数归位。 |
| 20 | 性能与重复使用 | 3/6/9 人正确输出、切换和相机稳定；重复捕获前后资源均为 16 几何体 / 10 纹理，空闲按需绘制。 |

完整回归：**178 项 JavaScript + 91 项 Python，269 项全部通过**。最后一轮硬件测试使用 Intel D3D11，3/6/9 人切换平均分别为 27/22/24ms；这不是所有设备的性能保证。

本轮没有重新进行大型模型生图。18 图 CPU 测试验证编码接口、参考数量和 latent 契约；不代表 18 图生成质量可靠。原生 Qwen 编码器仍以第一张实际参考图确定画幅。合法黑图和额外参考可执行，实际生成质量、多人细节与单图背面补全的限制见[多人实测报告](multi-person-validation.md)。

更新后重启 ComfyUI，关闭旧工作台并按 `Ctrl+F5` 刷新，确认标题为 **T8 · v1.5.2**。

## English

A fresh joint audit against v1.5.1 covered the 20 scopes above. Four defect classes were reproduced and fixed:

- Failed edits discarded redo and could evict the oldest undo entry at the 40-entry limit. Actor/cast edits, photo copying, legacy single-person copying, reconstruction, GLB imports and mannequin switching now restore history. A second failure during rollback preserves the original error.
- Locked actors could still be resized through the scene-scale controls. Both scale controls now respect the lock; camera controls remain available.
- Replacing an imported skinned GLB leaked its bone texture. An actual GLB and hardware render verified texture allocation and release, returning the count from 11 to 10.
- Corrupt DEFLATE or LZMA scene ZIPs caused an unhandled HTTP 500. They now return a readable HTTP 400 without writing assets. Valid stored/Deflate/BZIP2/LZMA archives remain readable; disk write errors are not misreported as corrupt compressed data.

All **178 JavaScript and 91 Python tests passed**. New independent probes covered 7,680 JS/Python manifest/prompt combinations, 100 reordered/deleted/cloned template identity cases, 120 batch ranges and cancellation/failure at each batch stage. Local ONNX detected two people with 14 visible body joints each. Temporary HTTP tests verified corrupt ZIPs, portable assets and invalid/null fields.

Actual editor DOM and hardware WebGL verified role/prop controls after undo, camera bookmarks across templates, photo-selection cancellation, scene Depth/Canny, nine-person Fisher PNG import, and 36 frame/focal-length/DPR combinations. The final Intel D3D11 run averaged 27/22/24ms for 3/6/9 actors respectively; resource counts remained stable through repeated captures.

This round did not rerun large-model generation. The 18-image native CPU probe checks reference/latent contracts, not generation quality. The first actual reference still determines the native latent canvas. Legal black guides and additional references remain executable. [Measured generation limits](multi-person-validation.md#english) remain applicable.

Restart ComfyUI and refresh with `Ctrl+F5` after updating; the workbench header should show **T8 · v1.5.2**.
