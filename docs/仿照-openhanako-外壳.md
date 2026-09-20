# 仿照 openhanako（HanaAgent）的外壳与插槽设计

> 依据:`liliMozi/openhanako` 的**真实源码**(不是逆向产物,不是截图推断)。
> 源码位置:GitHub `main` 分支(本机 clone 因仓库 167 MB 屡次超时,改用
> GitHub trees API + raw 文件按需取——所引路径均给出文件,可复核)。
> 本文是 `仿照-dsh-web-外壳.md` 的**姊妹篇**:那篇定插槽纪律,这篇定布局与像素。

## 0. 两个来源,刻意分开

外壳插件 `hana-shell` 的每一部分都写明来源,因为两者的寿命不同:

| 关注点 | 来源 | 为什么 |
|---|---|---|
| **布局与视觉** | `liliMozi/openhanako`(Apache-2.0) | 要复刻的那个产品:暖纸、衬线、titlebar + 四栏 |
| **插槽纪律** | `zhu1090093659/dsh-web` | 三个项目里最好的插槽模型:命名区域、显式排序、不做 DOM 手术 |

分开的好处:任一方可以独立替换。插槽是插件绑定的对象;布局是像素。

**HanaAgent 的插件模型不抄。** 它是 **iframe + SDK 握手**(`hana.ready()`),
和"直接渲染进插槽"相反。能带走的是**设计语言与布局**,不是它的 React 组件
——那些和 ~1 万行 store 深度绑定。

## 1. 外壳布局(从 `App.tsx` + `styles.css` 提取)

HanaAgent 的骨架是**一列 titlebar + 一行四栏**,外加 13 个 overlay:

```
.app-shell                            ← 我们:.hn-shell(display:flex; column)
├── .titlebar           44px          ← .hn-tb
│   ├── .tb-left-group                  侧栏 toggle / new session
│   ├── .tb-center-title                会话标题
│   ├── <ChannelTabBar>                 频道分页
│   ├── .tb-right-group                 WidgetButtons / preview toggle
│   └── <WindowControls>                自绘窗控(Win/Linux)
│
└── .app                             ← .hn-app(display:flex; row)
    ├── .sidebar        240px        ← .hn-col-sidebar
    │   ├── .sidebar-header            title + 3 个动作按钮
    │   ├── .sidebar-activity-bar ×4   bridge/activity/automation/skills
    │   ├── .session-list              SessionList
    │   └── <SidebarNoticeSlot>        更新贴纸位
    │
    ├── .main-content   flex:1       ← .hn-col-main
    │   ├── <AppPages>                 chat | channels | plugin:*
    │   └── <PreviewPanel>  580px     仅 chat 显示
    │
    └── .jian-sidebar   260px        ← .hn-col-rail
        └── <RightWorkspacePanel>      activity / todo / registry files
```

尺寸都取自上游 token(不是目测):

| 上游 token | 值 | 我们的 |
|---|---|---|
| `--titlebar-h` | 44px | `--dw-titlebar-h` |
| `--sidebar-width` | 240px | `--dw-sidebar-width` |
| `--jian-sidebar-width` | 260px | `--dw-rail-width` |
| `--preview-panel-width` | 580px | `--dw-preview-width` |
| `--chat-column-width` | 720px | `--dw-chat-column-width` |
| `--radius-input` / `--radius-chat-surface` | 6px / 16px | 同名 |

## 2. 插槽契约(17 个)

外壳的价值是**它开出的面**,不是它画的像素。后来的插件用一行声明加功能:

```json
"ui": { "injects": [
  { "slot": "hana.sidebar.sessions",         "component": "MySessions" },
  { "slot": "hana.conversation.input.right", "component": "MyModelPicker" }
] }
```

不必改这里、不必重编、不要求加载顺序——**先于外壳**做出的贡献会被记住,外壳
一加载就出现(注册表与顺序无关)。

