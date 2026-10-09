# 会话轨迹（Trajectory）— Studio 原生事件账本

参考设计：DeepSeek Harness 的 [`ui-trajectory`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-trajectory/src/client)，尤其是 `TrajectoryView.tsx`、`TrajectoryTimeline.tsx`、`TrajectoryTable.tsx` 和 `TrajectoryCell.tsx`。本实现重新编写自己的 Rust 事件投影和 React 页面，不复制第三方组件。

## 已实现（2026-10-09）

- **位置**：同一会话的 Chat 页面顶部新增 `Chat · 对话` / `Trajectory · 轨迹` 标签，切换时保留现有会话，轨迹页隐藏输入框，返回 Chat 不创建新会话。
- **上方**：三轨道 `Input` / `Model` / `Tools` 时间轴。根据真实日志 `time` 和配对 `endAt` 绘制彩色区间；未配对的单次事件仅画标记，不推测持续时间。点击柱状区选中事件；鼠标拖选时间区间筛选下方列表，可清除筛选。
- **下方**：按 `Turn` 分组、可折叠的角色事件清单，SYSTEM/USER/ASSISTANT/TOOL/CONTEXT/MODEL 不同颜色。支持角色筛选、文本搜索、长会话“加载更早事件”、当前轨迹增量刷新（7 秒一次）。
- **右侧**：点击事件展示来源事件序号、具体内容、输入输出、真实起止时间、配对耗时、存在真实 token delta 时的 TTFT/解码时间，以及后端记录的 Token 用量；没有数据的指标显示“未记录”，绝不虚构。失败的 ToolResult 在清单中强调。
- **原生数据**：`dsh-wasm-studio/src-tauri/src/trajectory.rs` 读取授权的活跃 Agent Session Event 日志，或在未加载时读取持久化日志。按事件序号排序，以 `before` 和 `limit` 尾部分页；单页上限 500，默认 200。流式 token 块只参与 TTFT 的准确计算，不逐个作为下方事件行，以免长会话被 token 事件淹没。图片/附件仅显示占位符，不返回原始 base64；工具参数和长正文截断至 24,000 字符。
- **原生命令**：Tauri `session_trajectory({agentId,before?,limit?})`；OpenHanako `GET /api/session-trajectory?sessionId=studio%3A%2F%2F...&before=&limit=` 走同一宿主；宿主未注册时明确 `capability_unavailable`，无假数据。`js/lib/api.js`、`js/lib/hana-adapter.js` 和插件声明的原生命令白名单同时更新。
- **测试**：原生单元测试覆盖真实时间配对、token 时间、尾部分页和缺失数据不编造；WASM 真实工具回合集成测试覆盖原生投影；bridge 测试覆盖本机路由/游标/拒绝无原生能力；React 测试覆盖页内切换、事件详情、时间轨道、分页及错误展示。

## 边界与后续

1. 需要重建并重新启动带新命令的 Studio 宿主，以及更新 OpenHanako 插件/前端包。**真实已安装桌面应用 GUI 的人工点击验收尚未完成。**
2. 该实现提供实际 Session Event 时间账本，并不是将 DeepSeek Harness 整套 UI / 虚拟列表 / 多层子工具轨迹一比一搬运：超长轨迹以逐页加载代替虚拟滚动；尚未实现鼠标滚轮缩放/拖动平移和跨多步的复杂工具树。
3. 历史 session 只显示其日志中实际保存的事件和 token 时间戳。旧日志没有 token Delta 就不能显示 TTFT。`dispatched` 不等于模型最终完成；此视图不改变宿主的权限策略或流式重连机制。
4. 当前仅支持已连接原生 Studio 的轨迹数据。完整 Hana Server 独立运行模式若没有等效 API，会明确提示不可用，不自动仿造。
5. 开发、构建、检查全部通过 Mac 本机 `scripts/verify-openhanako-local.sh`。仓库没有 GitHub CI 工作流；不要恢复或调用 GitHub Actions。
