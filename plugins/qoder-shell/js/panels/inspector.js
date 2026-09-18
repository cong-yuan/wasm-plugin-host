// The right rail: what the shell is connected to. Mirrors Qoder's activity /
// detail pane, and gives the recreation somewhere honest to show real state.
return (function () {
  const { h, sv, muted } = studio.require('lib/dom');
  const api = studio.require('lib/api');

  const section = (title, body) => {
    const box = h('div', { style: 'padding:12px 14px;border-bottom:1px solid ' + sv('border-tertiary') });
    box.appendChild(h('div', {
      style: 'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:' +
             sv('text-quaternary') + ';margin-bottom:8px',
      text: title,
    }));
    box.appendChild(body);
    return box;
  };
  const row = (k, v) => h('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:10px;font-size:12px;line-height:1.9' },
    h('span', { style: 'color:' + sv('text-tertiary'), text: k }),
    h('span', { style: 'color:' + sv('text-secondary') + ';text-align:right;overflow:hidden;text-overflow:ellipsis', text: v }),
  );

  const render = (el) => {
    const root = h('aside', {
      style:
        'width:260px;flex:0 0 260px;overflow-y:auto;background:' + sv('bg-layout') +
        ';border-left:1px solid ' + sv('border-secondary'),
    });

    const metrics = h('div');
    root.appendChild(section('Workspace', metrics));

    const tools = h('div');
    root.appendChild(section('Tools', tools));

    // Theme picker — the nine Qoder palettes, switchable live.
    const tokens = studio.require('lib/tokens');
    const picker = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
    for (const name of tokens.names) {
      picker.appendChild(h('button', {
        text: name.replace(/-dark$/, ''),
        title: name,
        style:
          'padding:3px 8px;border-radius:999px;border:1px solid ' + sv('border') +
          ';background:transparent;color:' + sv('text-tertiary') + ';font:inherit;font-size:11px;cursor:pointer',
        onclick: () => {
          tokens.apply(document.documentElement, name);
          // Repaint everything so inline styles pick up the new variables.
          el.dispatchEvent(new CustomEvent('qs:theme', { bubbles: true }));
        },
      }));
    }
    root.appendChild(section('Theme', picker));

    const refresh = async () => {
      const [s, t, ps] = await Promise.all([api.status(), api.tools(), api.plugins()]);
      metrics.replaceChildren(
        row('plugins', String(ps.length)),
        row('tools', s ? String(s.tool_count ?? 0) : '—'),
        row('services', s ? String(s.service_count ?? 0) : '—'),
        row('watching', s && s.watching ? 'on' : 'off'),
      );
      tools.replaceChildren();
      if (!t.length) tools.appendChild(h('div', { style: muted(12), text: 'none' }));
      for (const item of t.slice(0, 14)) {
        tools.appendChild(h('div', {
          style: 'font-size:12px;line-height:1.8;color:' + sv('text-secondary') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          text: '· ' + item.name,
        }));
      }
    };
    refresh();
    const iv = setInterval(refresh, 8000);

    el.appendChild(root);
    return () => clearInterval(iv);
  };

  return { render };
})();
