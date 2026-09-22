// Extends openhanako-shell using only its public openhanako.* slot names.
studio.register('OhkAddonHeaderButton', (el) => {
  const b = document.createElement('button');
  b.textContent = 'OHK Addon';
  b.setAttribute('data-addon', 'ohk-header-button');
  b.style.cssText =
    'pointer-events:auto;width:auto;padding:4px 10px;border-radius:6px;' +
    'border:1px solid #c4b8a4;background:#fff8ee;font:inherit;font-size:11px;' +
    'color:#5c5346;cursor:pointer';
  b.onclick = () => {
    b.textContent = b.textContent === 'OHK Addon' ? 'clicked!' : 'OHK Addon';
  };
  el.appendChild(b);
});

studio.register('OhkAddonNotice', (el) => {
  const d = document.createElement('div');
  d.setAttribute('data-addon', 'ohk-notice');
  d.style.cssText =
    'pointer-events:auto;font-size:11px;padding:8px 10px;border-radius:8px;' +
    'background:#3ecf8e18;border:1px solid #3ecf8e55;color:#2a6b4a;';
  d.textContent = 'demo-openhanako-addon → sidebar.notice';
  el.appendChild(d);
});

studio.register('OhkAddonComposerChip', (el) => {
  const s = document.createElement('span');
  s.setAttribute('data-addon', 'ohk-composer-chip');
  s.style.cssText =
    'pointer-events:auto;font-size:11px;padding:2px 8px;border-radius:999px;' +
    'background:#00000012;color:#5c5346;';
  s.textContent = 'ohk-dock';
  el.appendChild(s);
});

studio.register('OhkAddonRailCard', (el) => {
  const d = document.createElement('div');
  d.setAttribute('data-addon', 'ohk-rail-card');
  d.style.cssText =
    'pointer-events:auto;padding:12px 14px;margin:4px 0;border-radius:10px;' +
    'border:1px solid #c4b8a4;background:#fff8ee;font-size:12px;color:#5c5346;' +
    'line-height:1.6;';
  d.innerHTML =
    '<div style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;' +
    'opacity:.7;margin-bottom:4px">From demo-openhanako-addon</div>' +
    'Injected into <b>openhanako.rail.items</b> without touching the shell iframe.';
  el.appendChild(d);
});

studio.inject('openhanako.titlebar.right', 'OhkAddonHeaderButton', 10);
studio.inject('openhanako.sidebar.notice', 'OhkAddonNotice', 10);
studio.inject('openhanako.conversation.input.dock', 'OhkAddonComposerChip', 10);
studio.inject('openhanako.rail.items', 'OhkAddonRailCard', 10);
