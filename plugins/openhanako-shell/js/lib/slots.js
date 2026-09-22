return (function () {
  const { h } = studio.require('lib/dom');
  const names = [
    'hana.titlebar.left', 'hana.titlebar.center', 'hana.titlebar.right',
    'hana.sidebar.header', 'hana.sidebar.activities', 'hana.sidebar.sessions',
    'hana.sidebar.notice', 'hana.sidebar.footer',
    'hana.conversation.header', 'hana.conversation.hero', 'hana.conversation.stream',
    'hana.conversation.input.dock', 'hana.conversation.input.right',
    'hana.preview.panel', 'hana.rail.header', 'hana.rail.items', 'hana.shell.overlay',
  ];
  const mount = (name, target) => {
    const host = h('div', { class: 'hana-slot', 'data-host-slot': name });
    target.appendChild(host);
    try { return studio.renderSlot(name, host); } catch (_) { return null; }
  };
  return { names, mount };
})();
