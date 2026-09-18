// The left column, with a slot at each of its five regions.
//
// The shell's own content is deliberately thin: a header row, the four activity
// bars upstream ships, the session list region, a notice slot and a footer.
// Anything more opinionated belongs in a plugin that fills one of those slots,
// so the shell stays a frame rather than a feature.
//
// Upstream's `ChatSidebar.tsx` is the source: header (title + actions), four
// `sidebar-activity-bar`s, the session list, the notice slot, and the footer.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  // The four activity bars, in upstream's order. Each is a row with an icon, a
  // label and an optional count — the shape, not the behaviour: the shell does
  // not own automations or skills, so these are affordances a plugin fills in.
  const ACTIVITIES = [
    { id: 'bridge', label: 'Bridge', icon: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' },
    { id: 'activity', label: 'Activity', icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
    { id: 'automation', label: 'Automation', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2' },
    { id: 'skills', label: 'Skills', icon: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' },
  ];

  const render = (el, opts) => {
    const root = h('aside', {
      class: 'hn-side',
      'data-slot': 'sidebar',
    });

    // ── header row: title + actions ─────────────────────────────────────────
    const header = h('div', { class: 'hn-side-header', 'data-slot': 'sidebar.header' });
    header.appendChild(h('span', { class: 'hn-side-title', text: 'Hana' }));

    const headerActions = h('div', { class: 'hn-side-headerActions' });
    headerActions.appendChild(h('button', {
      class: 'hn-icon-btn', type: 'button', title: 'New chat', 'aria-label': 'New chat',
      onclick: () => {
        const ta = document.querySelector('.hn-comp-input');
        if (ta) ta.focus();
      },
    }, svgIcon('M12 5v14M5 12h19', 15)));
    headerActions.appendChild(h('button', {
      class: 'hn-icon-btn', type: 'button', title: 'Settings', 'aria-label': 'Settings',
      onclick: () => opts && opts.onOpenSettings && opts.onOpenSettings(),
    }, svgIcon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z', 14)));
    headerActions.appendChild(h('button', {
      class: 'hn-icon-btn', type: 'button', title: 'Collapse', 'aria-label': 'Collapse',
      onclick: () => opts && opts.onCollapse && opts.onCollapse(),
    }, svgIcon('M15 6l-6 6 6 6', 14)));
    // Slot: extra header buttons, so a plugin adds one without this file changing.
    const headerSlot = h('div', { class: 'hn-slot-inline' });
    S.mount('hana.sidebar.header', headerSlot);
    headerActions.appendChild(headerSlot);
    header.appendChild(headerActions);
    root.appendChild(header);

    // ── activity bars ───────────────────────────────────────────────────────
    const activities = h('div', { class: 'hn-side-activities', 'data-slot': 'sidebar.activities' });
    for (const a of ACTIVITIES) {
      activities.appendChild(h('button', {
        class: 'hn-side-activity',
        type: 'button',
        'data-activity': a.id,
        onclick: () => opts && opts.onActivity && opts.onActivity(a.id),
      },
        svgIcon(a.icon, 14),
        h('span', { class: 'hn-side-activityLabel', text: a.label }),
      ));
    }
    // Slot: contributions land under the built-in bars.
    S.mount('hana.sidebar.activities', activities);
    root.appendChild(activities);

    // ── session list ────────────────────────────────────────────────────────
    // Its own scroll box so a plugin contributing many rows does not push the
    // footer off the bottom.
    const list = h('div', {
      class: 'hn-side-sessions hn-scroll-quiet',
      'data-slot': 'sidebar.sessions',
    });
    S.mount('hana.sidebar.sessions', list);
    root.appendChild(list);

    // ── notice slot (above the footer) ──────────────────────────────────────
    const notice = h('div', { class: 'hn-side-notice', 'data-slot': 'sidebar.notice' });
    S.mount('hana.sidebar.notice', notice);
    root.appendChild(notice);

    // ── footer: status + slot ───────────────────────────────────────────────
    const foot = h('div', { class: 'hn-side-footer', 'data-slot': 'sidebar.footer' });
    const status = h('div', { class: 'hn-side-footerStatus' });
    foot.appendChild(status);
    const footerSlot = h('div', { class: 'hn-slot' });
    S.mount('hana.sidebar.footer', footerSlot);
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
