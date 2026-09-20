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

## Resizing

Every panel edge is draggable, and the sizes persist per target:

| Handle | Drags | Range | Storage key |
|---|---|---|---|
| Sidebar's right edge | `--dw-sidebar-width` | 180–480 | `hana-shell-sidebar-width` |
| Preview's left edge | `--dw-preview-width` | 320–(window − others − 400) | `hana-shell-preview-width` |
| Rail's left edge | `--dw-rail-width` | 200–600 | `hana-shell-rail-width` |
| Titlebar's bottom edge | `--dw-titlebar-h` | 36–120 | `hana-shell-titlebar-height` |

**Double-click any handle** to reset that target to its token default. The
preview's ceiling is computed live, so widening it can never push the
conversation below its 400px minimum.

The drag target **is** the visible 3px line, not an invisible band laid over the
column's edge — the sidebar is full of rows to click and a wide invisible strip
swallows those clicks. The line is faintly visible at rest so "put the cursor on
the line" is discoverable at all, and turns accent-coloured on hover.

The titlebar height is shared: the column headers read the same
`--dw-titlebar-h`, so a drag on any of them keeps the four bars aligned. (An
earlier version gave the headers their own variable; dragging one bar and
watching the headers stay put was worse, not better.)

The mechanism is `lib/resize.js` — one function for both axes, talking in
`data-resize` names rather than pixels, so a plugin that opens its own side
column can reuse it.

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
    resize.js              drag-to-resize, both axes (see "Resizing")
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

## Tests

```sh
npm test        # in this directory
```

Three node harnesses under `tests/`, plus one optional:

* `css-guards.test.mjs` — reads the stylesheet and catches the shapes of
  mistake a layout-blind test cannot. **Zero dependencies.**
* `css-cascade.test.mjs` — runs the stylesheet through a real cascade and
  asserts the handle keeps its own geometry. Needs **jsdom**; skips *loudly*
  without it (a silent skip would read as "checked and fine").
* `render.test.mjs` — stands up a fake Tauri IPC and asserts the tree builds,
  every declared slot mounts, and real backend data renders.
* `resize.test.mjs` — simulates drags as real mouse events: both axes, clamping,
  persistence, reset, the dynamic preview ceiling, collapsed-column refusal.

They are not ceremony. Between them they have caught:

* **the drag sign inverted** — every handle moved the wrong way;
* **the handle stretched across the whole column** — `.hn-side > *` matched the
  3px handle too, so the *entire sidebar* became a drag surface and nothing
  inside it could be clicked. The DOM shim cannot see this (no layout engine)
  and the eye cannot either until you try to click a row; `css-cascade`
  reproduces it exactly, and fails with `computed width was
  var(--dw-sidebar-width)` when the fix is reverted.

### Why not a library for resizing?

Split.js, `interact.js` and `react-resizable-panels` all exist and are fine, but
they solve a different shape of problem than this shell has:

| | Split.js, etc. | this shell |
|---|---|---|
| Layout | take over the children, size them `calc(% - px)` | CSS custom properties, fixed widths |
| Collapse | not their concern | width → 0, keeping the slot's contributions |
| Persistence | not provided | per-target, with reset |
| Modules | npm package, bundled | `include_str!` into the wasm, no bundler |
| Runtime deps | 0 (Split.js) | 0, deliberately |

Adopting one would mean giving up the collapse-to-zero behaviour and the token
model, to delete ~140 lines. The part that is genuinely fiddly (clamping live,
persisting, the dynamic ceiling) is not what these libraries provide anyway.
What *was* worth taking from the ecosystem is the **testing** approach above: a
real cascade beats reading CSS as text, and that is now in `npm test`.

## What is live, and what is a frame

The shell talks to the **real** backend, not a mock-up:

| Region | Source |
|---|---|
| Session list | `list_sessions` — live agents **and** sessions on disk, titled from the first user message |
| Session tokens | the session's `AssistantMessage` events, summed per session |
| Composer | creates an agent on a **configured** provider, sends, polls the reply |
| Sidebar footer | `studio_status` — boot state and the registered providers |
| Rail | `studio_status` + `list_plugins` + `plugin_windows` + `list_tools` |
| Preview | a slot only; nothing fills it yet |

**Stored sessions are rows too, and opening one continues it.** A session left on
disk by a previous run is listed with a hollow dot and `data-live="false"`;
clicking it calls `resume_session`, which builds a live agent on the stored log,
and then it behaves like any other session. They are *marked*, not hidden — a
list that omitted what is on disk would make persistence look broken — and the
mark matters because a stored row cannot be sent to until it is resumed. If a
resume fails the history is still shown, but the composer locks, so the failure
reads as *read-only* rather than as the app losing the message.

**The provider picker is the important one.** It used to hardcode `mock`, which
silently ignored any endpoint configured in `studio.json` while appearing to
work. It now reads the registered routes and prefers anything over `mock`,
because `mock` echoes the input — it is a test double, not a model.

**Token counts are shown only when reported.** dsh attaches usage to each
assistant message, but not every provider reports it — and a streaming provider
that places its usage chunk *after* `Finish` is never heard, because the agent
loop stops at `Finish`. `calls === 0` therefore renders as *nothing*, not as
"0 tokens": the second would read as a measurement, and it would be a false one.

## Honest limitations

* **One shell at a time.** Only one plugin may declare `open: "startup"`.
* **`content: "app"` only.** The `content: "html"` window path still renders
  blank (tracked in `docs/已知问题.md`).
* **No bundled webfonts.** Hana ships Inter + EB Garamond + Noto Serif SC
  (6.4 MB). This uses system faces, which loses some fidelity but keeps the
  plugin small; adding a Latin subset later is straightforward.
* **No paper texture.** Upstream's `warm-paper` inlines a base64 PNG grain; it is
  omitted here to keep the asset small.
* **The activity bars are frames.** Bridge / Activity / Automation / Skills are
  affordances with no feature behind them — the shell does not own automations
  or skills. Clicking one is a no-op until a plugin binds to its `data-activity`.
* **No streaming.** dsh has no push channel to the frontend here, so the reply
  arrives by polling the transcript every 250 ms, bounded. A long turn therefore
  appears all at once rather than typing itself out.
* **The preview column starts collapsed.** The titlebar's ⧉ button opens it;
  until a plugin fills `hana.preview.panel` it is an empty frame.
* **Reasoning is collapsed by default**, and tool calls are summarised as a list
  of names — the transcript carries their arguments, but the shell does not
  render them yet.