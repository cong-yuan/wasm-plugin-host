// demo-openhanako-addon — example components for openhanako.* slots.
// Only uses public slot names; does not touch openhanako-shell internals.

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
    'line-height:1.55;box-sizing:border-box;';
  el.innerHTML =
    '<div style="font-size:10px;font-weight:600;letter-spacing:.04em;' +
    'text-transform:uppercase;opacity:.65;margin-bottom:4px"></div>' +
    '<div class="ohk-card-body"></div>';
  el.querySelector('div').textContent = title;
  el.querySelector('.ohk-card-body').innerHTML = body;
  return el;
}

studio.register('OhkTitlebarLeftBadge', (el) => {
  el.appendChild(chip('OHK·L', { id: 'ohk-titlebar-left', style: 'margin-left:4px;' }));
});

studio.register('OhkTitlebarCenterHint', (el) => {
  el.appendChild(chip('slot: titlebar.center', {
    id: 'ohk-titlebar-center',
    style: 'opacity:.85;background:#3ecf8e18;border-color:#3ecf8e55;',
  }));
});

studio.register('OhkTitlebarRightButton', (el) => {
  const b = chip('OHK Addon', { tag: 'button', id: 'ohk-titlebar-right', style: 'cursor:pointer;' });
  b.onclick = () => {
    b.textContent = b.textContent === 'OHK Addon' ? 'clicked!' : 'OHK Addon';
  };
  el.appendChild(b);
});

studio.register('OhkSidebarHeaderTag', (el) => {
  el.appendChild(chip('header+', {
    id: 'ohk-sidebar-header',
    style: 'margin-left:6px;background:#0000000a;',
  }));
});

studio.register('OhkSidebarActivityPill', (el) => {
  el.appendChild(chip('activity inject', {
    id: 'ohk-sidebar-activities',
    style: 'display:block;margin:4px 8px;background:#6c8cff18;border-color:#6c8cff55;color:#3a4f9a;',
  }));
});

studio.register('OhkSidebarSessionsRow', (el) => {
  el.appendChild(card(
    'sessions inject',
    'demo row under the session list — <code>openhanako.sidebar.sessions</code>',
    'ohk-sidebar-sessions',
  ));
});

studio.register('OhkSidebarNotice', (el) => {
  const d = card(
    'sidebar.notice',
    'demo-openhanako-addon notice strip (geometry from real UI anchor)',
    'ohk-sidebar-notice',
  );
  d.style.background = '#3ecf8e18';
  d.style.borderColor = '#3ecf8e55';
  d.style.color = '#2a6b4a';
  el.appendChild(d);
});

studio.register('OhkSidebarFooter', (el) => {
  el.appendChild(chip('footer slot', {
    id: 'ohk-sidebar-footer',
    style: 'display:block;margin:6px 8px;text-align:center;',
  }));
});

studio.register('OhkConversationHero', (el) => {
  el.appendChild(card(
    'conversation.hero',
    'Shown on the welcome / empty state region.',
    'ohk-conversation-hero',
  ));
});

studio.register('OhkConversationStreamMark', (el) => {
  const d = chip('stream+', {
    id: 'ohk-conversation-stream',
    style: 'position:sticky;top:8px;margin:8px;background:#fff;box-shadow:0 1px 4px #0001;',
  });
  el.appendChild(d);
});

studio.register('OhkComposerDockChip', (el) => {
  el.appendChild(chip('ohk-dock', {
    id: 'ohk-input-dock',
    style: 'border-radius:999px;background:#00000012;',
  }));
});

studio.register('OhkComposerRightAction', (el) => {
  const b = chip('OHK→', {
    tag: 'button',
    id: 'ohk-input-right',
    style: 'cursor:pointer;border-radius:999px;',
  });
  b.title = 'openhanako.conversation.input.right';
  b.onclick = () => { b.textContent = b.textContent === 'OHK→' ? 'OK' : 'OHK→'; };
  el.appendChild(b);
});

studio.register('OhkPreviewBanner', (el) => {
  el.appendChild(card(
    'preview.panel',
    'Example inject into the preview column.',
    'ohk-preview-panel',
  ));
});

studio.register('OhkRailHeader', (el) => {
  el.appendChild(chip('rail.header', {
    id: 'ohk-rail-header',
    style: 'display:block;margin:8px;font-weight:600;',
  }));
});

studio.register('OhkRailCard', (el) => {
  el.appendChild(card(
    'rail.items',
    'Injected into <b>openhanako.rail.items</b> via describe → injects.',
    'ohk-rail-items',
  ));
});

studio.register('OhkShellToast', (el) => {
  const d = document.createElement('div');
  d.setAttribute('data-addon', 'ohk-shell-overlay');
  d.style.cssText =
    'pointer-events:auto;position:absolute;top:16px;right:16px;max-width:280px;' +
    'padding:12px 14px;border-radius:12px;border:1px solid #c4b8a4;' +
    'background:#1f1a14f0;color:#fff8ee;font-size:12px;line-height:1.5;' +
    'box-shadow:0 8px 24px #0004;';
  d.innerHTML =
    '<div style="font-weight:600;margin-bottom:4px">shell.overlay demo</div>' +
    '<div style="opacity:.85;margin-bottom:8px">Case component on the full-window slot.</div>';
  const btn = document.createElement('button');
  btn.textContent = 'Dismiss';
  btn.style.cssText =
    'font:inherit;font-size:11px;padding:4px 10px;border-radius:6px;' +
    'border:1px solid #ffffff44;background:transparent;color:inherit;cursor:pointer;';
  btn.onclick = () => { d.remove(); };
  d.appendChild(btn);
  el.appendChild(d);
});

// Wire examples → slots (priority 10)
const WIRING = [
  ['openhanako.titlebar.left', 'OhkTitlebarLeftBadge'],
  ['openhanako.titlebar.center', 'OhkTitlebarCenterHint'],
  ['openhanako.titlebar.right', 'OhkTitlebarRightButton'],
  ['openhanako.sidebar.header', 'OhkSidebarHeaderTag'],
  ['openhanako.sidebar.activities', 'OhkSidebarActivityPill'],
  ['openhanako.sidebar.sessions', 'OhkSidebarSessionsRow'],
  ['openhanako.sidebar.notice', 'OhkSidebarNotice'],
  ['openhanako.sidebar.footer', 'OhkSidebarFooter'],
  ['openhanako.conversation.hero', 'OhkConversationHero'],
  ['openhanako.conversation.stream', 'OhkConversationStreamMark'],
  ['openhanako.conversation.input.dock', 'OhkComposerDockChip'],
  ['openhanako.conversation.input.right', 'OhkComposerRightAction'],
  ['openhanako.preview.panel', 'OhkPreviewBanner'],
  ['openhanako.rail.header', 'OhkRailHeader'],
  ['openhanako.rail.items', 'OhkRailCard'],
  ['openhanako.shell.overlay', 'OhkShellToast'],
];
for (const [slot, component] of WIRING) {
  studio.inject(slot, component, 10);
}