| 槽位 | 位置 | 对应上游 |
|---|---|---|
| `hana.titlebar.left` | 左簇:侧栏 toggle、新会话 | `.tb-left-group` |
| `hana.titlebar.center` | 中簇:会话标题 / 频道分页 | `.tb-center-title` |
| `hana.titlebar.right` | 右簇:widget 按钮、面板开关 | `.tb-right-group` |
| `hana.sidebar.header` | 头部行:标题、新聊天、设置、折叠 | `.sidebar-header` |
| `hana.sidebar.activities` | 活动栏 ×4 | `.sidebar-activity-bar` |
| `hana.sidebar.sessions` | 会话列表 | `.session-list` |
| `hana.sidebar.notice` | 页脚之上的通知位 | `<SidebarNoticeSlot>` |
| `hana.sidebar.footer` | 页脚:状态、账号 | `.sidebar-footer` |
| `hana.conversation.header` | 会话头:标题与动作 | `.header` |
| `hana.conversation.hero` | 空状态,首条消息之前 | `#welcome` |
| `hana.conversation.stream` | 消息流本身 | `.chat-area` |
| `hana.conversation.input.dock` | 输入框上下 | `.input-area` |
| `hana.conversation.input.right` | 输入框内、发送键之后 | `InputControlBar` |
| `hana.preview.panel` | 右侧预览/文档面板 | `<PreviewPanel>` |
| `hana.rail.header` | 右栏头部行 | `.jian-sidebar` |
| `hana.rail.items` | 右栏主体(activity/todo/files) | `RightWorkspacePanel` |
| `hana.shell.overlay` | 整窗、最上层 | overlay 层 |

**声明在 Rust**(`SLOTS` → `provides`),宿主与插槽检查器读的是这一份;
**挂载在 JS**。两者必须**同一集合**——声明了却没挂载的槽,贡献会无声消失。
studio 的 `the_shell_slots_a_panel_mounts_are_the_ones_it_declares` 断言这一点,
而且**双向**断言。(这条测试抓到过真事:`hana.rail.header` 声明了却没挂载。)

### 命名

`hana.` 前缀是**我们的**,不是上游的——上游没有插槽概念。槽名跟着它的区域走
(`titlebar.…` / `sidebar.…` / `conversation.…` / `preview` / `rail`)。

后缀沿用 dsh-web 的约定,因为它们已经证明可读:

| 后缀 | 含义 |
|---|---|
| `*.header` / `*.footer` | 一栏的首 / 尾 |
| `*.items` | 一个纵向列表 |
| `*.activities` | 一排动作条 |
| `*.right` / `*.left` | 在一行的右 / 左 |
| `*.dock` | 环绕某个组件 |
| `*.overlay` | 帧级浮层 |

## 3. 拖曳调整尺寸

上游在 `use-sidebar-resize.ts` 里做这件事,值得抄的是**行为**,不是代码:

| 抄 | 为什么 |
|---|---|
| 拖曳中**实时夹取** | 拖不出坏布局 |
| 按目标**持久化** | 重载后保留 |
| 左栏 180–400 / 右栏 200–600 | 上游给的区间 |
| 拖曳中 `body.resizing` 全局 `cursor` | 否则快速拖曳会选中背后的文本 |
| 拖曳中关掉 transition | 边缘精确跟指针,而不是缓动追它 |
| 预览栏上限**动态算** | 固定上限会让宽窗口把对话挤到最小值以下 |

我们改了两处,并各自说明理由:

1. **加了双击复位**。上游只靠 localStorage,拖坏了没有可发现的回头路。
2. **titlebar 高度联动所有栏头**。上游没有这条(它的 `--titlebar-h` 同时喂
   titlebar 与多处避让)。我们一开始让栏头用独立的 `--dw-header-h`,**发现不对**:
   拖一条 titlebar,五个栏头不跟着动,反而不对齐。改回共用
   `--dw-titlebar-h`——一条分隔线高度,所有栏头统一。

| 拖曳处 | 变量 | 范围 |
|---|---|---|
| 侧栏右缘 | `--dw-sidebar-width` | 180–480 |
| 预览栏左缘 | `--dw-preview-width` | 320–(窗口 − 其他栏 − 400) |
| 右栏左缘 | `--dw-rail-width` | 200–600 |
| titlebar 下缘 | `--dw-titlebar-h` | 36–120 |

**拖曳区就是那条可见的线本身**(3px),不是盖在栏边缘上的隐形宽条。
理由:侧栏满是可点的行,一条 8px 的隐形带会**吃掉这些点击**。线在静止时**淡
淡可见**,因为"把光标放到线上"这件事,不显示出来就没人猜得到——hover 时转为
强调色。

机制是一支 `lib/resize.js`:两个轴共用一个 `install()`,面板只声明
`data-resize="sidebar"` 这种**名字**,拖曳的语义由外壳拥有。

## 4. 视觉语言,三个决定

上游的 `styles.css`(4216 行)里,真正定义这套观感的是三条。命名它们很重要,
因为它们是"这看起来不像又一个中性后台"的全部原因:

1. **暖纸,不是灰。** 表面是米白(`#F8F4ED`),边框与阴影**带棕色调**
   (`rgba(122,96,88,…)`),不是中性灰。
