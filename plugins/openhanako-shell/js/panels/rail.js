// Ported verbatim from openhanako RightWorkspacePanel.tsx (Apache-2.0).
// Upstream: desktop/src/react/components/right-workspace/RightWorkspacePanel.tsx
// Upstream hashes CSS-module class names; build-css.mjs appends the module
// rules unhashed, so the raw names below match the generated stylesheet.
return (function () {
  const { h, svg, clear } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const { t } = studio.require('lib/i18n');

  // function Chevron({ open }) — upstream markup, both branches.
  const CHEVRON_OPEN = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>`;
  const CHEVRON_CLOSED = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>`;

  // BASE_TABS
  const BASE_TABS = [
    { id: 'session-files', labelKey: 'rightWorkspace.tabs.sessionFiles' },
    { id: 'workspace', labelKey: 'rightWorkspace.tabs.workspace' },
  ];

  function render() {
    const state = { tab: 'workspace', jianOpen: false };

    // <div className={styles.workspaceHeader}> + workspaceTitle
    const title = h('div', { class: 'workspaceTitle' }, t('desk.title'));
    const header = h('div', { class: 'workspaceHeader' }, title);
    const headerSlot = h('div', { class: 'rail-header-slot' });
    slots.mount('hana.rail.header', headerSlot);

    // <div className={styles.tabs} role="tablist"> with slider + 2 tabs
    const slider = h('div', {
      class: 'tabSlider', 'data-right-workspace-tab-slider': '', 'aria-hidden': 'true',
    });
    const tabs = h('div', {
      class: 'tabs', role: 'tablist', 'aria-label': t('rightWorkspace.tabs.label'),
      style: '--right-workspace-active-tab-index:1;--right-workspace-tab-slider-offset:calc(100% + 2px)',
    }, slider);
    const tabButtons = BASE_TABS.map((tab) => {
      const selected = state.tab === tab.id;
      const btn = h('button', {
        type: 'button',
        class: 'tab' + (selected ? ' tabActive' : ''),
        role: 'tab',
        'aria-selected': String(selected),
      }, t(tab.labelKey));
      btn.onclick = () => selectTab(tab.id);
      tabs.appendChild(btn);
      return { id: tab.id, btn };
    });

    // <div className={styles.content} role="tabpanel"> → TabContent
    const fileList = h('div', { class: 'fileList' });
    const itemsSlot = h('div', { class: 'rail-items-slot' });
    const content = h('div', { class: 'content', role: 'tabpanel' }, fileList, itemsSlot);
    slots.mount('hana.rail.items', itemsSlot);

    // <section className={styles.jianDrawer} data-open=…>
    const editor = h('textarea', {
      class: 'jian-editor',
      'data-desk-editor': '',
      placeholder: t('desk.jianPlaceholder'),
    });
    const drawer = h('section', {
      class: 'jianDrawer', 'data-open': 'false', role: 'region', 'aria-label': t('desk.jianLabel'),
    },
      h('div', { class: 'jianHeader' }, h('span', { class: 'jianTitle' }, t('desk.jianLabel'))),
      h('div', { class: 'jianBody' }, editor));

    // function JianFloatingToggle()
    const jianToggle = h('button', {
      class: 'jianToggle', type: 'button',
      'aria-label': t('rightWorkspace.jian.expand'), 'aria-expanded': 'false',
    }, svg(CHEVRON_CLOSED));
    jianToggle.onclick = () => {
      state.jianOpen = !state.jianOpen;
      drawer.setAttribute('data-open', state.jianOpen ? 'true' : 'false');
      card.setAttribute('data-jian-open', state.jianOpen ? 'true' : 'false');
      jianToggle.setAttribute('aria-expanded', String(state.jianOpen));
      jianToggle.setAttribute('aria-label',
        t(state.jianOpen ? 'rightWorkspace.jian.collapse' : 'rightWorkspace.jian.expand'));
      clear(jianToggle);
      jianToggle.appendChild(svg(state.jianOpen ? CHEVRON_OPEN : CHEVRON_CLOSED));
    };

    // <div className={`universal-card ${styles.workspaceCard}`} …>
    const card = h('div', {
      class: 'universal-card workspaceCard',
      'data-right-workspace-card': '',
      'data-jian-open': 'false',
    }, header, headerSlot, tabs, content, drawer, jianToggle);

    // <div className={styles.shell}>
    const shell = h('div', { class: 'workspaceShell' }, card);

    // The host shell needs a collapsible aside around the upstream panel.
    const root = h('aside', { class: 'jian-sidebar', id: 'jianSidebar' },
      h('div', { class: 'resize-handle resize-handle-left', id: 'jianResizeHandle' }),
      h('div', { class: 'jian-sidebar-inner' }, shell));

    function selectTab(id) {
      state.tab = id;
      const index = Math.max(0, BASE_TABS.findIndex((tab) => tab.id === id));
      tabs.setAttribute('style',
        `--right-workspace-active-tab-index:${index};` +
        `--right-workspace-tab-slider-offset:${index === 0 ? '0px' : 'calc(100% + 2px)'}`);
      for (const { id: tabId, btn } of tabButtons) {
        const selected = tabId === id;
        btn.className = 'tab' + (selected ? ' tabActive' : '');
        btn.setAttribute('aria-selected', String(selected));
      }
    }

    function update(data) {
      const tools = (data && data.tools) || [];
      clear(fileList);
      if (!tools.length) {
        fileList.appendChild(h('div', { class: 'emptyState' },
          t('rightWorkspace.sessionFiles.empty')));
        return;
      }
      for (const tool of tools.slice(0, 12)) {
        fileList.appendChild(h('div', { class: 'fileRow' },
          h('div', { class: 'fileMain' },
            h('div', { class: 'fileName' }, tool.name || 'tool'))));
      }
    }

    return { root, update };
  }

  return { render };
})();
