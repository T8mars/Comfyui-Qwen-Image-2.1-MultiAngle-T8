# 1.5.1 联合检查

[简体中文](#检查记录) · [English](#english)

基于 1.5.0，主 Agent 与独立子 Agent 分工完成 20 轮检查。发现并修复四处代码问题，另调整 POSE 来源说明。检查包括实际函数、ComfyUI HTTP 路由、浏览器操作和硬件 WebGL；没有把模型生成质量偏差视为已修复的节点问题。

## 检查记录

| 轮次 | 范围 | 实际验证与结果 |
| --- | --- | --- |
| 1 | 多人场景数据 | 12 人规范化、保存和回读；调用方数据与拍摄中心保留。 |
| 2 | 身份绑定 | 隐藏人物、倒序、共享照片去重；11 人映射仍对应原照片。 |
| 3 | 原生编码与动态入口 | 原生接口 17 图 CPU 探针，无截断；这不是 GPU 生图质量评估。 |
| 4 | 静态结构图与提示词 | 800 组前后端组合对比，映射与提示词一致。 |
| 5 | 合影识别 | 真实 DWPose HTTP 提取识别两人，各 14 个身体关节。 |
| 6 | 标准骨架 JSON | 修复无画布尺寸的 OpenPose JSON 导入；BODY18/25、自带尺寸优先均通过真实 HTTP 回测。 |
| 7 | 便携场景 | 示例 ZIP 在另一存储实例导入，人物、照片、区域、姿势和机位保留。 |
| 8 | 资产完整性 | 路径、摘要、缺失资产和 ZIP 校验；合法全黑图仍允许保存。 |
| 9 | 批量保存 | 三个不同相机/中心的快照与 ZIP，人物身份冻结，不受后续编辑污染。 |
| 10 | 空设置旧场景 | 修复 `conditioning:null` 导致 HTTP 500；v1/v2 均可保存和回读。 |
| 11 | 引导来源与 UI | POSE 说明随原图骨架/三维骨架切换，实际浏览器验证。 |
| 12 | 道具与撤销 | 修复撤销后控件仍编辑旧道具对象；位置、锁定、显示和删除回归通过。实际 UI 导出位置与输入一致。 |
| 13 | 多人选择与随机 | 添加、复制、删除、Ctrl 多选；锁定人物保持，未锁人物可按种子随机。 |
| 14 | 姿势来源与互动 | 当前人物姿势导入/导出、翻转隔离；合影选人取消不改人物，握手双腕对齐验证。 |
| 15 | 相机与收藏 | 收藏包含拍摄中心；更换模板后回放恢复相同引导图，人物姿势保持。 |
| 16 | 提示词模式 | 双图顺序、单引导图、自定义首次生成与后续编辑保留，实际处理函数验证。 |
| 17 | 输出构图 | 36 组 DPR、画幅与焦距；捕获前后相机和画布稳定，投影误差小于 `7e-16`。 |
| 18 | 批量失败与恢复 | 队列提交幂等、失败不重复提交、停止与原草稿/Canny 警示恢复。 |
| 19 | 精简旧场景 | 修复缺少机位收藏等可选字段时加载失败；默认值补齐，旧姿势、朝向与尺度仍迁移。实际 UI 可重新打开并导入 JSON。 |
| 20 | 性能与生命周期 | 3/6/9 人切换，空闲按需绘制；形态缓存、重复捕获资源稳定与关闭释放检查。 |

完整回归：167 项 JavaScript、89 项 Python，均通过。独立硬件渲染使用 Intel D3D11；3/6/9 人切换约 21–29 ms。此测量不代表所有设备，也不替代已公开的多人生成质量评估。

标准 JSON 采用像素坐标。没有画布尺寸时，UI 使用原图尺寸；无原图时使用当前输出尺寸，并提示核对。文件内已有尺寸优先。[OpenPose 官方格式与坐标范围](https://github.com/CMU-Perceptual-Computing-Lab/openpose/blob/master/doc/02_output.md#json-output-format)。

## English

The main agent and an independent subagent completed 20 focused rounds against 1.5.0. Four confirmed defects were fixed:

- Null conditioning settings caused snapshot HTTP 500 errors.
- Standard pixel-coordinate OpenPose JSON without canvas metadata could not be imported. Explicit source-photo/output canvas dimensions now provide a fallback; dimensions in the file take priority.
- Prop controls could edit detached objects after undo, causing saved positions, visibility or locks to disagree with the UI.
- Sparse older snapshots without bookmarks or other optional fields could fail to open. Defaults now preserve the legacy pose, heading and scale during migration.

POSE help also follows the actual guide source. The rounds cover schemas, stable identities, native encoding, prompt mapping, DWPose, JSON, portable assets, storage, batches, UI, history, random scopes, pose isolation, camera bookmarks, capture framing and resource disposal.

All 167 JavaScript and 89 Python tests passed. A real ComfyUI instance verified both null-setting snapshot versions and BODY18/25 JSON imports. Actual browser operations verified sparse snapshot opening, JSON import and prop-position export. An isolated hardware WebGL fixture checked 36 frame/focal-length/DPR combinations and stable resources. The native 17-image CPU probe checks interface behavior, not image-generation quality. Known model limitations remain documented in [the multi-person validation report](multi-person-validation.md#english).
