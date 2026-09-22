// The preview panel — the 580px document column.
//
// Upstream shows it only in the chat tab and lets it collapse to zero width.
// The shell contributes only a header and closes control; the body is a slot,
// because what goes there (a document, a diff, a rendered file) is decided by
// whoever fills it.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');

  const render = (el, opts) => {
    const root = h('aside', { class: 'hn-preview', 'data-slot': 'preview' });

    // Drag handle on the inner edge — the panel is on the right, so its width
    // is dragged from the side that faces the conversation.
    root.appendChild(h('div', {
      class: 'hn-resize-handle hn-resize-left',
      'data-resize': 'preview',
      title: 'Drag to resize · double-click to reset',
    }));

    const header = h('div', { class: 'hn-preview-header', 'data-slot': 'preview.header' });
    header.appendChild(h('span', { class: 'hn-preview-title', text: 'Preview' }));
    const actions = h('div', { class: 'hn-preview-actions' });
    actions.appendChild(h('button', {
      class: 'hn-icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close preview',
      onclick: () => opts && opts.onClose && opts.onClose(),
    }, svgIcon('M18 6L6 18M6 6l12 12', 15)));
    header.appendChild(actions);
    root.appendChild(header);

    // Everything below the header is the plugin's surface.
    const body = h('div', { class: 'hn-preview-body hn-scroll-quiet', 'data-slot': 'preview.panel' });
    S.mount('hana.preview.panel', body);
    root.appendChild(body);

    el.appendChild(root);
    return undefined;
  };

  return { render };
})();
