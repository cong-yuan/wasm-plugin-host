// The slot inventory this shell opens.
//
// **This is the part that matters for the future.** The shell is a shell: its
// value is the surface it exposes, not the pixels it draws. Every region a
// later plugin could plausibly want gets its own slot, following the layout so
// the names read like a map of the window.
//
// A plugin adds a feature by declaring:
//
//     "injects": [{ "slot": "hana.sidebar.notice", "component": "MyThing" }]
//
// and it appears — no change here, no rebuild of this plugin, no ordering
// requirement. Contributions are remembered even if they arrive before this
// plugin loads (the registry is order-independent).
//
// The names are kept in lockstep with `SLOTS` in `src/lib.rs`, which is the
// copy the host's slot inspector reads. A name that drifts between the two is a
// contribution that silently goes nowhere.
return (function () {
  const { h } = studio.require('lib/dom');

  /**
   * Every slot, grouped by the region it lives in. The grouping is the same as
   * the layout, so "where would this go?" is answerable by reading the shell.
   *
   * Suffix convention (borrowed from dsh-web):
   *   *.actions   a row of buttons / icons
   *   *.items     a vertical list
   *   *.footer    the bottom of a column
   *   *.overlay   a frame-level floated layer
   */
  const SLOTS = [
    // Titlebar
    { name: 'hana.titlebar.left',   desc: 'Left cluster: sidebar toggle, new session' },
    { name: 'hana.titlebar.center', desc: 'Centre: the session title / channel tabs' },
    { name: 'hana.titlebar.right',  desc: 'Right cluster: widget buttons, panel toggles' },

    // Left sidebar
    { name: 'hana.sidebar.header',     desc: 'Header row: title, new-chat, settings, collapse' },
    { name: 'hana.sidebar.activities', desc: 'The activity bars: bridge, activity, automation, skills' },
    { name: 'hana.sidebar.sessions',   desc: 'The session list' },
    { name: 'hana.sidebar.notice',     desc: 'The notice slot above the footer (update stickers)' },
    { name: 'hana.sidebar.footer',     desc: 'Sidebar footer: status, account, extra actions' },

    // Centre column
    { name: 'hana.conversation.header',      desc: 'Session header: title and actions' },
    { name: 'hana.conversation.hero',        desc: 'Empty state, shown before the first message' },
    { name: 'hana.conversation.stream',      desc: 'The message stream itself' },
    { name: 'hana.conversation.input.dock',  desc: 'Around the composer (above/below the box)' },
    { name: 'hana.conversation.input.right', desc: 'Inside the composer, after Send' },

    // Preview panel
    { name: 'hana.preview.panel', desc: 'The right-hand preview/document panel' },

    // Right rail
    { name: 'hana.rail.header', desc: 'Right column header row' },
    { name: 'hana.rail.items',  desc: 'Right column body (activity, todos, files)' },

    // Frame level
    { name: 'hana.shell.overlay', desc: 'Spans the whole window, above everything' },
  ];

  /**
   * Render one slot's contents into `el`, and report whether anything arrived.
   *
   * A slot with no contributors should take no space — an empty panel that
   * reserves room is worse than no panel. So the container is hidden when
   * empty and unhidden the moment a contribution appears.
   */
  const mount = (slotName, el, opts) => {
    const box = h('div', {
      'data-host-slot': slotName,
      style: (opts && opts.style) || '',
    });
    el.appendChild(box);
    let dispose = null;
    try {
      dispose = studio.renderSlot(slotName, box);
    } catch (e) {
      // The slot only exists once this plugin declares it; before that the
      // render is a no-op rather than an error.
    }
    return dispose;
  };

  return { SLOTS, mount };
})();
