# 借鉴 — dsh-web 的插件工程模式

> 来源：对 `zhu1090093659/dsh-web`（分支 `dev`）的只读调研。
> 样本是以 `packages/dsh-task-board/` 为代表的完整功能插件。
>
> 本文只记录**可迁移的模式**。哪些该抄、哪些不该，见 [`对比-dsh-web.md`](对比-dsh-web.md)。

## 0. 为什么看它

`dsh-task-board` 是他们最完整的插件：host/client 双半区、设置卡、i18n、遥测、自愈 DOM 注入、40 个测试文件。
它的结构回答了"一个功能插件从声明到卸载要经过哪些层"。
**我们的插件目前是"一个 wasm 里塞一段 JS 字符串"，DX 差得远。这份笔记是补齐 DX 的参考。**

## 1. 三层分区（host / client / core）

```
packages/dsh-task-board/src/
  index.ts           host 半区（运行在宿主进程）
  core/              ★ 两侧共享的纯逻辑（两侧都编译）
    controller.ts, store.ts, tasks.ts, schedule.ts, freeze-snapshot.ts
    use-cases/       task-create.ts, task-update.ts, task-archive.ts, …
  client/            browser 半区（Web GUI 侧）
    index.ts         apply() 入口
    board/           视图组件（TaskBoard.tsx, TaskCard.tsx, …）
    *_core.ts        共享注入核的生成副本
  host/              host 侧辅助（run-guarded.ts）
```

**规则**：新增源文件必须落在这三区之一。
`src/core/` 是"能在浏览器和宿主进程两侧都跑"的纯逻辑——**这是关键**：
任务的状态机、调度计算、快照冻结都在 core，所以两侧共用一个真相源，测试也只测一遍。

**对我们的启示**：我们的 ABI 已经是"插件声明 + 宿主解析"，
但**缺一个 core 概念**——即"插件想在宿主侧和前端侧共享的逻辑"。
目前插件要么写 Rust（宿主侧），要么写 `entry.js`（前端侧），中间没有共享层。

## 2. 失败隔离：这是最该抄的一条

他们的立场写得很硬：

> DOM mounting problems are logged, never thrown — the web shell fails the whole
> boot when a plugin apply throws.

`client/apply-guard.ts`（全文 43 行）的实质是一个 **`globalThis` 上的双源加载防重标志**：

```ts
declare global { var __dshTaskboardApplied: boolean | undefined }

export function claimTaskboardApply(): boolean {
  if (globalThis.__dshTaskboardApplied === true) return false
  globalThis.__dshTaskboardApplied = true
  return true
}
export function releaseTaskboardApply(): void {
  globalThis.__dshTaskboardApplied = undefined
}
```

**为什么放 `globalThis`**：让**两个模块实例**（陈旧 bundle + 重建 bundle，例如
`dsh web` 重启后）共享同一个守卫。`release` 放在 fiber unload，所以热重载能重新认领。

`apply()` 的结构：

```ts
ctx.effect(() => releaseTaskboardApply, 'task-board: apply claim')
if (!claimTaskboardApply()) return
try {
  disposers.push(mountSidebarEntry(controller, ctx.locale))
  disposers.push(mountBoard(controller, ctx.locale))
} catch (error) {
  console.error('[dsh-task-board] mount failed:', error)   // 降级，不抛出
}
```

**他们的失败策略是"处处 fail-open"**：设置卡在命名空间加载中时什么都不渲染、
未暴露时渲染解释性卡片；`subscribeBodyMutations` 吞掉抛错的订阅者
（*"One subscriber must never break the others"*）；
`body-mutations.ts` 在没有 DOM 时返回 no-op disposer。

**对我们的启示**：我们的 `PluginHost` 已经在 `runEntry` 里 try/catch 了 `entry.js`，
但**缺两样**：
1. **双源加载防重**——同一个插件从两个路径被发现时，可能注册两遍；
2. **批量容错**——一处挂载失败不应中断其余贡献的挂载。

## 3. 生命周期：`ctx.effect(fn, label)` 是唯一姿势

**没有临时清理代码**，只有一种模式：注册一个 disposable，
其返回值就是 disposer，fiber 卸载时自动调用。

```ts
ctx.effect(() => releaseTaskboardApply, 'task-board: apply claim')
ctx.effect(() => () => { settingsCard.dispose() }, 'task-board: settings card')
ctx.effect(() => {
  try { return ctx.locale.register(NS, { zh, en }) } catch { return () => {} }
}, 'task-board: dictionaries')
```

