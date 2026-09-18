// The slot inventory this shell opens.
//
// **This is the part that matters for the future.** The shell is a shell: its
// value is the surface it exposes, not the pixels it draws. Every region a
// later plugin could plausibly want gets its own slot, following dsh-web's
// naming so the layout reads the same way.
//
// A plugin adds a feature by declaring:
//
//     "injects": [{ "slot": "dsh-web.sidebar.footer", "component": "MyThing" }]
//
// and it appears — no change here, no rebuild of this plugin, no ordering
// requirement. Contributions are remembered even if they arrive before this
// plugin loads (the registry is order-independent).
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
    // Left column
    { name: 'dsh-web.sidebar.brand',   desc: 'Beside the brand mark, top of the sidebar' },
    { name: 'dsh-web.sidebar.actions', desc: 'Icon buttons in the sidebar header row' },
    { name: 'dsh-web.sidebar.items',   desc: 'The main sidebar list, below the header' },
    { name: 'dsh-web.sidebar.footer',  desc: 'Sidebar footer: status, account, extra actions' },

    // Centre column
    { name: 'dsh-web.conversation.header.actions', desc: 'Buttons in the session header' },
    { name: 'dsh-web.conversation.hero',           desc: 'Empty-state area, shown before the first message' },
    { name: 'dsh-web.conversation.overlay',        desc: 'Floated over the message stream' },
    { name: 'dsh-web.conversation.input.dock',     desc: 'Around the composer (above/below the box)' },
    { name: 'dsh-web.conversation.input.right',    desc: 'Right of the send button, inside the composer' },

    // Right column
    { name: 'dsh-web.details.header', desc: 'Right column header row' },
    { name: 'dsh-web.details.items',  desc: 'Right column body' },

    // Frame level
    { name: 'dsh-web.shell.overlay', desc: 'Spans the whole window, above everything' },
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
