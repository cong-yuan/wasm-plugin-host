# hana-shell

HanaAgent's chrome, recreated as a WASM plugin — **it owns the launch view**, so
the app opens this window at startup.

Two things are deliberately separate here, because they have different sources
and different lifetimes:

| Concern | From | Why |
|---|---|---|
| **Layout** | [openhanako / HanaAgent](https://github.com/liliMozi/openhanako) (Apache-2.0) | The chrome this recreates: warm paper, serif display, the titlebar + four columns |
| **Slot discipline** | [dsh-web](https://github.com/zhu1090093659/dsh-web) | It has the best slot model of the projects studied: named regions, explicit ordering, no DOM surgery |

Because they are separate, either can be replaced without touching the other.
The slots are what plugins bind to; the layout is what the pixels are.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ titlebar 44px   [☰] [New session]        Session title        [⧉] [▤]     │
├─────────────┬──────────────────────────────────┬───────────┬─────────────┤
│ 240px       │ conversation                     │ 580px     │ 260px       │
│ sidebar     │                                  │ preview   │ rail        │
│  ├ header   │  session header                  │ (hidden   │  ├ header   │
│  ├ activities  message stream (serif)          │  by       │  └ items    │
│  ├ sessions │  └ conversation.hero             │  default) │             │
│  ├ notice   │  composer (16px radius)          │           │             │
│  └ footer   │                                  │           │             │
└─────────────┴──────────────────────────────────┴───────────┴─────────────┘
                        shell.overlay — above everything
```

Compared with the studio's own shell, this adds the **titlebar**, the
**preview column**, and splits the right side into **preview** and the
**companion rail** (HanaAgent's "笺" sidebar). Columns collapse by width rather
than unmounting, so a slot inside a hidden column keeps its contributions.

## The 17 slots

The value of a shell is the surface it opens, not the pixels it draws. A plugin
written later adds a feature with a one-line declaration:

```json
"ui": { "injects": [
  { "slot": "hana.sidebar.sessions",        "component": "MySessions" },
  { "slot": "hana.conversation.input.right", "component": "MyModelPicker" }
] }
```

No change here, no rebuild, no ordering requirement — a contribution made
**before** the shell loads is remembered and appears when it does.

| Slot | Where |
|---|---|
| `hana.titlebar.left` | Left cluster: sidebar toggle, new session |
| `hana.titlebar.center` | Centre: the session title / channel tabs |
| `hana.titlebar.right` | Right cluster: widget buttons, panel toggles |
| `hana.sidebar.header` | Header row: title, new-chat, settings, collapse |
| `hana.sidebar.activities` | The activity bars: bridge, activity, automation, skills |
| `hana.sidebar.sessions` | The session list |
| `hana.sidebar.notice` | The notice slot above the footer (update stickers) |
| `hana.sidebar.footer` | Sidebar footer: status, account, extra actions |
| `hana.conversation.header` | Session header: title and actions |
| `hana.conversation.hero` | Empty state, before the first message |
| `hana.conversation.stream` | The message stream itself |
| `hana.conversation.input.dock` | Around the composer (above/below the box) |
| `hana.conversation.input.right` | Inside the composer, after Send |
| `hana.preview.panel` | The right-hand preview/document panel |
| `hana.rail.header` | Right column header row |
| `hana.rail.items` | Right column body (activity, todos, files) |
| `hana.shell.overlay` | Whole window, above everything |

Declared in Rust (`SLOTS` → `provides`), which is the contract the host and the
slot inspector see, **and** mounted in JS. The studio's test
`the_shell_slots_a_panel_mounts_are_the_ones_it_declares` asserts the two lists
are the **same set** — a slot declared but never mounted is a contribution that
silently goes nowhere, and reading only the manifest would miss it. (That test
found a real instance of exactly this: `hana.rail.header`.)

## The visual language, in three decisions

Naming these matters, because they are what stops the result looking like every
other neutral admin panel:

1. **Warm paper, not grey.** Surfaces are off-white (`#F8F4ED`), and borders and
   shadows are tinted brown (`rgba(122,96,88,…)`) rather than neutral.
2. **Serif display, sans UI.** The empty-state headline and the assistant's prose
   are serif; everything interactive stays sans.
3. **Low-contrast accents.** Accent-tinted surfaces sit at 6–12% opacity, so the
   accent reads as a wash rather than a colour block.

Plus the motion vocabulary (`lib/motion.js`): 12 keyframes, each with exactly one
name, all disabled under `prefers-reduced-motion`.

Two themes: `warm-paper` (default) and `midnight` (deep teal-blue, rose accent).

### What was *not* taken from HanaAgent

Its React components. They are bound to ~10k lines of stores, and its plugin UI
is an iframe with an SDK handshake — the opposite of rendering directly into a
slot. What transfers is the design language *and the layout*, and that is what
was taken. The plugin surface is ours (dsh-web's discipline), not Hana's.

## Source layout

```
js/
  entry.js                 apply tokens, install motion, register the component
  style.css                the look + the frame (titlebar, four columns)
  lib/
    tokens.js              structural scale + 2 palettes
    motion.js              12 keyframes, one name each
    dom.js                 element builder, token ref, region helper
    slots.js               the slot inventory + mount helper
    api.js                 backend commands (degrades without IPC)
  panels/
    titlebar.js            the 44px row: three clusters + the panel toggles
    sidebar.js             header / activities / sessions / notice / footer
    conversation.js        header / hero / stream / composer
    preview.js             the 580px document column
    rail.js                the 260px companion rail
    shell.js               the frame: titlebar over the column row
```

Assets are `include_str!` from `js/`, so the script text stays a real `.js` file
while travelling inside the `.wasm`.

## Build

```sh
cargo build --release -p hana-shell -p demo-shell-addon --target wasm32-wasip1
```

Load `hana_shell.wasm` and `demo_shell_addon.wasm` from the Plugins page. The
shell takes the launch view immediately.

## Honest limitations

* **One shell at a time.** Only one plugin may declare `open: "startup"`.
* **`content: "app"` only.** The `content: "html"` window path still renders
  blank (tracked in `docs/已知问题.md`).
* **No bundled webfonts.** Hana ships Inter + EB Garamond + Noto Serif SC
  (6.4 MB). This uses system faces, which loses some fidelity but keeps the
  plugin small; adding a Latin subset later is straightforward.
* **No paper texture.** Upstream's `warm-paper` inlines a base64 PNG grain; it is
  omitted here to keep the asset small.
* **The activity bars and session list are empty frames.** Real content needs
  backend features we do not have yet (sessions, git, terminal) — they are slots
  for now, which is the point.
* **The preview column starts collapsed** and has no toggle in the titlebar yet;
  a plugin fills `hana.preview.panel` and the column opens.
