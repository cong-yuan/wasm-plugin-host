// Slot inventory for openhanako-shell.
//
// Keep names in lockstep with `SLOTS` in `src/lib.rs`. Placement comes from the
// iframe geometry bridge (real UI anchors), not guessed overlay coordinates.
return (function () {
  const SLOTS = [
    { name: 'openhanako.titlebar.left', desc: 'Titlebar left cluster (sidebar toggle side)' },
    { name: 'openhanako.titlebar.center', desc: 'Titlebar centre (title / channel tabs)' },
    { name: 'openhanako.titlebar.right', desc: 'Titlebar right cluster (widgets / toggles)' },
    { name: 'openhanako.sidebar.header', desc: 'Sidebar header row' },
    { name: 'openhanako.sidebar.activities', desc: 'Sidebar activity bars' },
    { name: 'openhanako.sidebar.sessions', desc: 'Session list region' },
    { name: 'openhanako.sidebar.notice', desc: 'Notice strip near sidebar footer' },
    { name: 'openhanako.sidebar.footer', desc: 'Sidebar footer' },
    { name: 'openhanako.conversation.header', desc: 'Conversation header' },
    { name: 'openhanako.conversation.hero', desc: 'Empty-state / welcome' },
    { name: 'openhanako.conversation.stream', desc: 'Message stream region' },
    { name: 'openhanako.conversation.input.dock', desc: 'Composer dock' },
    { name: 'openhanako.conversation.input.right', desc: 'Composer trailing actions' },
    { name: 'openhanako.preview.panel', desc: 'Preview panel' },
    { name: 'openhanako.rail.header', desc: 'Right rail header' },
    { name: 'openhanako.rail.items', desc: 'Right rail body' },
    { name: 'openhanako.shell.overlay', desc: 'Full-window overlay' },
  ];

  const mount = (slotName, parent) => {
    const box = document.createElement('div');
    box.dataset.hostSlot = slotName;
    box.className = 'ohk-slot';
    box.style.cssText =
      'position:absolute;display:none;pointer-events:none;box-sizing:border-box;' +
      'overflow:auto;z-index:2;';
    parent.appendChild(box);

    let dispose = null;
    try {
      dispose = studio.renderSlot(slotName, box);
    } catch (_) {}

    const sync = () => {
      // CRITICAL: host must never capture clicks — only contribution nodes may
      // set pointer-events:auto on themselves. A full-region host (stream /
      // shell.overlay) with pointer-events:auto blanks the real UI.
      box.style.pointerEvents = 'none';
      const has = !!box.querySelector('[data-contribution]');
      if (has) box.dataset.hasContribution = '1';
      else delete box.dataset.hasContribution;
    };
    const mo = new MutationObserver(sync);
    mo.observe(box, { childList: true, subtree: true });
    sync();

    return {
      el: box,
      dispose: () => {
        mo.disconnect();
        if (typeof dispose === 'function') dispose();
        box.remove();
      },
    };
  };

  return { SLOTS, mount };
})();
