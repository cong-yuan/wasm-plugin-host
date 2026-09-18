// The right column. A slot at the header and in the body, so a later plugin can
// put its panel here without this file knowing what it is.
return (function () {
  const { h, sv } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');
  const tokens = studio.require('lib/tokens');

  const render = (el) => {
    const root = h('aside', {
      'data-slot': 'details',
      style:
        'width:260px;flex:0 0 260px;display:flex;flex-direction:column;min-height:0;' +
        'background:' + sv('bg-layout') + ';border-left:1px solid ' + sv('border-secondary'),
    });

    const header = h('div', {
      'data-slot': 'details.header',
      style:
        'display:flex;align-items:center;gap:8px;padding:10px 14px;min-height:40px;' +
        'border-bottom:1px solid ' + sv('border-secondary') +
        ';font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:' + sv('text-quaternary'),
    }, 'Details');
    const headerSlot = h('div', { style: 'margin-left:auto;display:flex;gap:4px' });
    S.mount('dsh-web.details.header', headerSlot);
    header.appendChild(headerSlot);
    root.appendChild(header);

    const body = h('div', {
      'data-slot': 'details.items',
      style: 'flex:1;overflow-y:auto',
    });
    root.appendChild(body);

    // The shell's own content — a plugin can hide it with `ui.adjusts`, which is
    // the point of putting it in a slot-named container rather than loose DOM.
    const metrics = h('div', { 'data-shell-part': 'metrics', style: 'padding:12px 14px;border-bottom:1px solid ' + sv('border-tertiary') });
    const row = (k, v) => h('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:10px;font-size:12px;line-height:1.9' },
      h('span', { style: 'color:' + sv('text-tertiary'), text: k }),
      h('span', { style: 'color:' + sv('text-secondary') + ';text-align:right', text: String(v) }));
    const refresh = async () => {
      const [s, ps, ts] = await Promise.all([api.status(), api.plugins(), api.tools()]);
      metrics.replaceChildren(
        row('plugins', ps.length), row('tools', ts.length),
        row('services', s ? s.service_count : '—'),
        row('watcher', s && s.watching ? 'on' : 'off'));
    };
    refresh();
    body.appendChild(metrics);

    // Theme switcher — also proves the tokens are live.
    const theme = h('div', { 'data-shell-part': 'theme', style: 'padding:12px 14px;border-bottom:1px solid ' + sv('border-tertiary') });
    const pick = h('div', { style: 'display:flex;gap:6px' });
    for (const name of tokens.names) {
      pick.appendChild(h('button', {
        text: name, title: 'Switch palette',
        style: 'padding:3px 9px;border-radius:999px;font:inherit;font-size:11px;cursor:pointer;' +
               'border:1px solid ' + sv('border') + ';background:transparent;color:' + sv('text-tertiary'),
        onclick: () => tokens.apply(document.documentElement, name),
      }));
    }
    theme.appendChild(pick);
    body.appendChild(theme);

    // Plugins contributed here land below the shell's own parts.
    const pluginArea = h('div', { style: 'padding:0 0 8px' });
    body.appendChild(pluginArea);
    S.mount('dsh-web.details.items', pluginArea);

    const iv = setInterval(refresh, 8000);
    el.appendChild(root);
    return () => clearInterval(iv);
  };
  return { render };
})();
