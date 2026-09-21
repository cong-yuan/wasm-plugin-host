# wasm-plugin-host — 文档索引

> 一个 **dsh 风格的 WASM 插件宿主**:插件在运行时加载/卸载/热更新,能**介入 agent 流程**
> (observe / rewrite / veto),并通过 **inject/provide 服务图**互相依赖、自动收敛。
> Rust 核心 + `wasmtime`,插件可用任意能编译到 WASI 的语言编写。
>
> 另有一个独立 crate **[`dsh-wasm-host`](../dsh-wasm-host)**:把本宿主**组合进**
> 真实的 [`dsh-rs`](https://crates.io/crates/dsh-rs) agent harness —— WASM 插件成为
> 一等参与者,由 dsh 真实 agent loop 驱动。

---

## 文档导航

| 文档 | 内容 | 读者 |
|---|---|---|
| [**需求.md**](需求.md) | 这个项目**要解决什么**、为什么这么设计、边界在哪 | 所有人,先读这个 |
| [**架构.md**](架构.md) | 分层结构、模块职责、关键数据结构、数据流 | 要改代码的人 |
| [**ABI.md**](ABI.md) | 插件契约 v1:导出/导入、声明 JSON、钩子、服务、配置、日志 | **写插件的人** |
| [**使用指南.md**](使用指南.md) | 从零构建、跑 demo、写第一个插件、嵌入 Tauri | 上手的人 |
| [**进度.md**](进度.md) | 已完成 / 进行中 / 未开始,以及每项的验证状态 | 想知道进度的人 |
| [**计划.md**](计划.md) | 下一步做什么、优先级、每项的验收标准 | 决定做什么的人 |
| [**已知问题.md**](已知问题.md) | 短板、坑、设计取舍、为什么不做某些事 | 踩坑前先读 |
| [**测试.md**](测试.md) | 151 个测试逐个说明验证了什么 | 改代码怕改坏的人 |
| [**对比-dsh-web.md**](对比-dsh-web.md) | 与同方向成熟项目 `dsh-web` 的路线分歧、可借鉴项 | 想知道"我们和别人比怎么样"的人 |
| [**借鉴-dsh-web-模式.md**](借鉴-dsh-web-模式.md) | 从 `dsh-web` 提炼的可迁移工程模式(防重/disposer/i18n/测试) | 想改 DX 的人 |
| [**路线图-功能复刻.md**](路线图-功能复刻.md) | 用 WASM 插件复刻 dsh-web 功能面的差距分析与顺序 | 决定做什么的人 |
| [**dsh-rs-扩展面.md**](dsh-rs-扩展面.md) | dsh-rs 到底开了几个可介入的点、我们接了几个、天花板在哪 | 想扩介入能力的人 |
| [**前端可塑性.md**](前端可塑性.md) | 前端现在能改到什么程度、还缺什么、哪些不用做 | 想改前端的人 |
| [**仿照-dsh-web-外壳.md**](仿照-dsh-web-外壳.md) | dsh-web 的外壳布局与插槽注册契约(插槽纪律的来源) | 想懂槽位设计的人 |
| [**仿照-openhanako-外壳.md**](仿照-openhanako-外壳.md) | HanaAgent 的外壳布局、17 个槽、拖曳调整尺寸、视觉语言 | 想懂当前外壳的人 |

---

## 30 秒总览

```
┌────────────────────────────────────────────────────────────┐
│  Supervisor   配置文件(desired state) + notify 文件监听      │
├────────────────────────────────────────────────────────────┤
│  Flow         run_turn:插件可以介入的 agent 循环             │
├────────────────────────────────────────────────────────────┤
│  Registry     slot · 原子热更新 · hooks · 服务收敛           │
│  Hooks        事件订阅 + waterfall(observe/rewrite/veto)     │
│  Services     inject/provide + 响应式收敛 + 跨插件调用        │
├────────────────────────────────────────────────────────────┤
│  Plugin       生命周期 + tools + hooks + 配置                │
├────────────────────────────────────────────────────────────┤
│  Runtime      编译缓存(内存 + 磁盘 .cwasm)· 池化分配 · WASI │
│  Pipe/State   有界日志 + 级别过滤 + stdout/stderr 捕获         │
└───────────────────┬────────────────────────────────────────┘
                    │ wasmtime 44
      ┌─────────────┼─────────────┬──────────────┐
      ▼             ▼             ▼              ▼
  hello-rust    hello-go     plain-rust       (未来)
   .wasm         .wasm        .wasm        js / python
```

## 核心能力速查

| 能力 | 一句话 | 入口 |
|---|---|---|
| 热更新 | 重编译覆盖 `.wasm`,运行中的进程**原子**换掉 | `Registry::reload` / `Supervisor` |
| 坏构建安全 | 新构建先校验,失败则**旧插件继续跑** | `Registry::reload` |
| 流程介入 | 插件订阅事件,可 observe / rewrite / **veto** | `Registry::dispatch` |
| 服务收敛 | provider 出现 → consumer **自动激活**(级联) | `Registry::converge` |
| 跨插件调用 | 按服务名调另一个插件,重入安全 | `host.call_service` |
| 配置注入 | 配置进插件;改了**只更新变了的那个** | `Supervisor::poll_changes` |
| 通用日志 | 捕获 WASI stdout/stderr,任何语言零胶水 | `pipe::LogPipe` |
| 日志级别过滤 | `log_level` 丢弃阈值下记录 | `Registry::set_log_level` |
| 并行调用 | 不同插件并行,同插件串行 | `Registry::call_many_parallel` |
| 磁盘编译缓存 | `.cwasm` 冷启动 ~36x 加速 | `Runtime::new_cached` |
| 配置校验 | 坏配置精确到字段一次报出 | `Config::validate` / `--validate` |
| dsh 组合 | WASM 插件进 dsh 真实 agent loop | `dsh-wasm-host` crate |

## 现状(一句话)

**功能完整度 ~95%**:插件生命周期、热更新、流程介入、服务图、配置、日志、并发、磁盘缓存、
配置校验、dsh 组合全部完成且有测试(123 个,全绿,零警告)。
**唯一硬缺口**:没有能力/权限模型(仍是完整 WASI,不能安全跑第三方不可信插件)。

详见 [进度.md](进度.md) 与 [已知问题.md](已知问题.md)。

## 快速命令

```sh
cd ~/wasm-plugin-host

# 构建宿主
cargo build --release

# 构建某个插件(Rust)
cargo build --release -p hello-rust --target wasm32-wasip1

# 跑测试(全部)
cargo test --release

# 交互式宿主
./target/release/plugin-host

# 指定配置 + 监听文件
./target/release/plugin-host --config demo/live.json
./target/release/plugin-host --config demo/live.json --supervise

# 示例
cargo run --release --example intervene   # 插件 veto 流程
cargo run --release --example services    # 服务收敛 + 跨插件调用
cargo run --release --example parallel    # 池化分配 + 并行调用
```

## 目录结构

```
wasm-plugin-host/
├── README.md              总览(英文,面向使用者)
├── docs/                  本目录:中文文档全套
├── host/
│   ├── src/
│   │   ├── lib.rs         库入口 / 导出
│   │   ├── main.rs        CLI(REPL + daemon)
│   │   ├── config.rs      配置 schema
│   │   ├── state.rs       HostState + 有界日志 (LogRecord/LogSink)
│   │   ├── pipe.rs        WASI stdout/stderr → 日志
│   │   ├── plugin.rs      插件实例 + 生命周期 + ABI 调用
│   │   ├── runtime.rs     引擎 / 编译缓存 / 池化 / host.* 导入
│   │   ├── service.rs     服务仓库 + 收敛词汇 + 重入保护
│   │   ├── hooks.rs       事件订阅 + waterfall 分发
│   │   ├── registry.rs    管理面:slot / 工具 / 钩子 / 服务 / 热更新
│   │   ├── flow.rs        最小 agent 循环(可被介入)
│   │   └── supervisor.rs  配置文件收敛 + notify 监听
│   ├── examples/          intervene / services / parallel
│   └── tests/hotreload.rs 32 个集成测试
├── plugins/
│   ├── hello-rust/        Rust 示例(工具 + 配置 + 日志)
│   ├── hello-rust-v2/     用于热更新演示(输出不同)
│   ├── plain-rust/        纯 println! 演示(无胶水)
│   └── hello-go/          Go 示例(fmt.Println 即日志)
└── demo/                  4 个可跑脚本 + 若干配置样例
```

## 名词表

| 术语 | 含义 |
|---|---|
| **slot** | 插件的**稳定身份**(如 `greet`),热更新时目标不变,即使插件内部改名 |
| **hook / 钩子** | 插件对**流程事件**的订阅(`agent/pre-step` 等) |
| **waterfall** | 一种钩子模式:订阅者链条式传递,可改写或否决 |
| **service** | 插件声明提供/需要的**能力名**(如 `kv`),不绑定具体实现 |
| **converge** | 反复计算"谁该 active",直到稳定;provider 出现会自动激活 consumer |
| **effect** | 插件注册的一切(tool/hook/service);卸载时自动回收 |
| **quiescent** | 已加载但 inject 未满足,effects 未注册的"待命"状态 |
