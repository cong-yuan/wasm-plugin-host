// The left column, with a slot at each of its regions.
//
// The shell's own content is deliberately thin, but not *empty*: the session
// list renders real agents, because a shell that shows nothing real is a
// mock-up, and a mock-up hides whether the plumbing works. Anything more
// opinionated (a workspace tree, an archive) belongs in a plugin filling one of
// the slots around it.
//
// Upstream's `ChatSidebar.tsx` is the source of the shape: header (title +
// actions), four `sidebar-activity-bar`s, the session list, a notice slot, and
// the footer.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  // The four activity bars, in upstream's order. Each is a row with an icon and
  // a label; they are affordances, not features — the shell does not own
  // automations or skills, so clicking one is a no-op until a plugin fills the
  // region. Marked `data-activity` so a plugin can bind to them.
  const ACTIVITIES = [
    { id: 'bridge', label: 'Bridge', icon: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' },
    { id: 'activity', label: 'Activity', icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
    { id: 'automation', label: 'Automation', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2' },
    { id: 'skills', label: 'Skills', icon: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' },
  ];

  /** Format a token count compactly: 1234 → "1.2k". */
  const shortCount = (n) => {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  };

  const render = (el, opts) => {
    const root = h('aside', {
      class: 'hn-side',
      'data-slot': 'sidebar',
    });

    // Drag handle for the column width. It carries `data-resize` rather than a
    // click handler: the frame owns the drag logic (see lib/resize.js).
    root.appendChild(h('div', {
      class: 'hn-resize-handle hn-resize-right',
      'data-resize': 'sidebar',
      title: 'Drag to resize · double-click to reset',
    }));

    // ── header row: title + actions ─────────────────────────────────────────
    const header = h('div', { class: 'hn-side-header', 'data-slot': 'sidebar.header' });
    header.appendChild(h('span', { class: 'hn-side-title', text: 'Hana' }));

    const headerActions = h('div', { class: 'hn-side-headerActions' });
    headerActions.appendChild(h('button', {
      class: 'hn-icon-btn', type: 'button', title: 'New chat', 'aria-label': 'New chat',
      onclick: () => opts && opts.onNewSession && opts.onNewSession(),
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
    // The shell's own list, plus a slot beneath it so a plugin can add rows.
    const list = h('div', {
      class: 'hn-side-sessions hn-scroll-quiet',
      'data-slot': 'sidebar.sessions',
    });
    const own = h('div', { class: 'hn-sess-list', 'data-own-sessions': '' });
    list.appendChild(own);
    // Slot contributions render after the shell's own rows, in their own box, so
    // refreshing one does not wipe the other.
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

    // ── the session list itself ─────────────────────────────────────────────
    // Live, from `list_agents`. The rows are the shell's; a plugin's rows live
    // in the slot's own box and are untouched by a redraw here.
    let currentId = null;

    const row = (agent) => {
      const active = agent.id === currentId;
      // A stored session is readable but has no driver behind it. It is marked
      // rather than hidden: a session list that omits what is on disk would make
      // persistence look broken. The mark is a hollow dot (vs the live dot), and
      // selecting one resumes it — see the frame's `onSelectSession`.
      const stored = agent.live === false;
      const r = h('button', {
        class: 'hn-sess' + (active ? ' active' : '') + (stored ? ' stored' : ''),
        type: 'button',
        'data-agent': agent.id,
        'data-live': stored ? 'false' : 'true',
        title: (agent.title || agent.id) + (stored ? ' · on disk (open to continue)' : ''),
        onclick: () => opts && opts.onSelectSession && opts.onSelectSession(agent),
      });
      const dot = h('span', {
        class: 'hn-sess-dot'
          + (agent.busy ? ' busy' : agent.status === 'running' ? ' busy' : '')
          + (stored ? ' stored' : ''),
      });
      const label = h('span', {
        class: 'hn-sess-label',
        text: agent.title || (stored ? 'Untitled session' : 'New session'),
      });
      r.appendChild(dot);
      r.appendChild(label);
      // Usage is only shown when the provider actually reported it. `calls === 0`
      // means "nothing reported", which must not render as "0 tokens" — that
      // reads as a measurement, and it would be a false one.
      if (agent.usage && agent.usage.calls > 0) {
        const total = (agent.usage.input || 0) + (agent.usage.output || 0);
        r.appendChild(h('span', {
          class: 'hn-sess-tokens',
          text: shortCount(total),
          title: `${agent.usage.input} in · ${agent.usage.output} out · ${agent.usage.calls} call(s)`,
        }));
      }
      return r;
    };

    const refresh = async () => {
      const agents = await api.sessions();
      const rows = agents.map(row);
      if (!rows.length) {
        const empty = await api.available()
          ? 'No sessions yet'
          : 'Backend offline';
        own.replaceChildren(h('div', { class: 'hn-sess-empty', text: empty }));
      } else {
        own.replaceChildren(...rows);
      }
    };

    const tick = async () => {
      const s = await api.status();
      const providers = s && s.providers ? s.providers : [];
      const real = providers.filter((p) => p !== 'mock');
      status.replaceChildren(
        h('span', {},
          h('span', { style: 'color:' + (s && s.booted ? 'var(--dw-green)' : 'var(--dw-coral)'), text: '● ' }),
          s ? (s.booted ? 'online' : 'booting') : 'offline'),
        h('span', {
          text: real.length ? real.join(', ') : (providers.length ? 'mock only' : 'no provider'),
          title: 'LLM providers: ' + (providers.join(', ') || 'none'),
        }),
      );
    };

    const refreshAll = () => { refresh(); tick(); };

    // Expose the refresh so the frame can call it after a new session is made.
    if (opts && opts.registerRefresh) opts.registerRefresh(refreshAll);
    // And the selection, so the list highlights what the conversation shows.
    if (opts && opts.registerSelection) {
      opts.registerSelection((id) => { currentId = id; refresh(); });
    }

    refreshAll();
    const iv = setInterval(refreshAll, 5000);

    el.appendChild(root);
    return () => clearInterval(iv);
  };

  return { render };
})();
