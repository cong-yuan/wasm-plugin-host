// The three-column frame, plus a frame-level overlay.
//
// This file IS the structure the slot names refer to, so it stays readable: a
// reader can see every region and where a plugin's contribution would land.
//
// The right column collapses by setting its grid track to 0 rather than
// unmounting it — a slot inside a hidden column keeps its contributions and
// reappears with them.
return (function () {
  const { h } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const sidebar = studio.require('panels/sidebar');
  const conversation = studio.require('panels/conversation');
  const details = studio.require('panels/details');

  const render = (el) => {
    const root = h('div', {
      class: 'dw-frame-frame',
      'data-slot': 'root',
      'data-details-collapsed': '',
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
        root.style.gridTemplateColumns = 'var(--dw-sidebar-width) minmax(0,1fr) var(--dw-details-width)';
      } else {
        root.setAttribute('data-details-collapsed', '');
        root.style.gridTemplateColumns = 'var(--dw-sidebar-width) minmax(0,1fr) 0px';
      }
    };

    const dSide = sidebar.render(sideCol);
    const dConv = conversation.render(centerCol, { openDetails: () => setRight(true) });
    const dRight = details.render(rightCol, { close: () => setRight(false) });

    // A frame-level slot above every column. `pointer-events:none` while empty
    // so it never eats a click; a plugin adding content re-enables it locally.
    const overlay = h('div', {
      class: 'dw-frame-overlayLayer',
      'data-slot': 'shell.overlay',
    });
    root.appendChild(overlay);
    S.mount('dsh-web.shell.overlay', overlay);

    el.appendChild(h('div', { class: 'dw-app' }, root));
    return () => {
      if (typeof dSide === 'function') dSide();
      if (typeof dConv === 'function') dConv();
      if (typeof dRight === 'function') dRight();
    };
  };
  return { render };
})();
