// demo-openhanako-addon — safe slot examples (small regions only).
// Does NOT inject into full-pane slots (stream / hero / shell.overlay) —
// those would cover the real UI once the host box is shown.

function chip(text, opts) {
  const el = document.createElement(opts && opts.tag || 'div');
  el.textContent = text;
  el.setAttribute('data-addon', opts && opts.id || 'ohk-chip');
  el.style.cssText =
    'pointer-events:auto;font:inherit;font-size:11px;line-height:1.4;' +
    'padding:4px 8px;border-radius:6px;border:1px solid #c4b8a4;' +
    'background:#fff8ee;color:#5c5346;white-space:nowrap;' +
    (opts && opts.style || '');
  return el;
}

function card(title, body, id) {
  const el = document.createElement('div');
  el.setAttribute('data-addon', id || 'ohk-card');
  el.style.cssText =
    'pointer-events:auto;padding:10px 12px;margin:4px 0;border-radius:10px;' +
    'border:1px solid #c4b8a4;background:#fff8ee;font-size:12px;color:#5c5346;' +
    'line-height:1.55;box-sizing:border-box;max-width:240px;';
  el.innerHTML =
    '<div style="font-size:10px;font-weight:600;letter-spacing:.04em;' +
    'text-transform:uppercase;opacity:.65;margin-bottom:4px"></div>' +
    '<div class="ohk-card-body"></div>';
  el.querySelector('div').textContent = title;
  el.querySelector('.ohk-card-body').innerHTML = body;
  return el;
}

studio.register('OhkTitlebarRightButton', (el) => {
  const b = chip('OHK Addon', { tag: 'button', id: 'ohk-titlebar-right', style: 'cursor:pointer;' });
  b.onclick = () => {
    b.textContent = b.textContent === 'OHK Addon' ? 'clicked!' : 'OHK Addon';
  };
  el.appendChild(b);
});

studio.register('OhkSidebarNotice', (el) => {
  const d = card(
    'sidebar.notice',
    'Safe demo inject — small notice strip only.',
    'ohk-sidebar-notice',
  );
  d.style.background = '#3ecf8e18';
  d.style.borderColor = '#3ecf8e55';
  d.style.color = '#2a6b4a';
  el.appendChild(d);
});

studio.register('OhkComposerDockChip', (el) => {
  el.appendChild(chip('ohk-dock', {
    id: 'ohk-input-dock',
    style: 'border-radius:999px;background:#00000012;',
  }));
});

studio.register('OhkRailCard', (el) => {
  el.appendChild(card(
    'rail.items',
    'Injected into <b>openhanako.rail.items</b>.',
    'ohk-rail-items',
  ));
});

// SAFE slots only — never full-pane regions
studio.inject('openhanako.titlebar.right', 'OhkTitlebarRightButton', 10);
studio.inject('openhanako.sidebar.notice', 'OhkSidebarNotice', 10);
studio.inject('openhanako.conversation.input.dock', 'OhkComposerDockChip', 10);
studio.inject('openhanako.rail.items', 'OhkRailCard', 10);
