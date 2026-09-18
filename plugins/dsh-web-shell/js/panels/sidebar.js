// The left column, with a slot at each of its four regions.
//
// The shell's own content is deliberately minimal — a brand row, a new-session
// affordance, and a live status line. Anything more opinionated (a session
// list, a workspace tree) belongs in a plugin that fills `dsh-web.sidebar.items`,
// so the shell stays a frame rather than a feature.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  const render = (el) => {
    const root = h('aside', {
      class: 'dw-side-root',
      'data-slot': 'sidebar',
    });

    // ── brand row ───────────────────────────────────────────────────────────
    const logoRow = h('div', { class: 'dw-side-logoRow' });
    const identity = h('span', { class: 'dw-side-brandIdentity' },
      h('span', {
        class: 'dw-side-brandMark',
        'data-slot': 'sidebar.brand.mark',
      }),
      h('span', {
        class: 'dw-side-brandName',
        'data-slot': 'sidebar.brand.name',
        text: 'Hana',
      }),
    );
    // Slot: beside the brand mark, for a plugin that wants to add a badge
    // (a build tag, an environment chip) without changing this file.
    const brandSlot = h('span', { class: 'dw-slot', style: 'display:inline-flex;align-items:center' });
    S.mount('dsh-web.sidebar.brand', brandSlot);
    identity.appendChild(brandSlot);

    const brand = h('button', { class: 'dw-side-brand', type: 'button' }, identity);
    // Slot: the header's right side, for icon buttons.
    const actions = h('div', { class: 'dw-slot', style: 'margin-left:auto;display:inline-flex;align-items:center;gap:2px' });
    S.mount('dsh-web.sidebar.actions', actions);
    logoRow.appendChild(brand);
    logoRow.appendChild(actions);
    root.appendChild(logoRow);

    // ── new session ─────────────────────────────────────────────────────────
    root.appendChild(h('button', {
      class: 'dw-side-newSession',
      type: 'button',
      onclick: () => {
        const ta = document.querySelector('.dw-comp-input');
        if (ta) ta.focus();
      },
    },
      svgIcon('M12 5v14M5 12h14', 14),
      h('span', { class: 'dw-side-newSessionLabel', text: 'New session' }),
    ));

    // ── the list ────────────────────────────────────────────────────────────
    // Wrapped in its own scroll box so a plugin contributing many rows does not
    // push the footer off the bottom.
    const list = h('div', {
      class: 'dw-side-regionArea dw-scroll-quiet',
      'data-slot': 'sidebar.items',
    });
    S.mount('dsh-web.sidebar.items', list);
    root.appendChild(list);

    // ── footer ──────────────────────────────────────────────────────────────
    const foot = h('div', { class: 'dw-side-footArea', 'data-slot': 'sidebar.footer' });
    const status = h('div', { class: 'dw-side-footerActions' });
    foot.appendChild(status);
    const footerSlot = h('div', { class: 'dw-slot', style: 'margin-top:6px' });
    S.mount('dsh-web.sidebar.footer', footerSlot);
    foot.appendChild(footerSlot);
    root.appendChild(foot);

    // Live state, read from the backend. A shell that shows nothing real is a
    // mock-up, and a mock-up hides whether the plumbing works.
    const tick = async () => {
      const s = await api.status();
      status.replaceChildren(
        h('span', {},
          h('span', { style: 'color:' + (s && s.booted ? 'var(--dw-green)' : 'var(--dw-coral)'), text: '● ' }),
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
