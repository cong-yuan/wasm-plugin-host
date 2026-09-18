// The titlebar — HanaAgent's 44px row above everything.
//
// This is the row our previous shell was missing entirely. It is a flex row:
// a left cluster, an optional centre title, and a right cluster. Each cluster
// is a slot, so a plugin can add a button or a tab strip without this file
// knowing what it is.
//
// Upstream builds it from `AppTitlebar.tsx`; the shape (left group / centre
// title / channel tabs / right group / window controls) is what is copied. The
// window controls are left to the platform — a plugin window in Tauri has the
// OS frame, so drawing our own would duplicate it.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');

  const render = (el, opts) => {
    const titlebar = h('div', {
      class: 'hn-tb',
      'data-slot': 'titlebar',
      'data-tauri-drag-region': '',
    });

    // ── left cluster ──
    const left = h('div', { class: 'hn-tb-left' });
    left.appendChild(h('button', {
      class: 'hn-tb-toggle',
      type: 'button',
      title: 'Toggle sidebar',
      'aria-label': 'Toggle sidebar',
      onclick: () => opts && opts.onToggleSidebar && opts.onToggleSidebar(),
    }, svgIcon('M3 4h18v16H3zM9 4v16', 16)));
    const leftSlot = h('div', { class: 'hn-tb-slot' });
    S.mount('hana.titlebar.left', leftSlot);
    left.appendChild(leftSlot);

    // ── centre: the session title, plus the tab strip slot ──
    const centre = h('div', { class: 'hn-tb-center' });
    const title = h('div', {
      class: 'hn-tb-title',
      'data-slot': 'titlebar.center.title',
      text: opts && opts.title ? opts.title : 'New session',
    });
    centre.appendChild(title);
    const centreSlot = h('div', { class: 'hn-tb-slot hn-tb-slot-center' });
    S.mount('hana.titlebar.center', centreSlot);
    centre.appendChild(centreSlot);

    // ── right cluster ──
    const right = h('div', { class: 'hn-tb-right' });
    const rightSlot = h('div', { class: 'hn-tb-slot' });
    S.mount('hana.titlebar.right', rightSlot);
    right.appendChild(rightSlot);

    // The preview toggle, mirroring upstream's `tb-toggle-preview`.
    right.appendChild(h('button', {
      class: 'hn-tb-toggle',
      type: 'button',
      title: 'Toggle preview',
      'aria-label': 'Toggle preview',
      'data-toggle': 'preview',
      onclick: () => opts && opts.onTogglePreview && opts.onTogglePreview(),
    }, svgIcon('M7 3.5h7l3 3v14H7zM14 3.5v3h3M9.5 11h5M9.5 14.5h5', 16)));

    // The right-rail toggle, mirroring upstream's `tb-toggle-right`.
    right.appendChild(h('button', {
      class: 'hn-tb-toggle',
      type: 'button',
      title: 'Toggle details',
      'aria-label': 'Toggle details',
      'data-toggle': 'rail',
      onclick: () => opts && opts.onToggleRail && opts.onToggleRail(),
    }, svgIcon('M3 4h18v16H3zM15 4v16', 16)));

    titlebar.appendChild(left);
    titlebar.appendChild(centre);
    titlebar.appendChild(right);

    // The bar's bottom edge is a vertical drag handle. It sits *inside* the row
    // and centred horizontally, so it is clear the whole bar's height is what
    // moves.
    titlebar.appendChild(h('div', {
      class: 'hn-resize-handle hn-resize-bottom',
      'data-resize': 'titlebar',
      title: 'Drag to resize · double-click to reset',
    }));

    el.appendChild(titlebar);
    return undefined;
  };

  /** Update the centre title without rebuilding the row. */
  const setTitle = (el, text) => {
    const t = el.querySelector('.hn-tb-title');
    if (t) t.textContent = text;
  };

  return { render, setTitle };
})();
