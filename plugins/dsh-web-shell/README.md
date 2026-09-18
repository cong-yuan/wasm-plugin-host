# dsh-web-shell

A slot-bearing shell for the studio, wearing **HanaAgent's visual language**.

Two things are deliberately separate here, because they have different sources
and different lifetimes:

| Concern | From | Why |
|---|---|---|
| **Slot design** | [dsh-web](https://github.com/zhu1090093659/dsh-web) | It has the best slot model of the projects studied: named regions, explicit ordering, no DOM surgery |
| **Visual language** | [HanaAgent](https://github.com/liliMozi/openhanako) (Apache-2.0) | Warm paper, serif display, low-contrast accents — the look worth copying |

Because they are separate, either can be replaced without touching the other.
The slots are what plugins bind to; the look is tokens plus a stylesheet.

```
┌─────────────┬──────────────────────────────┬──────────────┐
│ 240px       │ conversation                 │ 260px        │
│ sidebar     │                              │ details      │
│  ├ brand    │  session header              │  ├ header    │
│  ├ actions  │  message stream (serif)      │  └ items     │
│  ├ items    │  └ conversation.hero         │              │
│  └ footer   │  composer (16px radius)      │              │
└─────────────┴──────────────────────────────┴──────────────┘
        shell.overlay  — spans the window, above everything
```

## The 12 slots

The value of a shell is the surface it opens, not the pixels it draws. A plugin
written later adds a feature with a one-line declaration:

```json
"ui": { "injects": [
  { "slot": "dsh-web.sidebar.items",           "component": "MySessions" },
  { "slot": "dsh-web.conversation.input.right", "component": "MyModelPicker" }
] }
```

No change here, no rebuild, no ordering requirement — a contribution made
**before** the shell loads is remembered and appears when it does.

| Slot | Where |
|---|---|
| `dsh-web.sidebar.brand` | Beside the brand mark |
| `dsh-web.sidebar.actions` | Sidebar header buttons |
| `dsh-web.sidebar.items` | The main sidebar list |
| `dsh-web.sidebar.footer` | Sidebar footer (status, account) |
| `dsh-web.conversation.header.actions` | Session header buttons |
| `dsh-web.conversation.hero` | Empty state, before the first message |
| `dsh-web.conversation.overlay` | Floated over the message stream |
| `dsh-web.conversation.input.dock` | Around the composer |
| `dsh-web.conversation.input.right` | Inside the composer, after Send |
| `dsh-web.details.header` | Right column header |
| `dsh-web.details.items` | Right column body |
| `dsh-web.shell.overlay` | Whole window, above everything |

Declared in Rust (`SLOTS` → `provides`), which is the contract the host and the
slot inspector see, **and** mounted in JS. Declaring in the manifest is what makes
a name collision with another plugin an **error** rather than two silently
half-filled regions.

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
slot. What transfers is the design language, and that is what was taken.

## Source layout

```
js/
  entry.js                 apply tokens, install motion, register the component
  style.css                the look (320 lines)
  lib/
    tokens.js              structural scale + 2 palettes
    motion.js              12 keyframes, one name each
    dom.js                 element builder, token ref, region helper
    slots.js               the slot inventory + mount helper
    api.js                 backend commands (degrades without IPC)
  panels/
    shell.js               the three columns + frame overlay
    sidebar.js             brand / actions / items / footer
    conversation.js        header / stream / composer
    details.js             header / items (slot surface only)
```

Assets are `include_str!` from `js/`, so the script text stays a real `.js` file
while travelling inside the `.wasm`.

## Two bugs found while building this

Both were invisible from the host side, and both are now covered by tests:

* **`lib/motion.js` was on disk but not in the plugin's `assets`.** `require`
  only sees declared assets, so the shell threw at load and rendered nothing.
  A file that exists but is not declared is invisible in a way nothing else
  catches — hence a test that asserts every module `entry.js` requires ships.
* **The host's own `body` background won.** `theme.css` sets
  `body { background: var(--bg-canvas) }` (near-black) beneath this plugin's
  shell, showing through at the edges. The plugin now paints `html` *and* `body`,
  verified by computing the cascaded value with both stylesheets loaded — not by
  eyeballing a screenshot, which proved unreliable while other windows overlapped.

## Build

```sh
cargo build --release -p dsh-web-shell -p demo-shell-addon --target wasm32-wasip1
```

Load `dsh_web_shell.wasm` and `demo_shell_addon.wasm` from the Plugins page. The
shell takes the launch view immediately.

## Honest limitations

* **One shell at a time.** Only one plugin may declare `open: "startup"`.
* **`content: "app"` only.** The `content: "html"` window path still renders
  blank (tracked in `docs/已知问题.md`).
* **No bundled webfonts.** Hana ships Inter + EB Garamond (6.4 MB). This uses
  system faces, which loses some fidelity but keeps the plugin small; adding a
  Latin subset later is straightforward.
* **Nav entries are placeholders.** Real pages need backend features we do not
  have yet (sessions, git, terminal).
* **No paper texture.** Upstream's `warm-paper` inlines a base64 PNG grain; it is
  omitted here to keep the asset small.
