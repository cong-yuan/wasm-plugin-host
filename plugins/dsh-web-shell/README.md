# dsh-web-shell

A recreation of the [dsh-web](https://github.com/zhu1090093659/dsh-web) shell, as
a WASM plugin. This time from **source**, not a reverse-engineered bundle — so
the layout and slot names are copied rather than guessed.

It claims the launch view (`open: "startup"`), so the app opens *its* window at
startup and keeps its own hidden.

```
┌─────────────┬──────────────────────────────┬──────────────┐
│ 232px       │ main.conversation            │ 260px        │
│ sidebar     │                              │ details      │
│  ├ brand    │  conversation.session.header │  ├ header    │
│  ├ actions  │  conversation (messages)     │  └ items     │
│  ├ items    │  conversation.input.dock     │              │
│  └ footer   │    └ conversation.composer   │              │
└─────────────┴──────────────────────────────┴──────────────┘
        shell.overlay  — spans the whole window, above everything
```

## The point: a slot at every region

The value of a shell is the **surface it opens**, not the pixels it draws. Every
region above is a slot, so a plugin written later adds a feature with a one-line
declaration:

```json
"ui": { "injects": [
  { "slot": "dsh-web.sidebar.footer",  "component": "MyStatus" },
  { "slot": "dsh-web.conversation.input.right", "component": "MyChip" }
] }
```

No change to this plugin, no rebuild, no ordering requirement — a contribution
made **before** the shell loads is remembered and appears when it does.

### The 12 slots

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

The names follow dsh-web's own `data-slot` convention (`sidebar.…`,
`conversation.…`, `details`, `shell.overlay`), so the recreation reads the same
as the project it copies. The `dsh-web.` prefix keeps them distinct from other
plugins' slots.

**Declared in two places on purpose.** Rust (`SLOTS` → `provides`) is the
contract the host and the slot inspector see; JS (`lib/slots.js` → `renderSlot`)
is where they are mounted. Declaring in the manifest means a name collision with
another plugin is an **error**, not two half-filled regions.

## Proof it works: `demo-shell-addon`

A second plugin contributes to four of these slots while knowing **nothing**
about the shell's internals. Verified against the running app — the `dsh` window
showed all four contributions:

| Addon declares | Appeared as |
|---|---|
| `dsh-web.sidebar.items` | `Usage`, `Task board` rows |
| `dsh-web.conversation.header.actions` | an `Addon` button |
| `dsh-web.conversation.input.right` | a `mock-1` chip |
| `dsh-web.details.items` | a "from the addon" panel |

The addon was loaded **first**, before the shell that opens its slots — so this
also demonstrates order-independence.

## Source layout

```
js/
  entry.js                 apply tokens, register the component(s)
  style.css                scrollbars, motion, and "empty slot takes no space"
  lib/
    dom.js                 element builder + `data-slot` region helper
    tokens.js              dark/light palettes
    slots.js               the slot inventory + `mount()` helper
    api.js                 backend commands (degrades without IPC)
  panels/
    shell.js               the three columns + frame overlay
    sidebar.js             brand / actions / items / footer
    conversation.js        header / stream / composer
    details.js             header / items
```

Assets are `include_str!` from `js/`, so the script text is a real `.js` file
while still travelling inside the `.wasm`.

## What is real, and what is not

| Part | Status |
|---|---|
| Three-column layout, region anchors, 12 slots | **Real**, names copied from dsh-web |
| Slot contributions from another plugin | **Real**, verified in the running app |
| Chat over the dsh agent loop | **Real** — creates an agent, streams the transcript |
| Live status / counts, theme switching | **Real** |
| Nav entries | **Placeholder** — the shell's own list; a plugin may replace it via slots |
| dsh-web's skins, workshop, mobile adapt, i18n | **Not attempted** |

## Build

```sh
cargo build --release -p dsh-web-shell -p demo-shell-addon --target wasm32-wasip1
```

Load both `dsh_web_shell.wasm` and `demo_shell_addon.wasm` from the Plugins page.

## Honest limitations

* **One shell at a time.** Only one plugin may declare `open: "startup"`.
* **`content: "app"` only.** The `content: "html"` window path still renders
  blank (tracked in `docs/已知问题.md`).
* **No i18n.** Copy is hardcoded English; dsh-web carries 87 namespaces.
* **This is a shell, not a product.** The nav entries are placeholders: real
  pages need backend features (sessions, git, terminal) we do not have yet.
