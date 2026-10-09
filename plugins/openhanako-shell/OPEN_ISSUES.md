# OpenHanako + Studio 当前未闭环事项

> 2026-10-09 本机只读审计后整理。此清单记录“Studio 原生能力”和“完整 Hana Server 可用能力”的差异；不把原生桥接未覆盖误报为上游 Hana 功能不存在。`DEVELOPMENT.md` 中早期 Phase 段落属于历史实施记录。本仓库**不启用 GitHub CI**。

## P0 — 先保证用户可用与回归可信

| 编号 | 状态 | 验收标准 |
|---|---|---|
| C01 Studio WASM tool approval 集成回归 | **已修复** | 真实模型回合要求显式单次审批；批准后调用工具，拒绝时不执行；`cargo test --test studio` 通过。审批超时/取消由 runtime_controls 单元测试维护 |
| C02 断线后的实时回复恢复 | 未完成 | `resume_stream` / `stream_resume` 根据明确 stream ID / 会话回传有序缺失事件，不重复完整消息；取消/并发场景校验 |
| C03 文字与工具历史交错时间线 | **已改善，继续完善事件级续放** | Rust 按持久化 ContentBlock 顺序投影 Text/Reasoning/ToolCall；独立 Shell 可重载完整历史、逐轮折叠并展开参数/结果。SessionEvent 级流序号/断线补帧仍与 C02 一起处理 |
| C04 安装版 Studio 端到端验收 | 未验收 | 在真实 macOS app 验证 Shell 沙箱允许授权命令、拒绝越权、工具审批、项目及会话重启恢复、实际定时执行；不能用编译测试代替 |
| C05 自动化最终 Agent 工作状态 | 部分完成 | 区分 queued/dispatched、Agent completed/failed/cancelled，恢复后不伪造成功或强制重放 |

## P1 — 功能集成

| 编号 | 状态 | 验收标准 |
|---|---|---|
| C06 Studio 退出后自动化执行 | 未实现 | 需要单独系统调度服务和明确安装/卸载/进程边界；当前只在 Studio 活跃时运行 |
| C07 每任务模型和插件执行器 | 未实现 | 真正应用 Job-scoped model/executor 并持久回显；未支持的参数仍应拒绝而非 soft-ack |
| C08 IANA 时区/DST | 未实现 | 使用时区 ID 和 DST 规则；当前仅保留创建任务时的固定 UTC offset |
| C09 pending 上传附件归属 | 未完成 | 新会话创建后将 pending 文件明确关联到 session，不泄露跨会话文件、不丢失临时附件 |
| C10 MCP/Connectors Studio 原生集成 | 未全面接通 | 在 Studio 模式下实现/声明实际对应的 connector lifecycle、工具执行和持久化，不只使用 Hana Server API |
| C11 Channels/DM Studio 原生集成 | 未全面接通 | 本机 Studio 提供真实通道、DM 生命周期和事件；Hana Server 模式已自有相关逻辑 |
| C12 Browser/音视频/媒体原生集成 | 未全面接通 | 浏览器会话及异步媒体生成在 Studio 有可验证的 API/任务处理，避免只显示 Hana 页面 |
| C13 本地设置与宿主状态统一 | 部分完成 | 区分真实原生设置和 user/模型 metadata 的 localStorage overlay；迁移有版本/回滚/冲突策略 |

## P2 — UI 一致性与增强

| 编号 | 状态 | 验收标准 |
|---|---|---|
| C14 独立手写 Shell 入口 | 部分完成 | sidebar automation 与 conversation Memory/permission 按原生 capability 开关，成功操作须真实 ACK；目前相关入口直接 disabled |
| C15 自动语义 Memory | 未实现 | 如果要实现，须显式 opt-in、可信来源、删除和可审计语义抽取；当前仅抓取用户明确“记住：”指令 |
| C16 旧项目目录冲突合并 | 未实现 | native catalog 非空时先预览差异、明确确认再 CAS 合并；目前 fail-closed 拒绝覆盖 |
| C17 扩大自动化测试覆盖 | 部分完成 | 当前本地验证包含 Studio 单元+集成和少量 React 目标用例；完整 React 大测试集应另行分批本机执行、记录 flaky/环境依赖 |

## 开发与发布原则

1. 用户请求批量开发时，多项关联功能完成并经本机测试后各仓库一次 Commit/Push；不得恢复 GitHub Actions workflow。
2. P0 集成回归 `C01` 要保留明确审批测试；任何测试都不得为“快速通过”而把生产 `ask` 默认改成 `auto`。
3. 旧版宿主缺原生命令时必须 `capability_unavailable`；Hana Server 已拥有的能力不可直接冒充 Studio 原生完工。
4. 保留用户个人/历史备份数据。大体积 build/target 目录可作为生成物清理；未跟踪用户文件只可经过可恢复归档再移出仓库。