槽位条目**自清理**：`register()` 返回的 `unregister` 从 `inject` 回调返回，于是随 fiber 一起消亡。
控制器的 dispose 也在同一个闭包里。

聚合式 teardown 长这样：

```ts
uiDisposer = () => {
  for (const dispose of disposers.splice(0)) dispose()   // workspaces.subscribe, ctx.on(...), mounts
  controller.dispose()
  uiDisposer = undefined
}
```

一个细节：`dsh-pet` 用 `uiDead` 终止标志，防止
"被接管或已 dispose 的实例被迟到的设置回调重新挂载"（issue #785）。

**对我们的启示**：我们的 `PluginHandle.dispose()` + `SlotRegistry.release()` 已经是等价物，
但**没有 label**（他们的 `'task-board: settings card'` 让日志可读）。
我们的 disposer 是匿名的，出问题时不知道是谁的。

## 4. 类型化槽位：为什么我们不能照搬

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'task-board': TaskBoardKey }

  interface SlotMap {
    'web-ui.plugin.item': { kind: 'list'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
  }
}
```

形状是 `{ kind, scope, owner }`：
- `kind`：`'list'`（多个、有序）或 `'keyed'`（按 key 分发）
- `scope`：响应式域，`'root'` / `'session'` / `'session-maybe'`
- `owner`：渲染器传给贡献者的 props，通常为空（`{ children?: never }`）

注册是"先探测再贡献"，`inject(key, cb)` 的回调**只在槽位声明出现时触发**：

```ts
slots.inject('settings.plugin.item', () => {
  try {
    return slots.register({ name: 'settings.plugin.item', id: 'pet', order: 130, … }, PetSettingsSection)
  } catch (error) { warnRefusedSeat('settings.plugin.item', error); return () => {} }
})
```

注意 `register()` 在槽位未声明时**抛错**，所以他们一律用 `inject` 包一层。

**为什么我们不能照搬**：他们的插件是 TS，编译进同一个 program，
槽位名是**编译期常量**；我们的插件是 WASM，槽位名是**运行时数据**。
照搬只会得到假的安全感。

**我们采用的替代**（已实现，且已验证非空转）：
品牌类型 + 内置槽位联合，见 `src/lib/slots.ts` 的 `SlotName` / `pluginSlot()`。

## 5. 设置卡三件套

`shared/client/settings/` 是**三文件切片**，经 `scripts/sync-shared.mjs` 镜像进 7 个消费包
（带 generated 头注释，`--check` 是 CI drift 门禁）：

1. `settings-form.ts` — 暂存式表单模型
2. `PluginSettingsCard.tsx` — 外观：折叠头、控件、保存/放弃底栏
3. `settings-card.module.css` — 样式

外加第四个共享文件 `plugin-card-seat.ts` 做座位分发。

核心是 `CardForm<TKey>`：**在一次原子 `scope.mutate(ops)` 里写入所有编辑**，
然后从落定后的快照读回判定（`landedSet`/`landedUnset`）——
因为"0.1.2 的 scope 约定**永远不拒绝**被拒绝的变更"。密钥只靠"落定"来判定。

注册调用：

```ts
const binder = ctx.get('webUiSettings') ?? ctx.settingsScope      // 兼容层或官方 scope
const settingsScope = binder.bind<TaskBoardSettings>({ namespace: TASK_BOARD_NS })
const settingsCard = new TaskBoardSettingsCardController(settingsScope)
installPluginCard(ctx, {
  namespace: TASK_BOARD_NS, id: 'task-board', order: 110, locale: NS,
  inject: () => settingsCard.inject(), component: TaskBoardSettingsCard,
})
ctx.effect(() => () => { settingsCard.dispose() }, 'task-board: settings card')
```

**对我们的启示**：这个"暂存 + 原子提交 + 读回判定"的模型比我们目前的直接写配置好，
尤其是"宿主可能静默拒绝变更，所以要读回落定"这一点——
我们的 `Config::validate` 会拒绝，但**插件拿到的是不是拒绝后的真相**，值得检查。

## 6. 测试纪律

**框架**：vitest。特点是**手写 fake，不用 `vi.mock`**。

`controller.spec.ts`（525 行）里的假件是真正的类：

```ts
class FakeSessions { list = { getSnapshot: () => …, subscribe: () => … }; open() {} }
class InMemoryTaskStore { … }
class ExternalAwareStore extends InMemoryTaskStore { /* 发"兄弟标签页写了账本"事件 */ }
```

**确定性靠注入缝**：`now: () => NOW`、单调 `uuid`、
`flush = () => new Promise(r => setTimeout(r, 0))` 处理异步路径。

**断的是行为与持久化副作用，不是实现**：

```ts
expect(controller.getSnapshot().tasks.map(t => t.id)).toEqual([...])
expect(store.load()).toEqual([])
```

还有"dispose 后不再通知"（`notified` 计数器）这类，以及**带 issue 号的回归测试**
（*"stays open during transient undefined session list jitter (#1182)"*）。

`describe` 块按领域划分：执行选项、生命周期、任务变更、视图状态、运行循环、调度、跨标签页变更。

**对我们的启示**：我们的 TS 测试风格接近（`node --test`，手写 DOM stub），
但**没有 issue 号锚点**，也**没有"dispose 后不再通知"这类生命周期断言**。
后者我们其实有对应风险（`release` 后 `refreshPluginSlots` 是否还会跑）。

## 7. i18n

- **命名空间类型**在同一处 augmentation 里：`'task-board': TaskBoardKey`
- **key 类型以 zh 字典为唯一真相源**：

```ts
export const zh = { 'entry.label': '任务看板', … } satisfies Record<string, string>
export type TaskBoardKey = keyof typeof zh
export const en: Record<keyof typeof zh, string> = { … }   // 编译期完整性保证
```

- **注册**（在 `ctx.effect` 里，返回值即清理）：

```ts
ctx.effect(() => { try { return ctx.locale.register(NS, { zh, en }) } catch { return () => {} } },
           'task-board: dictionaries')
