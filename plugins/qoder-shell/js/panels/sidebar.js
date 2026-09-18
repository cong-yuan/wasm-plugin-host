// The left rail: Qoder's brand block, main navigation, and a live status block.
//
// The numbers come from the backend, so the sidebar reports real state rather
// than decoration. It is also where later plugins can append their own entries —
// the slot `qoder-shell.sidebar` is opened for them.
return (function () {
  const { h, sv, muted } = studio.require('lib/dom');
  const nav = studio.require('lib/nav');
  const api = studio.require('lib/api');

  const render = (el, ctx) => {
    const active = ctx && ctx.activeKey;
    const root = h('aside', {
      style:
        'width:220px;flex:0 0 220px;display:flex;flex-direction:column;min-height:0;' +
        'background:' + sv('bg-layout') + ';border-right:1px solid ' + sv('border-secondary'),
    });

    // Brand — Qoder's wordmark plus a live dot.
    root.appendChild(h('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:14px 16px 10px;font-size:13px;font-weight:600',
    },
      h('span', { style: 'width:7px;height:7px;border-radius:50%;background:' + sv('primary') }),
      h('span', { text: 'Qoder', style: 'letter-spacing:-.01em' }),
      h('span', { text: 'WASM', style: 'font-size:10px;color:' + sv('text-quaternary') + ';margin-left:auto;letter-spacing:.06em' }),
    ));

    // New-chat affordance, as in Qoder's sidebar.
    root.appendChild(h('div', { style: 'padding:2px 8px 8px' },
      h('button', {
        text: '+ New chat',
        style:
          'width:100%;padding:7px 10px;border-radius:6px;cursor:pointer;font:inherit;font-size:12px;' +
          'text-align:left;border:1px solid ' + sv('border') + ';background:' + sv('fill-secondary') +
          ';color:' + sv('text-secondary'),
        onclick: () => { location.hash = '#new'; },
      }),
    ));

    nav.render(root, active, (e) => { location.href = e.href; });

    root.appendChild(h('div', { style: 'flex:1' }));

    // Status block — real counts, refreshed on a slow tick.
    const status = h('div', {
      style: 'padding:10px 16px 12px;font-size:11px;line-height:1.8;color:' + sv('text-tertiary') +
             ';border-top:1px solid ' + sv('border-tertiary'),
    });
    root.appendChild(status);
    const tick = async () => {
      // `studio_status` carries harness counters but has no plugin count, so the
      // plugin list is fetched separately rather than inventing a field.
      const [s, ps] = await Promise.all([api.status(), api.plugins()]);
      if (!s) { status.textContent = 'harness offline'; return; }
      status.replaceChildren(
        h('div', {}, h('span', { style: 'color:' + sv('primary'), text: '● ' }),
          (s.booted ? 'harness online' : 'booting…')),
        h('div', { text: ps.length + ' plugin(s)' }),
        h('div', { text: (s.tool_count || 0) + ' tool(s)' }),
      );
    };
    tick();
    const iv = setInterval(tick, 8000);

    // A slot of its own, so a *later* plugin can add sidebar entries without
    // this one knowing anything about it.
    const extra = h('div', { style: 'padding:0 8px 8px' });
    root.appendChild(extra);
    let disposeSlot = null;
    try { disposeSlot = studio.renderSlot('qoder-shell.sidebar', extra); } catch (e) { /* not opened yet */ }

    el.appendChild(root);
    return () => { clearInterval(iv); if (disposeSlot) disposeSlot(); };
  };

  return { render };
})();
