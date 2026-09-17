# dsh-rs 扩展面审计

> 回答一个问题：**"任意介入 dsh-rs 流程"的天花板在哪？**
> 依据：`dsh-rs 0.2.0` 与 `dsh-plugin-contract 0.2.0` 的源码（只读审计）。
>
> 结论先行：**上限是 dsh-rs 暴露了多少点，不是我们的桥接。**
> 我们今天接了 3/6，缺的 3 个里 `llm/stream` 最关键。

## 1. dsh-rs 的全部扩展面（封闭集合）

穷举 `dsh-rs-0.2.0/src/` 里所有 `.waterfall(` 调用，得到 **6 个可 veto/rewrite 的点**：

| # | 事件名 | 位置 | 我们接了吗 |
|---|---|---|---|
| 1 | `tools/pre-execute` | `tools/registry.rs:157` | ✅ |
| 2 | `agent/pre-step` | `core/loop_driver.rs:116` | ✅ |
| 3 | `agent/request` | `core/loop_driver.rs:388` | ✅ |
| 4 | **`llm/stream`** | `llm/runtime.rs:238` | ❌ |
| 5 | **`tools/execute`** | `tools/registry.rs:197` | ❌ |
| 6 | **`tools/post-execute`** | `tools/registry.rs:232` | ❌ |

外加一个**只读**的 `session/event` 洪泛（`ctx.emit`，非 waterfall）—— 我们已接（见
`dsh-wasm-host/src/bridge.rs` 的 `install_observe`），但 observe 改不了流程。

**关键事实**：dsh-rs **没有"新增 waterfall 点"的机制**。
宿主没 dispatch 的步骤，任何插件都伸不进去。
所以"字面意义的 100% 任意节点"**做不到**——这不是我们的桥接不够，是宿主没开那个口。

## 2. 缺的三个点各自意味着什么

### `llm/stream` —— 缺口中最重要的一个

```rust
// dsh-rs/src/llm/runtime.rs:238
.waterfall("llm/stream", payload, move |payload| {
    // 整个 LLM 调用发生在这个 fallback 里
    let stream = runtime.stream(options).await?;
    Ok(json!({ "stream_id": streams.insert(stream) }))
})
```

fallback 里发生的是**真正的 LLM 调用**，而 waterfall 可以整体替换它
（包括自己 `insert` 一个流进 `StreamTable`）。所以接上后，一个 WASM 插件可以：

- 改写送往模型的 prompt / temperature / stop；
- 完全替换 provider（走自己的实现）；
- 缓存/重放、注入内容。

**这是比"否决一次工具调用"深得多的能力。**

### `tools/execute` —— 包裹工具实体的执行

```rust
.waterfall("tools/execute", execute_payload, move |payload| {
    // terminal continuation 跑真正的工具体
    let result = (tool.execute)(args, run_ctx).await;
})
```

它夹在 `pre-execute`（允许/拒绝门）与 `post-execute`（结果改写）**之间**，
可改 `arguments` 后放行、或完全不跑工具体。等于"能篡改工具拿到的参数"。

### `tools/post-execute` —— 改写工具结果

```rust
.waterfall("tools/post-execute", post_payload, |payload| {
    // 返回的 payload 决定最终 result
})
```

对"插件规范化/脱敏工具输出"很有用。

## 3. 比 waterfall 更深的一层：服务（我们基础设施已在，但没往上接）

waterfall 是"介入一次调用"；**cordis 服务是"替换整条路径"**。dsh-rs 暴露：

```rust
// dsh-rs/src/api/services.rs
LlmService::register_adapter / unregister_adapter   // 换整个 LLM wire adapter
ToolsService::register_dynamic_tool                 // 原生注册工具
LlmService / SessionsService / SystemPromptService / AgentsService / LlmStreamsService
SessionPersistenceService / ManifestService         // 全可 provide
```

**我们的桥已经在做这件事**：`dsh-wasm-host/src/plugin.rs:245` 的
`ctx.provide(svc, handle)` —— WASM 插件声明 `provides` 就会以 cordis 服务的身份出现。

所以"一个提供 `llm` 服务的 WASM 插件 = 整个 LLM 路径归它"这条路**已经铺好**，
只差把它接到 `LlmService` 这类具体 trait 上。

## 4. dsh-rs 没有权限层

`grep -rn permission dsh-rs/src/` 只命中 **1 行，且是注释**。dsh-rs 没有 permission 概念。

含义：

- 插件拿到的是**无条件**介入能力（能否决任何工具、接上 `llm/stream` 后能改写模型输入）；
- 这与本项目既定的"可信插件、最大权限"一致（见 [`已知问题.md`](已知问题.md) §1.1），
  **不是缺陷**；
- 但**接 `llm/stream` 时应同时做可见性**：静默改写送往模型的内容，比劫持工具有更严重的
  可观测性问题。§3.6 那种"静默胜出"在这里会更糟。

## 5. 建议顺序（按每单位风险的收益）

| 顺序 | 做什么 | 成本 | 收益 |
|---|---|---|---|
| ① | 流程补满 **3/6 → 6/6** | 小、纯增量 | `llm/stream` 解锁最深的介入面 |
| ② | 服务深接（`LlmService` / `tools`） | 中 | 比 waterfall 更彻底的替换能力 |
| ③ | 前端：`nav` 槽位 + 路由 catch-all | 小 | 兑现"插件贡献菜单/页面" |
| ④ | 主题：写测试证明可覆盖 | 极小 | 见 [`前端可塑性.md`](前端可塑性.md) |

① 与 ② 是"任意介入流程"，③ 与 ④ 是"任意修改前端"。

**注意**：接 `llm/stream`（①）与深接服务（②）会显著放大插件权力。
在"可信插件"前提下可接受，但**每次放大都应同时补可观测性**。

## 6. 不要做的事

- **不要**假设能"100% 任意"：6 个点是封闭集合，没有新增机制。
- **不要**为了追 dsh-web 而把主壳插件化——见 [`对比-dsh-web.md`](对比-dsh-web.md)：
  他们自己也没这么做（Chat/侧栏始终是宿主 React，插件靠 CSS 打补丁）。
