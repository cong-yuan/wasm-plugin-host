// Adds four things to the Hana shell, using only its public slot names.
//
// Nothing here imports the shell's code or knows how it is built — which is the
// whole point of a slot: the shell can be rewritten and this keeps working, as
// long as the names hold. It contributes to the sidebar list, the titlebar's
// right cluster, the composer, and the right rail.
studio.register('AddonClock', (el) => {
  const tick = () => { el.textContent = new Date().toLocaleTimeString(); };
  tick();
  const iv = setInterval(tick, 1000);
  el.style.cssText = 'font-size:11px;color:var(--dw-text-muted)';
  return () => clearInterval(iv);
});

studio.register('AddonHeaderButton', (el) => {
  const b = document.createElement('button');
  b.textContent = 'Addon';
  b.setAttribute('data-addon', 'header-button');
  b.className = 'hn-tb-toggle';
  b.style.cssText =
    'width:auto;padding:0 10px;border-radius:6px;font:inherit;' +
    'font-size:11px;color:var(--dw-text-light)';
  b.onclick = () => {
    b.textContent = b.textContent === 'Addon' ? 'clicked!' : 'Addon';
  };
  el.appendChild(b);
});

studio.register('AddonComposerChip', (el) => {
  const s = document.createElement('span');
  s.textContent = 'mock-1';
  s.setAttribute('data-addon', 'composer-chip');
  s.style.cssText =
    'font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dw-overlay-light);' +
    'color:var(--dw-text-muted)';
  el.appendChild(s);
});

studio.register('AddonSidebarRows', (el) => {
  // The shell renders real sessions in the slot's own box; this plugin's rows
  // land in a separate contribution area beneath them, which is the point of
  // the slot: two owners, neither knowing about the other.
  for (const label of ['Usage', 'Task board']) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('data-addon', 'sidebar-row');
    b.className = 'hn-side-activity';
    b.style.cssText = 'margin:1px 0';
    el.appendChild(b);
  }
});

studio.register('AddonDetailsPanel', (el) => {
  el.style.cssText =
    'padding:12px 14px;margin:8px;border:1px solid var(--dw-border);' +
    'border-radius:var(--dw-radius-card);background:var(--dw-bg-card)';
  el.innerHTML =
    '<div style="font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;' +
    'color:var(--dw-text-muted);margin-bottom:6px">From the addon</div>' +
    '<div style="font-size:12px;color:var(--dw-text-light);line-height:1.7">' +
    'This panel is contributed by a <b>different plugin</b>, through a slot the shell opened. ' +
    'The shell has no knowledge of it.</div>';
});

// One declaration per host slot. No ordering requirement: this plugin may load
// before or after the shell.
studio.inject('hana.sidebar.sessions', 'AddonSidebarRows', 10);
studio.inject('hana.titlebar.right', 'AddonHeaderButton', 10);
studio.inject('hana.conversation.input.right', 'AddonComposerChip', 10);
studio.inject('hana.rail.items', 'AddonClock', 10);
studio.inject('hana.rail.items', 'AddonDetailsPanel', 20);
