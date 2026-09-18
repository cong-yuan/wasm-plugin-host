# dsh-web-shell

Official DSH Web GUI shell, as a WASM plugin. CSS is remapped from
`@deepseek-ai/dsh-client-ui-layout|sidebar|conversation` — not a hand-drawn
approximation. Tokens from `@deepseek-ai/dsh-client-ui-theme`.

Claims `open: "startup"` so Studio’s admin window stays hidden.

## Build

```sh
cargo build --release -p dsh-web-shell --target wasm32-wasip1
```
