# 2026-10-09 — 会话视图交互与待办清单修复

## 三个回归点

1. **「清单列表」右上角缺失**：以前 Hana 将部分 todo 从 assistant tool-call 参数反推，但 Studio 实际持久化的是 `SessionEventData::TodoWrite` 独立快照。没有 assistant 工具消息时旧兼容层会得到空数据。新增只读原生 `session_todos`，从真实 Session Event 按序取最后一次 TodoWrite，包括明确清空；OpenHanako 的会话 hydrate 优先使用原生快照（老宿主回退工具历史），实时轮询按版本发 `todo_update`。右上角新增窄型「清单 n/N」展开卡，复用同一 keyed 会话状态，原右侧 `SessionTodoCard` 保持可用。待办完成按钮复用已有 `completeSessionTodos`，运行中禁止重入。
2. **「对话／轨迹」被覆盖无法点击**：旧标签写在有 48px/底部 padding 的 `.chat-area` 静态文档流里，实际的 `.sessionShell` 是 `position:absolute;inset:0`，因此按钮 z-index 未生效、消息层截获点击。现在标签栏自己是 `position:absolute`、z-index 高于 `.sessionShell`，轨迹面板使用独立绝对定位 inset 和 `role=tabpanel`；Chat 仍保持原会话滚动布局及输入区。
3. **样式不符合 OpenHanako**：去掉突兀横跨聊天全宽的独立导航条。小型双栏浮动滑块、图标和 `--accent`、`--overlay-subtle`、`--bg-card` 等现有样式变量与右侧工作区的 tabs 风格对齐。窄屏时标签靠左避免与右上清单冲突，切换支持键盘方向键，清晰保留选中态与焦点指示。

## 验证

- Studio Rust todo projection：`todo/write` 的 in_progress、completed、明确清空、不存在记录；真实 Studio 持久化完成后重新读取。
- JS bridge：待办列表可从单独 `todo/write` 快照恢复，老宿主仍能 fallback；实时 `todo_update` 走同一原生版本。
- React：聊天/轨迹 in-column tabs、键盘切换、无残余聊天覆盖层；右上 checklist 自动出现、展开/关闭、归属隔离和动作互斥。
- 本机开发服务热更新并执行 `scripts/verify-openhanako-local.sh`；不运行 GitHub CI。

## 第二轮 UI 收敛

- 不再添加右上角清单：删除 `SessionTodoPeek`，只在原有右侧「进程」`SessionTodoCard` 渲染，同一 keyed 会话状态。原生 `/api/sessions/todos` 读取 Session Event 快照，守护版本号/异步回包；手动完成保留 completed 清单，而非清空。
- Studio 连接状态移至顶栏聊天/频道 tab 旁的单词级提示；会话顶部恢复给视图切换和正文使用。
- 轨迹时间轴改为点击柱状事件 + 起点/终点两独立滑杆（含键盘操作），不再通过跨工具色块拖框；Turn 标题增强层级并 sticky，详情元信息显示紧凑芯片而非 9 行 definition-list。
