// Slot inventory for openhanako-shell.
//
// Keep names in lockstep with `SLOTS` in `src/lib.rs`. A drifted name is a
// contribution that silently goes nowhere.
//
// Prefix is `openhanako.*` (not `hana.*`) so this shell stays distinct from
// hana-shell while mirroring the same chrome regions.
return (function () {
  const SLOTS = [
    { name: 'openhanako.titlebar.left', desc: 'Left cluster overlay (sidebar toggle side)' },
    { name: 'openhanako.titlebar.center', desc: 'Centre title / channel tabs overlay' },
    { name: 'openhanako.titlebar.right', desc: 'Right cluster overlay (widget / panel toggles)' },
    { name: 'openhanako.sidebar.header', desc: 'Sidebar header row overlay' },
    { name: 'openhanako.sidebar.activities', desc: 'Activity bars overlay' },
    { name: 'openhanako.sidebar.sessions', desc: 'Session list overlay / below-list strip' },
    { name: 'openhanako.sidebar.notice', desc: 'Notice strip above sidebar footer' },
    { name: 'openhanako.sidebar.footer', desc: 'Sidebar footer overlay' },
    { name: 'openhanako.conversation.header', desc: 'Conversation header overlay' },
    { name: 'openhanako.conversation.hero', desc: 'Empty-state / hero overlay' },
    { name: 'openhanako.conversation.stream', desc: 'Message stream side overlay' },
    { name: 'openhanako.conversation.input.dock', desc: 'Around the composer (above/below)' },
    { name: 'openhanako.conversation.input.right', desc: 'Inside composer area, after Send' },
    { name: 'openhanako.preview.panel', desc: 'Right-hand preview panel overlay' },
    { name: 'openhanako.rail.header', desc: 'Right rail header overlay' },
    { name: 'openhanako.rail.items', desc: 'Right rail body overlay' },
    { name: 'openhanako.shell.overlay', desc: 'Full-window overlay above the iframe' },
  ];

  /**
   * Mount one slot into `parent` with absolute placement.
   * Empty hosts stay pointer-events:none so they never steal iframe clicks.
   */
  const mount = (slotName, parent, style) => {
    const box = document.createElement('div');
    box.dataset.hostSlot = slotName;
    box.className = 'ohk-slot';
    box.style.cssText =
      'pointer-events:none;box-sizing:border-box;' + (style || '');
    parent.appendChild(box);

    let dispose = null;
    try {
      dispose = studio.renderSlot(slotName, box);
    } catch (_) {
      // Slot only exists once this plugin declares it.
    }

    const sync = () => {
      const has = !!box.querySelector('[data-contribution]');
      box.style.pointerEvents = has ? 'auto' : 'none';
      box.style.visibility = has ? 'visible' : 'hidden';
    };
    const mo = new MutationObserver(sync);
    mo.observe(box, { childList: true, subtree: true });
    sync();

    return () => {
      mo.disconnect();
      if (typeof dispose === 'function') dispose();
      box.remove();
    };
  };

  return { SLOTS, mount };
})();
