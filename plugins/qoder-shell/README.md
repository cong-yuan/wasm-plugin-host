# qoder-shell

A recreation of the **Qoder CN** shell (v0.2.5), as a WASM plugin.

It is the first plugin to claim the launch view: the app opens *its* window at
startup and keeps its own hidden, so the user lands on this shell instead of the
default page. Everything visible — sidebar, chat pane, inspector — is drawn by
this plugin.

```
┌───────────┬────────────────────────────┬──────────────┐
│ 220px     │  main                      │ 260px        │
│ Qoder     │  chat over the dsh agent   │ WORKSPACE    │
│ 7 nav     │                            │ TOOLS        │
│ items     │                            │ THEME (9)    │
│ status ●  │  [composer]                │              │
└───────────┴────────────────────────────┴──────────────┘
```

## What is real, and what is not

Being precise here matters more than looking impressive:

| Part | Status |
|---|---|
| Three-column layout, Qoder's 7 nav entries | **Real**, matching Qoder's `nav.*` keys |
| Design tokens (9 themes) | **Real**, resolved from Qoder's shipped stylesheet |
| Chat pane | **Real** — creates a dsh agent and streams its transcript |
| Status / tools / services counts | **Real**, read from the backend every 8s |
| Theme picker switching all tokens live | **Real** |
| Clicking a nav entry | **Approximate** — navigates to the closest page *this app* has |
| Qoder's visual polish (blobs, view transitions, ~50 keyframes) | **Not attempted** |

The chat is live because a plugin window loads the app, so it reaches the
backend through Tauri's IPC. Verified end-to-end, not just in unit tests:
`create_agent` → `send_message` → `transcript` returns both turns.

## Why the JS is in real files

Every asset is pulled in with `include_str!` from `js/`, so the script text lives
in a `.js` file — syntax-highlighted, formattable, reviewable — instead of a
`r#"..."#` literal. The assets still travel *inside* the `.wasm` (the host only
ever receives the module), but **nothing is written as a Rust string**.

That is the point: a real plugin is hundreds of lines of JS, and embedding it in
Rust makes it unmaintainable. This plugin is the test of whether that workflow is
workable, and it is.

## Layout of the source

```
js/
  entry.js            applies the theme, registers the component, opens a slot
  style.css           the few rules with no inline equivalent (scrollbars, motion)
  lib/
    tokens.js         Qoder's design tokens + its 9 themes
    dom.js            a small element builder (`h`)
    nav.js            Qoder's main navigation
    api.js            the backend commands the shell drives
  panels/
    shell.js          sidebar | main | inspector
    sidebar.js        brand, nav, live status, `qoder-shell.sidebar` slot
    chat.js           the live chat pane
    inspector.js      workspace / tools / theme
```

`entry.js` is a handful of lines because everything else is a module. Modules
load lazily, may require each other, and are cached per plugin.

## It opens a slot for later plugins

`qoder-shell.sidebar` is opened so **another plugin loaded later** can add its own
sidebar entries without this one knowing anything about it:

```json
"ui": { "injects": [{ "slot": "qoder-shell.sidebar", "component": "MyEntries" }] }
```

This is the composition story: the shell provides the frame, other plugins fill
it, and a third plugin can still `adjusts` any of it.

## Build

```sh
cargo build --release -p qoder-shell --target wasm32-wasip1
```

Then load `target/wasm32-wasip1/release/qoder_shell.wasm` from the Plugins page.
It takes over the launch view immediately — quit and reopen to see it.

## Honest limitations

* **One window, one shell.** Only one plugin may declare `open: "startup"`, so
  two shells cannot both own the launch view (that is by design — the error names
  both claimants).
* **Nav is not a router.** Qoder's entries point at *its* pages; ours point at
  the nearest equivalent. Real per-entry pages need real backend features.
* **No `html`-window path.** This uses `content: "app"` (the default), which is
  the supported path. `content: "html"` windows still render blank (see
  `docs/已知问题.md`).
