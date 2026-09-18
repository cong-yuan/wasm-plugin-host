// Three-column AppFrame — official class names from remapped CSS modules.
return (function () {
  const { h } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const sidebar = studio.require('panels/sidebar');
  const conversation = studio.require('panels/conversation');
  const details = studio.require('panels/details');

  const render = (el) => {
    // Right column closed by default — official often starts without it.
    const root = h('div', {
      class: 'dw-frame-frame',
      'data-slot': 'root',
      'data-dsh-surface': 'root',
      'data-details-collapsed': '',
      style: 'grid-template-columns: 280px minmax(0,1fr) 0px',
    });

    const sideCol = h('div', { class: 'dw-frame-sidebarCol', 'data-pane': 'sidebar' });
    const centerCol = h('div', { class: 'dw-frame-centerCol', 'data-pane': 'conversation' });
    const rightCol = h('div', { class: 'dw-frame-rightbarCol', 'data-pane': 'details' });
    root.appendChild(sideCol);
    root.appendChild(centerCol);
    root.appendChild(rightCol);

    const setRight = (open) => {
      if (open) {
        root.removeAttribute('data-details-collapsed');
        root.style.gridTemplateColumns = '280px minmax(0,1fr) 360px';
      } else {
        root.setAttribute('data-details-collapsed', '');
        root.style.gridTemplateColumns = '280px minmax(0,1fr) 0px';
      }
    };

    const dSide = sidebar.render(sideCol);
    const dConv = conversation.render(centerCol, { openDetails: () => setRight(true) });
    const dRight = details.render(rightCol, { close: () => setRight(false) });

    const overlay = h('div', {
      class: 'dw-frame-overlayLayer',
      'data-slot': 'shell.overlay',
      'data-dsh-surface': 'overlay',
      'data-shell-overlay': '',
    });
    root.appendChild(overlay);
    S.mount('dsh-web.shell.overlay', overlay);

    const wrap = h('div', { class: 'dw-app' }, root);
    el.appendChild(wrap);
    return () => {
      if (typeof dSide === 'function') dSide();
      if (typeof dConv === 'function') dConv();
      if (typeof dRight === 'function') dRight();
    };
  };
  return { render };
})();
