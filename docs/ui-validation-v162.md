# Studio 1.6.2 · UI 验收 / UI validation

2026-10-09。主 Agent 与独立子 Agent 完成 20 轮审查；使用真实 Chrome 检查布局、表单和输出来源，再执行回归测试。这些是 UI 检查，未新增模型推理或批量出图。

Completed 20 review rounds with an independent agent, real Chromium layout and interaction checks, and automated regressions. This patch does not change inference models, node ports or scene formats.

## 修复 / Fixes

- 骨架遮挡、姿势复制下拉框采用上下布局，标签与输入间隔 8 px。
- 窄窗口保持“拍摄相机 → 方位 / 俯仰 / 缩放 → 镜头透视”的顺序；320 px 窗口也能完整显示应用按钮。
- 原图骨架模式隐藏三维手部 / 遮挡设置和鼠标俯仰，禁用会导出其他来源的三维 JSON。复制到人偶后恢复对应操作。
- 修复参考库刷新覆盖导出、批量及显示状态；无引导图不能导出，静态结构图不能批量改变机位。
- 撤销替换场景后重新绑定素材卡片，后续名称和用途编辑作用于当前场景。
- 保存的自定义首图预算（如 1152²）正确显示；零面积裁切在表单层校验。
- 已连接 `reference_image` 时，素材“作为来源图”明确禁用并提示更换上游或断线；缺图素材不允许裁切。
- 素材 / 对象页签支持方向键、Home / End、焦点切换和可访问的页签关联。

Pose fields are stacked; camera sections retain their reading order at responsive breakpoints. Static source guides expose only applicable actions. Reference edits survive undo, custom image budgets remain visible, connected sources retain ownership, crop forms reject zero area, and sidebar tabs support keyboard navigation.

## 20 轮检查 / 20-round review

| 轮次 / Round | 范围 / Scope | 结论 / Result |
|---|---|---|
| 1 | 截图对应字段与样式 / Pose fields | 修复标签挤压 / Fixed |
| 2 | iframe 初始化与消息 / Initialization | 1.6.1 修复保留 / Pass |
| 3 | 空场景导出与批量 / Empty-scene actions | 修复能力状态覆盖 / Fixed |
| 4 | 原图 POSE 手部与遮挡 / Static POSE options | 隐藏仅三维设置 / Fixed |
| 5 | 自定义全文下的骨架 JSON / Static JSON export | 防止导出其他来源 / Fixed |
| 6 | 自定义首图预算 / Custom first-image budget | 1152² 显示正确 / Fixed |
| 7 | 主来源 IMAGE 连线 / Connected source | 明确连线所有权 / Fixed |
| 8 | 缺图、更新、批次 / Missing and batched references | 无效动作禁用；已有回归通过 / Pass |
| 9 | 零面积裁切 / Zero-area crop | 原生表单拒绝 / Fixed |
| 10 | 裁切拖动与边界 / Crop boundaries | 原图坐标与后置验证保留 / Pass |
| 11 | 撤销后的素材编辑 / Reference edits after undo | 重绑当前场景 / Fixed |
| 12 | 排序、去重、用途与图号 / Reference manifest | 原有编码规则保持 / Pass |
| 13 | 多人增删、锁定、随机 / Cast controls | 现有方法回归通过 / Pass |
| 14 | 道具与历史事件绑定 / Prop history | 现有方法回归通过 / Pass |
| 15 | 收藏机位与画幅 / Bookmarks and framing | 保存目标与失败回滚回归通过 / Pass |
| 16 | 页签键盘与焦点 / Keyboard tabs | 真实浏览器通过 / Fixed |
| 17 | 批量范围、停止与失败 / Batch lifecycle | 现有回归通过，静态图入口禁用 / Pass |
| 18 | 导入、导出、无引导模式 / Imports and modes | 真实控件与格式回归通过 / Pass |
| 19 | 释放与按需渲染 / Resource lifecycle | 方法回归通过；未宣称 CPU 压测 / Pass |
| 20 | 合并复核、布局与引导 / Final browser regressions | 244 JS、13 尺寸、11 交互用例通过 / Pass |

## 实测与复现 / Reproduction

全量 JavaScript **244 / 244** 通过。独立浏览器用真实编辑器运行 **13 个窗口尺寸**（320～1920 px）和 **11 个交互用例**：包含原图 POSE → 人偶、深度反转、Canny 阈值、多人引导切换、撤销及 FK / IK 点击。未捕获页面异常。另以已有多人快照执行 20 项布局 / 模式 / 弹窗探针，原始回执保存在本地 `.local`，不上传用户素材。

244 JavaScript tests passed, plus 13 real-editor viewport checks and 11 browser interaction cases. No page exceptions were captured. Inference quality and every third-party environment are outside this UI validation scope.

```powershell
node --test tests/*.test.mjs
node tests/ui-browser.mjs
```

浏览器脚本需要 Playwright 和 Chromium；可通过 `ANYANGLE_PLAYWRIGHT` 与 `ANYANGLE_CHROMIUM` 指定本机路径。它启动隔离的静态测试服务，模拟测试专用 API，不操作正在运行的 ComfyUI 或提交生成任务。

The browser runner requires Playwright and Chromium. Optional `ANYANGLE_PLAYWRIGHT` and `ANYANGLE_CHROMIUM` select their local installations. Tests use a separate fixture server and submit no generation jobs.