2. **衬线做标题,无衬线做 UI。** 空状态标题与助手正文用衬线;所有可交互的
   保持无衬线。
3. **低对比强调色。** 强调色表面只有 **6–12% 不透明度**,读起来是"淡染"而
   不是"色块"。

外加 12 个 keyframe(`lib/motion.js`),每个只有一个名字,全部在
`prefers-reduced-motion` 下关闭。两套主题:`warm-paper`(默认)+ `midnight`。

## 5. 我们**不**照抄的

| 不抄 | 为什么 |
|---|---|
| React 组件(42 个聊天组件等) | 与 ~1 万行 store 绑死,搬过来等于搬整个应用 |
| iframe + SDK 的插件模型 | 与"直接渲染进插槽"相反;我们的机制更好 |
| CSS Modules 里的样式 | 类名是哈希过的(`pI_x6G_centerCol`),搬过来不匹配任何元素 |
| 内嵌 base64 纸纹 | 为压体积省略;观感损失很小 |
| 自绘窗控(WindowControls) | Tauri 窗口保留 OS 标题栏,自绘会重复 |
| 6.4 MB 内置字体 | 先用系统字体栈;要精确再加 Inter 拉丁子集(~85 KB) |
| `data-tauri-drag-region` | 无边框窗口才需要;带 OS 标题栏时它只会请求一个未授权的命令 |

## 6. 已知边界

- **同时只能有一个外壳。** 只有 `open: "startup"` 的唯一宣称者能接管启动视图。
- **活动栏是空框。** Bridge / Activity / Automation / Skills 是没有功能背后的
  可点击位置——外壳不拥有 automations 或 skills。点击它们在有插件绑定到
  `data-activity` 之前是空操作。
- **没有流式。** dsh 在这边没有推送到前端的通道,所以回复靠每 250ms 轮询
  transcript,有上限。长回合因此表现为**一次性出现**,而不是自己打字出来。
- **推理默认收起**,工具调用只汇总成名字列表——transcript 里带着它们的参数,
  但外壳还没渲染。
- **预览栏默认收起。** titlebar 的 ⧉ 按钮打开它;在插件填
  `hana.preview.panel` 之前是个空框。
- **`content: "html"` 窗口仍渲染空白**(见 `已知问题.md`)。

## 7. 数据面(哪些是真的)

外壳不是 mock-up。每个区域的数据来源:

| 区域 | 来源 |
|---|---|
| 会话列表 | `list_agents` — 标题取首条用户消息 |
| 会话 token | session 的 `AssistantMessage` 事件,按 session 汇总 |
| 输入框 | 用**已配置**的 provider 建 agent,发送,轮询回复 |
| 侧栏页脚 | `studio_status` — 启动状态 + 已注册 provider |
| 右栏 | `studio_status` + `list_plugins` + `plugin_windows` + `list_tools` |
| 预览栏 | 仍只是槽位 |

两条不显而易见的规则:

1. **优先非 `mock` 的 provider。** `mock` 只回显输入,是测试替身不是模型;
   用户配了真端点就是想用它。硬编码 `mock` 会无声忽略配置。
2. **未报告的用量显示为空,而不是 0。** dsh 在每条 assistant 消息上附 usage,
   但不是每个 provider 都报;而且把 usage chunk 放在 `Finish` **之后**的流式
   provider 永远听不到——agent loop 读到 `Finish` 就 break。`calls === 0`
   因此渲染成“什么都没有”,因为 “0 tokens” 读起来像个测量值,而且是个假的。

## 8. 验收(可复核)

| 项 | 方式 |
|---|---|
| 外壳接管启动视图 | 窗口标题为 `Hana`;studio 自身窗口保持隐藏 |
| 17 个槽全部挂载 | `the_shell_slots_a_panel_mounts_are_the_ones_it_declares`(双向) |
| 贡献经槽位抵达 | `demo-shell-addon` 填 4 个槽,不 import 外壳任何代码 |
| 模块全部随包发出 | `the_shell_ships_every_module_its_entry_requires` |
| 拖曳行为 | node harness 模拟真实拖曳事件(含夹取/持久化/复位/动态上限/收起栏拒拖) |
| **真数据渲染** | node harness 带**假后端**,断言标题/用量/provider 真的出现 |
| **建 agent 用真 provider** | harness 断言 provider 是 `deepseek` 而非 `mock`(已非空洞验证) |
| 后端字段正确 | studio 的 5 个新测试(标题截断、用量汇总、不上报则不显示) |
| 暖纸主题生效 | 采样实际像素:`#F6F3EB` 主体、`#DDDBD5` 侧栏 |