```

- **查用**：`ctx.locale.bind(NS)`。
  模块级的 translate 座位（`setRuntimeTranslate(ctx.locale.bind(NS))`）
  让**纯 DOM 表面**（侧栏行）在**调用时**跟随语言，而不是捕获挂载时的语言——
  对未接线的调用者有文档语言兜底。`t(key, params)` 展开 `{name}` 占位符。
- **CI 门禁**：`scripts/i18n-audit.mjs` 校验 key 对齐 + ru 覆盖。

**对我们的启示**：`en: Record<keyof typeof zh, string>` 这个写法（**用编译期类型强制翻译完整性**）
是最实用的一招，成本极低。

## 8. 两个共享核

**`shared/client/panel-mount-core.ts`** —— 中央列"面板接管"（task-board 与 ssh 共用）。
因为"conversation 槽位是单占用，且外部插件不能声明槽位"，它**追加**一个非托管
`<div>` 到 `[data-pane="conversation"], [class*="centerCol"]`，打上
`data-<view>` / `data-dsh-plugin` 标记，在其中 `createRoot` 挂 React 根。
可见性是**纯声明式**的：样式表规则在 `<html data-…>` 置位时隐藏会话内容。

细节很讲究：关闭/重开时**保留已访问的树**（草稿、终端会话存活）、
用 `dsh-panel-activate` CustomEvent 驱逐兄弟面板、
捕获阶段监听侧栏行点击来关闭、语言变化时重渲染、经 `subscribeBodyInvalidations` 自愈、
disposer 移除容器/根/属性。**一个打开的面板一个 React 根，对 shell 的 reconciliation 零交互。**

**`dsh-plugin-manager`** —— 双通道安装/更新/卸载/启用 UI。
`host/gateway.ts` **spawn 官方 `dsh plugin` CLI 作为唯一写入者**；
`core/conflict.ts` 做插件控制前后的快照 diff（`classifyChange`）；
有 `bundle-guard.ts`、`loopback.ts`（socket + Host + Origin + `sec-fetch-site` 四重校验，否则 403）、
`repair.ts`、`legacy-migration.ts`。
提供 `pluginManager` cordis 服务（`list/install/uninstall/status/failures/setEnabled/onChange`），
与设置标签页共享，所以 `onChange` 观察者能看到两个表面。

**对我们的启示**：`plugin-manager` 的**"CLI 作为唯一写入者"**是个好架构——
我们目前是 Tauri 命令直接改 `studio.json`。
"唯一写入者 + 冲突 diff + 环路校验"这套，在我们开放更多管理能力时值得参考。

## 8.5 语义属性契约（唯一能“改造别人 UI”的机制）

`packages/skins/skin-center/contracts/semantic-attrs-v1.md` 是他们仓库里
**最容易被忽略但最重要的一份文档**。它定义了一组稳定的 DOM 契约属性，
让样式层能键在语义上而不是官方 hash 类名上。

三组：

| 组 | 例 | 谁输出 |
|---|---|---|
| `data-dsh-surface` | `sidebar`, `conversation`, `composer`, `details`, `overlay` | shell |
| `data-dsh-part` | `column`, `sprite`, `entry` | 各自插件 |
| `data-dsh-plugin` | `task-board`, `ssh`, `pet`, `usage` …（**15 个**） | 各自插件 |

选择器写法：`[data-dsh-plugin="ssh"] [data-dsh-part="terminal"]`。

### 纪律（这几条比技术本身值钱）

1. **每个枚举值必须有明确 owner、版本、含义与锚定方式**——
   "不能只堆字符串——防止语义层退化成另一套隐式 DOM API"。
2. **契约归属单一持有者**：这组属性由皮肤中心**单方面拥有和维护**，
   并明文写着一句话：

   > 冲突仲裁纪律：**不靠加载顺序**。

3. **两种产出通道**：compat adapter（合并 MutationObserver，给未 opt-in 的补打属性）
   与组件主动输出（更准更快）。**不输出语义属性的插件只享受 L1 token 基础覆盖**
   ——即"可得性是分层的"，不是一个开关。
4. **part 用裸值，归属交给 `data-dsh-plugin`**（`column` 而非 `task-board-column`）。
5. **不复用官方 `data-plugin`**：官方用它标 style 标签归属，语义不同。

### 它解决了什么真实问题

他们的已知脆弱点清单写得很直白（这就是他们推动上游改的诉求列表）：

1. AppFrame 三列容器本体只有 hash 类，列级钩子缺失；
2. 侧栏导航行无官方 slot，插件靠 DOM 注入；
3. 设置模态只有 `role="dialog"`（与其他对话框撞车）；
4. list slot 的单 entry **无 DOM 归属标识**——`[data-dsh-plugin]` 是对它的补偿。

**对我们的启示**：

- 第 4 条尤其值得注意：**它的存在是因为 slot 渲染不把 entry id 透传到 DOM**，
  于是插件无法用 CSS 定位自己或别人的条目。我们的 `PluginHost.mount()`
  **已经**写了 `wrapper.dataset.plugin` / `dataset.slot` / `dataset.renderedBy`
  ——**我们白得这个能力**（`e2e-check.mjs` 甚至在断言 `dataset.renderedBy`）。
- 但我们的 `data-*` 是**为了测试**，没当成**公开契约**。若要支持"插件用 CSS 微调别人"，
  应该像他们一样把这几个属性**文档化、版本化、声明归属**，
  而不是当成内部实现细节——否则插件会键上去，而我们会无意中改它。
- **"不靠加载顺序"这条纪律直接指出我们 §3.6 的缺陷**：
  我们的调整冲突靠加载顺序静默解决，而他们的契约层明确拒绝这个做法。

## 9. 该抄什么（按性价比排序）

| 优先级 | 项 | 成本 | 收益 |
|---|---|---|---|
| **高** | **双源加载防重**（`globalThis` 标志 + `release`） | 小 | 消除真实的重复注册 bug |
| **高** | **翻译完整性类型**（`Record<keyof typeof zh, string>`） | 极小 | 编译期保证不漏翻译 |
| **高** | **`data-*` 当公开契约**（我们已在写，但未文档化） | 小 | 插件可稳定用 CSS 定位；避免无意改动破坏插件 |
| **高** | **disposer 带 label** | 小 | 日志可读，能定位泄漏 |
| 中 | **core 共享层**（插件内宿主/前端共用逻辑） | 中 | 消灭两侧重复实现 |
| 中 | **批量挂载容错**（一处失败不中断其余） | 小 | 健壮性 |
| 中 | **设置的暂存+原子提交+读回判定** | 中 | 杜绝"以为写进去了" |
| 低 | 三层文档纪律 | 小 | 事实有归属 |
| 低 | CI 门禁（i18n / 产物 fingerprint） | 中 | 只在规模上来后值 |

## 10. 不要抄

- **MutationObserver 自愈注入**：他们**没有槽位可用**时的对冲。我们有槽位注册表。
- **`SlotMap` 类型化槽位**：前提（编译期槽位名）在我们这里不成立。
- **寄生官方 profile**：产品前提不同。
- **Electron + 内置 Node**：与 WASM 沙箱边界相悖。
