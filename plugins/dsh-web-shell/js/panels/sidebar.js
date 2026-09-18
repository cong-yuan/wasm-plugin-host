// The left column, with a slot at every one of its four regions.
//
// Region order mirrors dsh-web: brand row → actions → the list → footer.
return (function () {
  const { h, sv, region } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  const render = (el) => {
    const root = h('aside', {
      'data-slot': 'sidebar',
      style:
        'width:232px;flex:0 0 232px;display:flex;flex-direction:column;min-height:0;' +
        'background:' + sv('bg-layout') + ';border-right:1px solid ' + sv('border-secondary'),
    });

    // ── brand row ────────────────────────────────────────────────────────────
    const brandRow = h('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:12px 14px 8px;min-height:40px',
    },
      h('span', { 'data-slot': 'sidebar.brand.mark',
        style: 'width:16px;height:16px;border-radius:4px;background:' + sv('primary') }),
      h('span', { 'data-slot': 'sidebar.brand.name',
        style: 'font-size:13px;font-weight:600;letter-spacing:-.01em', text: 'dsh' }),
    );
    // Slots: brand (beside the mark) and actions (the header's right side).
    const brandSlot = h('div', { style: 'display:flex;align-items:center;gap:6px' });
    S.mount('dsh-web.sidebar.brand', brandSlot);
    brandRow.appendChild(brandSlot);
    const actions = h('div', { style: 'margin-left:auto;display:flex;align-items:center;gap:4px' });
    S.mount('dsh-web.sidebar.actions', actions);
    brandRow.appendChild(actions);
    root.appendChild(brandRow);

    // ── new-session affordance ───────────────────────────────────────────────
    root.appendChild(h('div', { style: 'padding:2px 10px 8px' },
      h('button', {
        text: '+ New session',
        style:
          'width:100%;padding:7px 10px;border-radius:6px;font:inherit;font-size:12px;text-align:left;' +
          'cursor:pointer;border:1px solid ' + sv('border') + ';background:' + sv('fill-secondary') +
          ';color:' + sv('text-secondary'),
        onclick: () => { const ta = document.querySelector('[data-slot="conversation.composer"] textarea'); if (ta) ta.focus(); },
      }),
    ));

    // ── the list ────────────────────────────────────────────────────────────
    const list = h('div', {
      'data-slot': 'sidebar.items',
      style: 'flex:1;overflow-y:auto;padding:0 8px;display:flex;flex-direction:column;gap:1px',
    });
    root.appendChild(list);
    // The shell's own entries, so the column is not empty before plugins add
    // anything. A later plugin can hide or reorder these with `ui.adjusts`.
    const ENTRIES = [
      { id: 'session', label: 'Sessions', icon: 'M4 4h16v12H8l-4 4z' },
      { id: 'plugins', label: 'Plugins', icon: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z' },
      { id: 'tools', label: 'Tools', icon: 'M12 3v5l4 2M6 9l6-3 6 3v6l-6 3-6-3z' },
      { id: 'settings', label: 'Settings', icon: 'M12 9a3 3 0 100 6 3 3 0 000-6zM4 12h2m12 0h2M12 4v2m0 12v2' },
    ];
    for (const e of ENTRIES) {
      list.appendChild(h('button', {
        'data-shell-entry': e.id,
        style:
          'display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;border-radius:6px;' +
          'cursor:pointer;font:inherit;font-size:13px;text-align:left;color:' + sv('text-secondary') +
          ';background:transparent',
        onmouseenter: (ev) => { ev.currentTarget.style.background = sv('fill-secondary'); },
        onmouseleave: (ev) => { ev.currentTarget.style.background = 'transparent'; },
      },
        h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
                   stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' },
          h('path', { d: e.icon })),
        h('span', { text: e.label }),
      ));
    }
    // Plugin-contributed entries land in the same list, after the built-ins.
    const listSlot = h('div', { style: 'display:flex;flex-direction:column;gap:1px;margin-top:4px' });
    list.appendChild(listSlot);
    S.mount('dsh-web.sidebar.items', listSlot);

    // ── footer ──────────────────────────────────────────────────────────────
    const footer = h('div', {
      'data-slot': 'sidebar.footer',
      style:
        'padding:8px 12px 10px;border-top:1px solid ' + sv('border-tertiary') +
        ';font-size:11px;line-height:1.7;color:' + sv('text-tertiary'),
    });
    const state = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:8px',
    });
    footer.appendChild(state);
    const footerSlot = h('div', { style: 'margin-top:6px' });
    footer.appendChild(footerSlot);
    S.mount('dsh-web.sidebar.footer', footerSlot);
    root.appendChild(footer);

    const tick = async () => {
      const s = await api.status();
      state.replaceChildren(
        h('span', {},
          h('span', { style: 'color:' + sv(s && s.booted ? 'primary' : 'warning'), text: '● ' }),
          s ? (s.booted ? 'online' : 'booting') : 'offline'),
        h('span', { text: s ? (s.tool_count || 0) + ' tools' : '' }),
      );
    };
    tick();
    const iv = setInterval(tick, 8000);

    el.appendChild(root);
    return () => clearInterval(iv);
  };
  return { render };
})();
