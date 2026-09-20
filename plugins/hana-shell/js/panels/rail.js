// The right column — HanaAgent's "笺" (jian) sidebar, 260px.
//
// Upstream's `WorkspaceCompanionRail` shows activity, todos and registry files
// for the active session. We do not have todos or a file registry yet, so the
// shell renders what the backend *does* have — the mounted plugins, their
// windows, and the tool/service counts — and leaves a slot for the rest.
//
// Card order is deliberate: things that change (state) above things that do not
// (counts), so a glance at the top is enough.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  const render = (el, opts) => {
    const root = h('aside', { class: 'hn-rail', 'data-slot': 'rail' });

    // Drag handle on the inner edge, mirroring the sidebar.
    root.appendChild(h('div', {
      class: 'hn-resize-handle hn-resize-left',
      'data-resize': 'rail',
      title: 'Drag to resize · double-click to reset',
    }));

    const header = h('div', { class: 'hn-rail-header', 'data-slot': 'rail.header' });
    header.appendChild(h('span', { class: 'hn-rail-title', text: 'Workspace' }));
    const actions = h('div', { class: 'hn-rail-actions' });
    // Slot: header actions, so a plugin adds a control without this file changing.
    const headerSlot = h('div', { class: 'hn-slot-inline' });
    S.mount('hana.rail.header', headerSlot);
    actions.appendChild(headerSlot);
    actions.appendChild(h('button', {
      class: 'hn-icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close panel',
      onclick: () => opts && opts.onClose && opts.onClose(),
    }, svgIcon('M18 6L6 18M6 6l12 12', 15)));
    header.appendChild(actions);
    root.appendChild(header);

    // ── body: the shell's own cards, then the slot ──────────────────────────
    const body = h('div', { class: 'hn-rail-body hn-scroll-quiet', 'data-slot': 'rail.items' });
    const own = h('div', { class: 'hn-rail-own', 'data-own-rail': '' });
    body.appendChild(own);
    // Slot contributions render below the shell's cards, in their own box, so a
    // refresh here cannot wipe a plugin's panel.
    S.mount('hana.rail.items', body);
    root.appendChild(body);

    const card = (title, rows) => h('section', { class: 'hn-card' },
      h('div', { class: 'hn-card-title', text: title }),
      ...rows,
    );

    const kv = (k, v) => h('div', { class: 'hn-kv' },
      h('span', { class: 'hn-kv-k', text: k }),
      h('span', { class: 'hn-kv-v', text: v }),
    );

    const listItem = (name, sub) => h('div', { class: 'hn-rail-item' },
      h('span', { class: 'hn-rail-itemName', text: name, title: name }),
      sub ? h('span', { class: 'hn-rail-itemSub', text: sub }) : null,
    );

    const refresh = async () => {
      const [s, plugins, windows, tools] = await Promise.all([
        api.status(), api.plugins(), api.windows(), api.tools(),
      ]);

      const cards = [];

      // State first: is the harness up, and is it watching for rebuilds.
      if (s) {
        cards.push(card('Harness', [
          kv('state', s.booted ? 'online' : 'booting'),
          kv('providers', (s.providers && s.providers.length) ? s.providers.join(', ') : 'none'),
          kv('auto-reload', s.watching ? 'on' : 'off'),
          kv('tools', String(s.tool_count ?? '—')),
          kv('services', String(s.service_count ?? '—')),
        ]));
      }

      // Plugins: name + state, so a slot that failed to settle is visible here
      // rather than only in the studio's own page.
      if (plugins.length) {
        cards.push(card('Plugins (' + plugins.length + ')',
          plugins.slice(0, 12).map((p) => listItem(
            p.plugin || p.slot,
            [p.slot, p.state].filter(Boolean).join(' · '),
          )),
        ));
      }

      if (windows.length) {
        cards.push(card('Windows (' + windows.length + ')',
          windows.slice(0, 8).map((w) => listItem(w.title || w.label, w.slot)),
        ));
      }

      if (tools.length) {
        cards.push(card('Tools (' + tools.length + ')',
          tools.slice(0, 12).map((t) => listItem(t.name, t.plugin || t.slot || '')),
        ));
      }

      if (!cards.length) {
        cards.push(h('div', { class: 'hn-rail-empty', text: 'No backend data' }));
      }

      own.replaceChildren(...cards);
    };

    refresh();
    const iv = setInterval(refresh, 8000);

    el.appendChild(root);
    return () => clearInterval(iv);
  };

  return { render };
})();
