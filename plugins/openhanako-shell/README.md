# openhanako-shell

Studio 启动窗里嵌 **真实 [openhanako](https://github.com/liliMozi/openhanako) 前端**（1:1 iframe），并声明 WASM 槽位表面，让其它插件用 `injects` / `adjusts` 扩展，而不改本插件 DOM。

## 槽位契约 vs 上游

| 上游 openhanako | 本插件 WASM 表面 |
|---|---|
| page / widget / card / settingsTab（iframe 岛） | `ui.provides` → `openhanako.*` 命名槽 |
| （无跨插件 chrome 注入） | 其它插件 `ui.injects` → `studio.renderSlot` |
| （无运行时策展） | 第三方 `ui.adjusts`（如 `ui-curator`） |

槽名用 **`openhanako.`** 前缀，与 `hana-shell` 的 `hana.*` 分开。清单在 `src/lib.rs` 的 `SLOTS` 与 `js/lib/slots.js`，两边必须同步。

空槽：`pointer-events: none` + `visibility: hidden`，不挡 iframe 点击，也不占视觉空间。有贡献时再启用交互。

当前挂载方式是 **iframe 外薄层 overlay**（按桌面 chrome 大致锚点定位）。尚未把 inject 打进上游 React 树；需要更贴合时再改 `/tmp/openhanako-full` + `patches/`，但槽名契约保持不变。

## 跑起来

```bash
# 1) 上游 UI
cd /path/to/openhanako && npm run dev:web
# 2) 本插件 wasm
cargo build -p openhanako-shell --release --target wasm32-wasip1
# 3) Studio studio.json 启用 openhanako-shell（以及可选 demo-openhanako-addon）
```

验证：加载 `demo-openhanako-addon` 后，titlebar 右侧 / sidebar notice / composer dock / rail 应出现 demo 控件；卸载 addon 后消失；空槽仍不挡点击。

`patches/` 里的 settings / InputArea 修复仍只作用于真实前端树，与槽位桥无关。
