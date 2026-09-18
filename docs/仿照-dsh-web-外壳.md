# 仿照 dsh-web 的外壳与插槽设计

> 依据:`zhu1090093659/dsh-web` 的**真实源码**(不是逆向产物)。
> 源码位置:`/tmp/dsh-web`(`dev` 分支)。引用都给出文件路径,可复核。

## 0. 为什么这次更可靠

上一次复刻 Qoder 是**逆向打包产物**——色值靠解析、结构靠推断。这次是**源码**,
插槽名、布局层级、注册契约都是明文。所以这一版可以**直接照抄结构**,而不是猜。

## 1. 外壳布局(从 `data-slot` 属性提取)

dsh-web 的骨架是三栏 + 帧级浮层,**每个区域都带 `data-slot` 锚点**:

```
root                                   [data-slot="root"]
├── sidebar                            [data-slot="sidebar"]
│   ├── sidebar.brand.mark             [data-slot="sidebar.brand.mark"]
│   ├── sidebar.brand.name
│   ├── sidebar.workspaces             [data-slot="sidebar.workspaces"]  ← 会话列表
│   ├── sidebar.settings               [data-slot="sidebar.settings"]    ← 出现 67 次,最热
│   └── sidebar.footer.action          [data-slot="sidebar.footer.action"]
│
├── main                               [data-slot="main"]
│   └── main.conversation              [data-slot="main.conversation"]
│       └── conversation               [data-slot="conversation"]
│           ├── conversation.session   [data-slot="conversation.session"]
│           │   └── .session.header
│           │       ├── .header       [data-slot="conversation.session.header"]
│           │       └── .header.actions [data-slot="...header.actions"]
│           ├── conversation.chat.node   [data-slot="conversation.chat.node"]  ← 消息行
│           │   (hero) conversation.hero.brand.mark
│           └── conversation.input.dock  [data-slot="conversation.input.dock"]
│               └── conversation.composer [data-slot="conversation.composer"]
│                   ├── .composer.bar  [data-slot="conversation.composer.bar"]
│                   └── .input.model   [data-slot="conversation.input.model"]
│
├── details / rightbar                 [data-slot="details"] [data-slot="rightbar"]
│   └── rightbar.session               [data-slot="rightbar.session"]
│
└── shell.overlay                      [data-slot="shell.overlay"]
```

**与我们现有 5 个内置槽的差距**:

| dsh-web | 我们有 | 缺 |
|---|---|---|
| `sidebar.settings`(最热,67 处) | `sidebar.items` | 会话列表区 |
| `conversation.session.header.actions` | — | 会话头操作区 |
| `conversation.input.*`(dock/bar/model) | `agent.actions` | **输入区完全可插** |
| `details` / `rightbar` | — | 右侧详情栏 |
| `settings.section`(14 处) | `settings.tabs` | 语义接近 |
| `shell.overlay` | — | 帧级浮层 |

## 2. 插槽注册契约(真实 API)

```ts
// 1. 声明依赖
export const inject = ['slots', 'locale', 'connection', 'settingsScope', 'remote']

// 2. 在 effect 里注册(**可撤销**是硬要求)
ctx.slots.inject('settings.section', () => {
  const unregister = ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-usage',           // ← 归属者,用于仲裁
    order: 151,                // ← 排序,不靠加载顺序
    label: () => ctx.locale.bind(NS)('usage.title'),
    locale: NS,
    inject: face,              // ← 传给组件的数据面(business face)
  }, UsageSectionCard)
  return () => { unregister() }
})
```

**四个关键设计**:

| 字段 | 作用 | 我们的对应物 |
|---|---|---|
| `name` | 插槽名 | `slot` |
| `id` | **归属者** | `owner` |
| `order` | **显式排序** | `priority` |
| `inject` | 数据面(不是 props,是"业务面") | ❌ **我们没有** |

`inject: face` 这一条值得注意:他们传的是**函数式数据面**(`{ store, poll, refresh }`),
不是 props。组件通过它读数据、触发动作,而数据面的生命周期由注册者管。

## 3. 插槽名全表(实际用到的)

`ctx.slots.inject(...)` 的真实调用:

