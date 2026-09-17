# 与 dsh-web 的对比

> 调研对象：[`zhu1090093659/dsh-web`](https://github.com/zhu1090093659/dsh-web)（分支 `dev`，Apache-2.0）。
> 调研时间：2026-09-17。该仓库当时约 **@7600 star / 9068 个文件**，是 DSH Web GUI 的插件生态 monorepo。
>
> 本文记录**路线分歧**与**可借鉴项**。它不是"谁更好"的评判——两者解决的问题不同。

## 一句话

dsh-web 把插件挂到**真实的 DSH 宿主**上，我们是**自建宿主 + WASM 沙箱边界**。
两者都坚持"不改 DSH 源码"，但一个寄生、一个替换。

**我们有一个他们没有的能力**：后加载的插件可以**改造**已有 UI（隐藏 / 重排 / 替换）。
这一条是下面第 3 节的重点。**注意：他们有一个 CSS 层的渲染抑制（移动端隐藏其他插件），
但没有注册表层的调整**——两者的确切区别见第 3 节。

## 1. 路线对照

| | dsh-web | 本项目 |
|---|---|---|
| 插件格式 | TypeScript / ESM（npm 包） | **WebAssembly 模块**（wasm32-wasip1） |
| 宿主 | 寄生：官方 `profile` + `cordis.patch.yml` | **自有宿主**（wasmtime + cordis 桥） |
| 前端 | 浏览器 bundle，注入官方 client 模块系统 | 自带 Slot 注册表，插件 `entry.js` 直接拿 DOM |
| 桌面端 | Electron（内置 Node 运行时） | Tauri 2 |
| 插件加载 | npm install → 重启生效 | 磁盘 `.wasm` + 热重载 + 编译缓存 |
| 隔离边界 | 无（信任的 TS 代码） | 无沙箱，但**天然有 WASM 边界** |
| 槽位类型 | **类型化 `SlotMap`**（module augmentation） | 字符串 + 品牌类型（见第 4 节） |
| 槽位可用性 | 官方 shell **未开放** sidebar slot → MutationObserver 注入 | 自建槽位注册表，无此问题 |
| 多窗口 | **✗ 明确 `action: 'deny'`** | ✓ 插件可开自己的顶层窗口 |

## 2. 相同的核心洞见

两者独立得出了同一结论：**不要改宿主源码**。

dsh-web 的 `packages/AGENTS.md`：

> 只基于官方 NPM SDK……**禁止 tsconfig 指向任何 DSH 源码 checkout**
> …Never modify a DSH source checkout.

我们的是"插件经 ABI 声明能力，宿主解析"。**目的相同：让插件与宿主解耦。**
区别在于我们连宿主本身都换掉了，所以解耦点从 npm 依赖变成了 WASM 导入表。

## 3. 关键差异：改造既有 UI

### 结论：能力存在，但机制与作用面都不同

> **更正记录**。本节第一版写的是"没有任何插件隐藏另一个插件的 UI"，**这个结论下得太满，是错的**。
> 后续复查找到了 `dsh-remote-web-ui` 的实例（见下）。保留这段更正记录，是因为"下满结论"这个错误本身值得记下来。

分两层说，因为答案是**分层的**：

**① 槽位注册层面：确实没有跨插件手术。**
调研对 `dsh-web` 做了穷举：**9068 个路径全部枚举**，并逐个读了 **21 个包的客户端入口**
（`packages/*/src/client/index.ts`、`skins/skin-center`、`scripts/plugin-template`）以及全部 `shared/client/*`。
**没有任何插件在注册表层面隐藏、重排、替换或包裹另一个插件的 contribution。**

它的槽位 API 只有三个动词，没有第四个：

```ts
export interface PluginCardSlots {
  spec?(key: string): unknown                            // 探测：槽位是否存在
  inject(key: string, callback: () => unknown): unknown   // 槽位声明出现时执行 cb
  register(options, component): unknown                   // 加入"我自己的"条目，返回"我自己的" disposer
}
```

`register()` 返回的 disposer **只移除调用者自己的条目**。仓库文档把约束写得很直白：

> external plugins cannot declare slots
> （`shared/client/panel-mount-core.ts` 文件头）

协作是**加法式**的：`inject` → `register` → 自己的 disposer。跨插件协作走 cordis 服务或 slot，**不触碰别人的注册条目**。

**② DOM/CSS 层面：存在，而且很直接。**

`packages/dsh-remote-web-ui/src/client/mobile-adapt.ts` **隐藏了另外六个插件的 UI**：

```ts
// Mobile scope: hide the plugin surfaces that do not fit a phone …
// The list keys on the L2 semantic roots (data-dsh-plugin, ownership stays
// with the declaring plugin), so official class churn cannot resurrect them.
// These are render suppressions: the client bundles still load.
`body.${ACTIVE_CLASS} [class$="_detailsCol"]{display:none !important}`,
`body.${ACTIVE_CLASS} [data-dsh-plugin="ssh"],`,
`body.${ACTIVE_CLASS} [data-dsh-plugin="skill-explorer"],`,
`body.${ACTIVE_CLASS} [data-dsh-plugin="task-board"],`,
`body.${ACTIVE_CLASS} [data-dsh-plugin="git-graph"],`,
`body.${ACTIVE_CLASS} [data-dsh-plugin="pet"],`,
`body.${ACTIVE_CLASS} [data-dsh-plugin="usage"]{display:none !important}`,
```

（注意连官方的详情列也一并隐藏，以及 `[class$="_workbench"]` 那段——它还隐藏了指定 portal 里的官方工作台。）

它的契约文档是 [`packages/skins/skin-center/contracts/semantic-attrs-v1.md`](https://github.com/zhu1090093659/dsh-web/blob/dev/packages/skins/skin-center/contracts/semantic-attrs-v1.md)，
枚举了 15 个 `data-dsh-plugin` 值，每个都注明 **owner、版本、含义与锚定方式**，
并明文写着纪律：**"冲突仲裁纪律：不靠加载顺序"**。

### 机制对比：他们的做法与我们的不同在哪

| | `dsh-remote-web-ui` | 本项目 |
|---|---|---|
| 机制 | **CSS `display:none !important`** | **注册表解析期折叠** |
| 目标识别 | **硬编码 6 个插件名** | **glob**（`from: "noisy-*"`） |
| 新插件能否被识别 | 不能——名字必须进白名单 | 能——`*` 或 `from: "x-*"` 覆盖未来的插件 |
| 依赖插件配合 | **是**——插件必须自愿输出 `data-dsh-plugin` | 否——注册表本就知晓每个贡献 |
| 能做什么 | **只能隐藏** | hide **+ 重排 + 替换** |
| 作用域 | 仅竖屏窄视口（`ACTIVE_CLASS`） | 任意插件、任意上下文 |
| 可逆性 | 移除 CSS 类 | `release(owner)` 同时丢弃调整 |

**所以准确的表述是**：他们有一个**渲染抑制**能力（CSS + 语义属性白名单），
用于移动端降级；我们有一个**注册表级调整**能力（glob 匹配 + 四种动作 + 可逆）。
**两者都是"后加载的插件改造既有 UI"，但我们的覆盖面、可组合性与扩展性都更宽**——
尤其是"重排"和"替换"他们没有,以及他们的白名单意味着**新插件默认不受控**。

### 两处"最接近改造"的地方，但仍不是注册表级

1. **唯一真正的包裹发生在单个插件包裹宿主服务时**，不是包裹同类插件的条目。
   `packages/dsh-git-graph/src/client/auto-isolation.ts` 影子化了共享单例 `workspaces.startSession`：

   > This is a RUNTIME patch of a browser-side singleton, not a source patch: the wrapper
   > shadows the instance method, delegates everything it cannot isolate, and restores
   > the original on dispose.

   它探测形状、失配时降级、dispose 时还原。但这是**一次一个的 SDK 服务 monkey-patch**，
   不是注册表仲裁的同类变更。两个插件同时这么做会**互相抢占，无人仲裁**——
   正是我们的 `SlotRegistry` 用冲突报错解决的那种情况。

2. **DOM 注入核是加法式的，不是改写注册表。**
   `panel-mount-core.ts` 在中央列**追加**一个容器并切换 `<html data-*>`；
   `sidebar-entry-core.ts` **插入**一行并用 MutationObserver 自愈。
   排序只发生在**家族兄弟之间**（`position: 'before' | 'after'` + `familySelectors`），
   即**协作约定**,而非一个插件改另一个插件的条目。
   （唯一的例外是上面 ② 的 CSS 抑制，那是渲染层而非注册表层。）

   顺便：这个文件头承认了他们被迫的妥协——

   > dsh's sidebar shell exposes no slot an external plugin can register into,
   > so the entry row is injected between the shell's New Session button and the
   > workspace browser.

   **这是他们没有槽位可用时的对冲手段。我们有槽位注册表，不需要 MutationObserver。**

3. `dsh-plugin-manager` 切换的是**整个包**，不是 UI 条目，而且**下次重启生效**。

### 我们的做法：在**解析期**调整，而非改 DOM

`ui.adjusts[]`：

```jsonc
{ "slot": "settings.tabs",      "from": "ui-llm-panel", "action": "priority", "to": -100 }
{ "slot": "ui-llm-panel.config", "from": "ui-theme-widget", "action": "replace", "component": "CuratedPanel" }
{ "slot": "*",                   "from": "noisy-*",      "action": "hide" }
```

`slot` / `from` 都是 glob（`*` 通配）。四个动作：`hide` / `unhide` / `replace` / `priority`。

**关键设计：调整在解析期折叠进贡献列表，绝不改别人的 DOM。** 由此白得三个性质：

| 性质 | 为什么 |
|---|---|
| **可组合** | 每个调整是一元函数，按加载顺序折叠；后加载者有最终话语权 |
| **可逆** | `release(owner)` 连同其调整一起丢弃 → UI 回到声明态 |
| **顺序无关** | 调整先于目标到达？目标出现时自然生效（与 claim 同一套规则） |

用 `hide` 而不是"卸载插件"，是因为**隐藏不等于删除**：claim 还在，另一个插件的 `unhide` 可以把它捞回来。

### 诚实的边界

- 调整是**声明式**的（WASM 的 `ui.adjusts`），不能命令式地在运行时改（比如"根据用户操作动态隐藏"）。命令式的话插件可以用 `studio` API 自己开槽位、控 DOM，但不会被注册表仲裁。
- `replace` 只能换成**调整者自己注册的**组件，不能换成第三方组件。
- 调整**不跨窗口**：每个窗口是独立 JS 上下文，各自解析。

## 4. 可借鉴项（已吸收 / 待吸收）

### 已吸收

**① 类型化槽位名。** dsh-web 用 module-augmented `SlotMap`：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'web-ui.plugin.item': { kind: 'list'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
  }
}
```

**但这套不能照搬**：他们的插件是 TS，编译进同一个 program，槽位名是**编译期常量**；
我们的插件是 WASM，槽位名是**运行时数据**。所以照搬只会得到假的安全感。

**我们采用品牌类型**，只给编译期已知的部分上类型：

```ts
export type PluginSlotName = string & { readonly [PLUGIN_SLOT]: true };
export type SlotName = BuiltinSlot | PluginSlotName;
export function pluginSlot(name: string): PluginSlotName;  // 显式逃逸口
```

**已验证非空转**：把 `<Slot slot="sidebar.items" />` 写成 `"sidebar.item"`，`svelte-check` 报

```
Type '"sidebar.item"' is not assignable to type 'SlotName'. Did you mean '"sidebar.items"'?
```

（第一版用 `string & {}` 做逃逸口，结果**拼错也不报**——那是个装饰性类型。品牌类型才真正拦住。）

### 待吸收

**② 失败隔离策略。** dsh-web 的立场是好的：

> DOM mounting problems are logged, never thrown — the web shell fails the whole
> boot when a plugin apply throws.

他们的 `apply-guard.ts`（43 行）用 `globalThis` 上的标志做**双源加载防重**：

```ts
export function claimTaskboardApply(): boolean {
  if (globalThis.__dshTaskboardApplied === true) return false
  globalThis.__dshTaskboardApplied = true
  return true
}
```

标志放在 `globalThis` 是为了让**两个模块实例**（陈旧 bundle + 重建 bundle）共享一个守卫。
我们目前没有等价的"同一插件双源加载只注册一次"保护——`mount-once.ts` 那类机制值得补。

**③ 三层文档纪律。** 根 `AGENTS.md` / `packages/AGENTS.md` / 包级 `AGENTS.md`，
且明文规则 **"Keep each fact in its owning document"**。我们的 `docs/` 目前是平铺的。

**④ i18n 门禁。** `pnpm i18n:check` 做 zh/en/ru key 对齐，并**禁止客户端文案里出现注释外的 CJK**。
我们的 UI 文案是混排中英，没有门禁。若要国际化，这是现成的做法。

**⑤ 构建产物 + fingerprint 门禁。** 四个包把 `lib/` 提交进仓库，并用
`scripts/lib-artifact-fingerprints.json` 校验。我们没提交产物（更干净），但若将来需要
"零构建安装"，这是参考。

## 5. 不值得照抄的

| 他们的做法 | 为什么不适合我们 |
|---|---|
| MutationObserver 自愈注入 | 他们是**没有槽位可用**时的对冲；我们的槽位注册表直接解决了这个问题。引入只会在我们这边制造竞态 |
| 寄生官方 profile | 他们的产品前提是"用户已经在跑 `dsh web`"。我们是完整替代品 |
| Electron + 内置 Node | 我们选 Tauri 是为了体积与权限模型；内置 Node 运行时与 WASM 沙箱边界相悖 |
| 类型化 `SlotMap` | 见第 4 节①——前提（编译期槽位名）在我们这里不成立 |

## 6. 结论

**架构分歧是真实的，不是同一件事的两种写法。**
dsh-web 在既有宿主上做加法生态；我们在自建宿主上做可编排的插件系统。

**我们的 UI 改造层在注册表层面领先**：他们有 DOM/CSS 层的渲染抑制（6 个硬编码插件名，
仅移动端，仅隐藏），我们有 glob 匹配的四种动作（隐藏/重排/替换/恢复）、
任意作用域、可逆、且新插件自动被覆盖。

**但第一版结论下得太满，已更正**（见第 3 节开头的更正记录）：
"改造既有 UI"这件事**不是不存在的**，只是他们做在渲染层、我们做在注册表层。
这个区别是真实的，但"独有"这个词用得不准确。

**最值得学的不是架构，是工程纪律**：失败隔离的明确立场、防重加载、文档归属、i18n 与产物的 CI 门禁。
这些与路线选择无关，任何规模的项目都受用。
