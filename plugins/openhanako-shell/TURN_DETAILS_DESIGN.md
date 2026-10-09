# 会话逐轮过程展开：DeepSeek Harness 参考与 OpenHanako 实现

## 参考项目

- DeepSeek Harness： https://github.com/deepseek-ai/deepseek-harness
- UI Chat 概要： https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/README.zh.md
- 前端过程控件真实源码： https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx
- 设置持久化源码： https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-chat/src/client/transcript-view.ts
- 基础 Session Event： https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md

从 DeepSeek Harness 的公开实现文档和真实 `TurnProcessNodeView` / `TranscriptViewPolicy` 源码借鉴 **Compact / Normal、已完成轮次的过程折叠、最终正文单独显示、没有最终回复时保留过程、历史由有序事件重建** 的设计原则。这里只参考交互模型，没有引入或复制它的前端源代码。

## 职责分离

| 层 | 职责 | 代码 |
|---|---|---|
| Rust / Studio | 读取可持久化 Session Event 与 Assistant Message 的 Text/Reasoning/ToolCall 顺序，按块生成 `streamTimeline`，原有文本、工具结果、时间仍保留 | `dsh-wasm-studio/src-tauri/src/studio.rs` |
| JS / Studio API | 保持原生 transcript 的有序 `streamTimeline` 原样通过 API；如宿主较旧则接受缺失字段 | `js/lib/api.js` |
| JS / 独立 Shell | 每条 User 后划分轮次，折叠历史过程，保留纯文本 Assistant 最终回复，显示 reasoning、工具名称/参数/结果/状态/时长，支持每轮独立展开及 Compact / Normal 全局偏好 | `js/panels/conversation.js`, `js/style.css` |
| React / Hana 页面 | 已存在 `ProcessFoldBlock` + `process-fold.ts` 的轮次折叠能力，不重复创建一套脱离 React 的组件 | `ui/desktop/src/react/components/chat/` |

## 边界条件与安全规则

- 默认 Compact；每轮只在存在单独纯文本最终回复时折叠之前的过程；**工具调用消息不可冒充最终答案**。未形成明确最终回答的轮次保留展开，不隐藏重要内容。
- 仍在执行中的轮次默认展示过程；每轮用户手动展开状态保存在当前 Shell 生命周期内，切换会话/刷新权威 transcript 不清除同一轮的选择；Compact / Normal 模式保存在本机用户偏好。
- 工具参数、返回均作纯文本插入 DOM，不执行 HTML；显示文本上限 24,000 字符并有截断提示。工具结果按各 User 轮次作用域关联，重复 call ID 也不得跨轮混淆。
- Rust 原生 transcript 通过持久化的 `ContentBlock` 顺序保留块序列，老宿主/缺少 timeline 时保留原有退化展示；本次没有实现任意网络断开后的完整 `resume_stream` 事件缺口回放，也没有补齐独立的 provider token 统计。
- 后端持久化块中不包含事件级别的每个 delta 时序；这里恢复 **Text/Reasoning/ToolCall 的内容块顺序**，不宣称对整个 SessionEvent 流做完备的增量断线续播。

## 本机验收

1. Rust `durable_transcript_preserves_text_tool_text_content_block_order` 和真实 WASM 工具回合检验原生投影。
2. Shell DOM smoke 覆盖多轮默认折叠、无最终回复时不隐藏过程、工具详情、重复 call ID 隔离、手动展开与重新加载、Normal 模式。
3. `scripts/verify-openhanako-local.sh` 只在 Mac 本地执行 Rust 单元/集成、JavaScript/React、TypeScript 和 Renderer 构建；**不启用 GitHub Actions CI**。

正式安装版 Studio 的 GUI 人工验收、任意 websocket reconnect 的准确事件重放仍单列待办。