```
settings.section                   14   设置页一级区块(最通用)
web-ui.plugin.item                 11   插件卡片列表位
settings.plugin.item               11   官方插件卡片位(按 namespace 分派)
sidebar.footer.action               3   侧栏底部动作
dsh-workshop.panel                  3   创意工坊面板
settings.plugins.tab                2
settings.models.provider-card       2   模型供应商卡片
settings.models.footer              2
conversation.input.selector.context 2   输入区选择器上下文
conversation.input.right            2   输入区右侧
conversation.input.dock             2   输入区停靠
```

**注意 `plugin-card-seat.ts` 的双席位探测模式**(值得抄):

```ts
// 席位是"部署的属性",不是插件的属性:装了哪个 group 就有哪个席位。
// 探测 + 回退,让卡片在两种部署下都可达。
const seat = ctx.slots.spec('web-ui.plugin.item')
  ? 'web-ui.plugin.item'
  : 'settings.plugin.item'
```

**这解决了一个我们没有的问题**:同一个贡献要落到**不同槽位**(取决于环境),
而不是写死一个槽名。我们的 `adjusts` 只有单目标。

## 4. 他们承认的缺陷(我们的优势)

`semantic-attrs-v1.md` 开篇白纸黑字:

> 契约归属:本表由皮肤中心单方面拥有和维护(**冲突仲裁纪律:不靠加载顺序**)。

**但官方 shell 没给 sidebar 插槽**,所以 dsh-usage 只能:

```ts
// sidebar-entry.ts —— 把一行"塞"进别人的 DOM,然后用 MutationObserver 自愈
position: 'after',
familySelectors: ['[data-dsh-taskboard-entry]', '[data-dsh-ssh-entry]', ...],
```

`body-mutations.ts` 的注释解释了代价:

> 每个 consumer 过去都装自己的 `MutationObserver` ……装 N 个插件就付 N 个原生
> observer 和 N 次回调,**聊天流式输出每秒就产生大量 mutation**。

**这正是我们槽位注册表避免的**:他们靠 DOM 观察,我们靠注册表。

## 5. 语义属性契约(L2)

三组枚举,作者:`surface`(8) / `part`(79) / `plugin`:

```css
/* part 用裸值,归属交给 data-dsh-plugin */
[data-dsh-plugin="ssh"] [data-dsh-part="terminal"]
```

**纪律**(值得逐条照抄):

1. 每个枚举值必须有**明确 owner / 版本 / 含义 / 锚定方式**
2. `part` 用**裸值**(`column` 而非 `task-board-column`)
3. **不复用官方 `data-plugin`**(语义不同)
4. 跨插件 CSS 抑制是**明令禁止的**,只能同 owner 内部用

> 注:第 4 条有例外——`mobile-adapt.ts` 确实按名字隐藏了 6 个插件
> (仅移动端竖屏、仅隐藏)。**规则是规则,例外被记录**。这条我上次已更正过。

## 6. 我们要照抄什么

| # | 照抄 | 理由 |
|---|---|---|
| 1 | **三栏布局 + `data-slot` 锚点** | 结构清晰,每区域可被寻址 |
| 2 | **`inject` 数据面**(而非 props) | 组件解耦,注册者管生命周期 |
| 3 | **注册契约四字段**:name/id/order/inject | `id` 用于仲裁,`order` 不靠加载顺序 |
| 4 | **可撤销注册**(`return () => unregister()`) | 热重载/禁用必须干净 |
| 5 | **语义属性三组 + 裸值 part** | 让样式与结构解耦 |
| 6 | **单例 body observer 的模式** | 我们不需要,但"共享而非各自观察"的思路要学 |
| 7 | **席位探测 + 回退** | 一个贡献适配多环境 |

## 7. 我们**不**照抄的

| 不抄 | 为什么 |
|---|---|
| MutationObserver 注入侧栏 | 我们有真正开放的插槽,不需要自愈 |
| `data-dsh-*` 命名 | 保持自己的命名,避免与 dsh-web 混淆 |
| 每个插件一个 npm 包 | 我们是 WASM,一个 `.wasm` 就是插件 |
| Tailwind + Radix + CVA 全家桶 | 我们只需令牌 + 原生 CSS |
| 87 个 i18n namespace | 先用英文硬编码,需要时再抽 |
