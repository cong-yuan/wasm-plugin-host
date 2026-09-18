// Adds four things to the dsh-web shell, using only its public slot names.
//
// Nothing here imports the shell's code or knows how it is built — which is the
// whole point of a slot: the shell can be rewritten and this keeps working, as
// long as the names hold.
studio.register('AddonClock', (el) => {
  const tick = () => { el.textContent = new Date().toLocaleTimeString(); };
  tick();
  const iv = setInterval(tick, 1000);
  el.style.cssText = 'font-size:11px;color:var(--dw-text-tertiary)';
  return () => clearInterval(iv);
});

studio.register('AddonHeaderButton', (el) => {
  const b = document.createElement('button');
  b.textContent = 'Addon';
  b.setAttribute('data-addon', 'header-button');
  b.style.cssText =
    'padding:3px 10px;border-radius:6px;font:inherit;font-size:11px;cursor:pointer;' +
    'border:1px solid var(--dw-border);background:transparent;color:var(--dw-text-secondary)';
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
    'font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dw-fill-secondary);' +
    'color:var(--dw-text-tertiary)';
  el.appendChild(s);
});

studio.register('AddonSidebarRows', (el) => {
  for (const label of ['Usage', 'Task board']) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('data-addon', 'sidebar-row');
    b.style.cssText =
      'display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;' +
      'border-radius:6px;cursor:pointer;font:inherit;font-size:13px;text-align:left;' +
      'color:var(--dw-text-tertiary);background:transparent';
    b.onmouseenter = () => { b.style.background = 'var(--dw-fill-secondary)'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; };
    el.appendChild(b);
  }
});

studio.register('AddonDetailsPanel', (el) => {
  el.style.cssText = 'padding:12px 14px;border-bottom:1px solid var(--dw-border-tertiary)';
  el.innerHTML =
    '<div style="font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;' +
    'color:var(--dw-text-quaternary);margin-bottom:6px">From the addon</div>' +
    '<div style="font-size:12px;color:var(--dw-text-tertiary);line-height:1.7">' +
    'This panel is contributed by a <b>different plugin</b>, through a slot the shell opened. ' +
    'The shell has no knowledge of it.</div>';
});

// One declaration per host slot. No ordering requirement: this plugin may load
// before or after the shell.
studio.inject('dsh-web.sidebar.items', 'AddonSidebarRows', 10);
studio.inject('dsh-web.conversation.header.actions', 'AddonHeaderButton', 10);
studio.inject('dsh-web.conversation.input.right', 'AddonComposerChip', 10);
studio.inject('dsh-web.details.items', 'AddonDetailsPanel', 10);
