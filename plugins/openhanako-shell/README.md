# openhanako-shell

Studio 启动窗里嵌 **真实 [openhanako](https://github.com/liliMozi/openhanako) 前端**（1:1），不再用手写近似 chrome。

当前实现：`OpenhanakoShell` 用 iframe 打开本地 `http://127.0.0.1:5173/index.html`（或 `window.__OPENHANAKO_UI_URL__`）。后端仍是上游 `dev:web` / 之后换成我们自己的。

## 跑起来

```bash
# 1) 上游 UI + server
cd /path/to/openhanako && npm run dev:web
# 2) 本插件 wasm
cargo build -p openhanako-shell --release --target wasm32-wasip1
# 3) Studio 的 studio.json 启用 slot `openhanako` 指向
#    target/wasm32-wasip1/release/openhanako_shell.wasm
```

`hana-shell` / `workbench-shell` 仍保留，本插件是加法。

`js/` 里还有一版从 workbench 吸收的 DOM/CSS 管线（`scripts/build-css.mjs`），以及 hana 的 resize/session 测试思路；启动窗不再走那条路。`vendor/` 与 `js/lib/fonts.js` 不入库。
