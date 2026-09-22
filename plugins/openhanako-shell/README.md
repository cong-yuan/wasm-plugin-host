# openhanako-shell

Studio 启动窗里嵌 **真实 openhanako 前端**（1:1 iframe），并声明 WASM 槽位表面。

## 槽位怎么挂（当前方向）

槽锚点在 **原 UI 真实 chrome** 上（`data-ohk-slot`），不是猜坐标的外层 overlay：

1. 上游（`patches/studio-slots/`）在 titlebar / sidebar / conversation / preview / rail 等大区根打锚点，并跑 `StudioSlotBridge`。
2. iframe → parent `postMessage` 上报锚点几何。
3. 本插件用 `studio.renderSlot` 挂贡献，并按几何对齐。

空槽不抢点击。`openhanako.*` 与 `hana-shell` 的 `hana.*` 分开。

上游自带的 page / widget / card 插件岛仍保留；`openhanako.*` 是 Studio WASM 的 chrome 扩展面。

## 跑起来

```bash
# 1) 上游 UI（已打 studio-slots 补丁）
cd /tmp/openhanako-full && npm run dev:web   # 或项目惯用脚本
# 2) wasm
cargo build -p openhanako-shell -p demo-openhanako-addon --release --target wasm32-wasip1
# 3) Studio 启用 openhanako-shell + 可选 demo-openhanako-addon
```

设置相关补丁仍在 `patches/` 根下（Settings* / InputArea 首屏等），与槽位桥独立。
