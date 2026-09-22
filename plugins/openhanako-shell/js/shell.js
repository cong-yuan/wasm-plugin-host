// Shell root. Mirrors upstream App.tsx composition (Apache-2.0):
//   <div class="app-shell"> <AppTitlebar/> <div class="app"> <ChatSidebar/> <AppPages/> </div> </div>
// AppPages renders MainContent(ChatPage) + PreviewPanel + WorkspaceCompanionRail.
return (function () {
  const { h } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const api = studio.require('lib/api');
  const theme = studio.require('lib/theme');
  const resize = studio.require('lib/resize');
  const { t } = studio.require('lib/i18n');
  const titlebar = studio.require('panels/titlebar');
  const sidebar = studio.require('panels/sidebar');
  const conversation = studio.require('panels/conversation');
  const rail = studio.require('panels/rail');

  function render(el) {
    theme.install();

    const state = { selected: null, sidebar: true, preview: false, jian: true };

    // ── PreviewPanel (upstream: rendered by AppPages for the chat tab) ──
    const previewBody = h('div', { class: 'preview-panel-body' });
    slots.mount('hana.preview.panel', previewBody);
    const previewClose = h('button', { class: 'preview-close-btn', type: 'button' }, '×');
    const preview = h('aside', { class: 'preview-panel collapsed', id: 'previewPanel' },
      h('div', { class: 'resize-handle resize-handle-left' }),
      h('div', { class: 'preview-panel-inner' },
        h('div', { class: 'preview-panel-header' }, h('span', {}, 'Preview'), previewClose),
        previewBody));

    const right = rail.render();

    let side;
    const chat = conversation.render({
      onOpened: (id) => { state.selected = id; side.refresh(id); },
      onCreated: (id) => { state.selected = id; side.refresh(id); },
      onChanged: () => refresh(),
    });

    side = sidebar.render({
      selected: state.selected,
      onNew: () => { state.selected = null; chat.reset(); side.refresh(null); },
      onCollapse: toggleSidebar,
      onSelect: (session) => chat.open(session),
    });

    const bar = titlebar.render({
      sidebarOpen: state.sidebar,
      jianOpen: state.jian,
      previewOpen: state.preview,
      onToggleSidebar: toggleSidebar,
      onToggleJian: toggleJian,
      onTogglePreview: togglePreview,
    });

    function toggleSidebar() {
      state.sidebar = !state.sidebar;
      side.root.classList.toggle('collapsed', !state.sidebar);
      bar.setSidebar(state.sidebar);
    }
    function togglePreview() {
      state.preview = !state.preview;
      preview.classList.toggle('collapsed', !state.preview);
      bar.setPreview(state.preview);
    }
    function toggleJian() {
      state.jian = !state.jian;
      right.root.classList.toggle('collapsed', !state.jian);
      bar.setJian(state.jian);
    }
    previewClose.onclick = togglePreview;

    // Upstream `.app` row: sidebar + pages. MainContent wraps the chat page.
    const main = h('div', { class: 'main-content' }, chat.root);
    const app = h('div', { class: 'app' }, side.root, main, preview, right.root);

    const overlay = h('div', { class: 'shell-overlay' });
    slots.mount('hana.shell.overlay', overlay);

    const root = h('div', {
      class: 'hana-replica app-shell paper-texture',
      'data-theme': 'new-warm-paper',
    }, bar.root, app, overlay);
    el.appendChild(root);
    const unResize = resize.wireAll(root);

    async function refresh() {
      const [plugins, tools, status] = await Promise.all([api.plugins(), api.tools(), api.status()]);
      right.update({ plugins, tools, status });
      await side.refresh(state.selected);
    }
    refresh();

    return () => { if (unResize) unResize(); root.remove(); };
  }
  return { render };
})();
