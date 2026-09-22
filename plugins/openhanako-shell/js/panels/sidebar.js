// DOM ported verbatim from openhanako (Apache-2.0):
// desktop/src/react/components/app/ChatSidebar.tsx + components/SessionList.tsx
return (function () {
  const { h, svg, clear } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const api = studio.require('lib/api');
  const { t } = studio.require('lib/i18n');

  // Upstream icon markup, copied unchanged.
  const ICON = {
    newChat: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
    settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    collapse: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"></polyline></svg>',
    bridge: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
    activity: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>',
    automation: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
    skills: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  };

  function render(options) {
    const add = h('button', { class: 'sidebar-action-btn', title: t('sidebar.newChat') }, svg(ICON.newChat));
    const settings = h('button', { class: 'sidebar-action-btn', title: t('settings.title') }, svg(ICON.settings));
    const collapse = h('button', { class: 'sidebar-action-btn', title: t('sidebar.collapse') }, svg(ICON.collapse));
    add.onclick = options.onNew;
    collapse.onclick = options.onCollapse;

    const actions = h('div', { class: 'sidebar-header-actions' }, add, settings, collapse);
    slots.mount('hana.sidebar.header', actions);

    const header = h('div', { class: 'sidebar-header' },
      h('span', { class: 'sidebar-title' }, t('sidebar.title')), actions);

    // Upstream renders the activity bars as flat siblings (no wrapper div).
    const bridge = h('button', { class: 'sidebar-activity-bar sidebar-bridge-card', type: 'button' },
      svg(ICON.bridge), h('span', {}, t('sidebar.bridgeShort')),
      h('span', { class: 'sidebar-bridge-dot connected' }));
    const activity = h('button', { class: 'sidebar-activity-bar', type: 'button' },
      svg(ICON.activity), h('span', {}, t('sidebar.activity')));
    const automation = h('button', { class: 'sidebar-activity-bar', type: 'button' },
      svg(ICON.automation), h('span', {}, t('automation.title')),
      h('span', { class: 'automation-count-badge' }, ''));
    const skills = h('button', { class: 'sidebar-activity-bar', type: 'button' },
      svg(ICON.skills), h('span', {}, t('skills.panel.title')));

    const activities = h('div', { class: 'hana-slot sidebar-activities-slot' });
    slots.mount('hana.sidebar.activities', activities);

    // Upstream: <div className="session-list"><SessionList /><SidebarNoticeSlot /></div>
    const scroller = h('div', { class: 'sessionListScroller' });
    const notice = h('div', { class: 'hana-slot sidebar-notice-slot' });
    slots.mount('hana.sidebar.notice', notice);
    const list = h('div', { class: 'session-list' }, scroller, notice);
    slots.mount('hana.sidebar.sessions', list);

    const content = h('div', { class: 'sidebar-chat-content' },
      header, bridge, activity, automation, skills, activities, list);

    const root = h('aside', { class: 'sidebar', id: 'sidebar' },
      h('div', { class: 'sidebar-inner' }, content),
      h('div', { class: 'resize-handle resize-handle-right', id: 'sidebarResizeHandle' }));

    async function draw(selected) {
      const rows = await api.sessions();
      clear(scroller);
      if (!rows.length) {
        scroller.appendChild(h('div', { class: 'sessionEmpty' }, t('sidebar.empty')));
        return;
      }
      rows.forEach((s) => {
        const row = h('div', {
          class: 'sessionItem sessionItemSingleLine' + (selected === s.id ? ' sessionItemActive' : ''),
          role: 'button', tabindex: '0',
        }, h('div', { class: 'sessionItemHeader' },
          s.busy ? h('span', { class: 'sessionStreamingDot', 'data-state': 'running' }) : null,
          h('span', { class: 'sessionItemTitle' }, s.title || t('session.untitled'))));
        row.onclick = () => options.onSelect(s);
        scroller.appendChild(row);
      });
    }
    draw(options.selected);
    return { root, refresh: draw };
  }
  return { render };
})();
