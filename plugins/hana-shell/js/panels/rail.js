// The right column — HanaAgent's "笺" (jian) sidebar, 260px.
//
// Where the previous shell's right column was a generic "details" panel, this
// one is a companion rail: activity, todos, registry files during a session.
// The shell contributes only its header; the body is a slot, because which
// cards belong here changes with the session.
//
// Upstream: `WorkspaceCompanionRail.tsx` → `RightWorkspacePanel`.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');

  const render = (el, opts) => {
    const root = h('aside', { class: 'hn-rail', 'data-slot': 'rail' });

    const header = h('div', { class: 'hn-rail-header', 'data-slot': 'rail.header' });
    header.appendChild(h('span', { class: 'hn-rail-title', text: 'Workspace' }));
    const actions = h('div', { class: 'hn-rail-actions' });
    // Slot: header actions, so a plugin adds a control without this file changing.
    const headerSlot = h('div', { class: 'hn-slot-inline' });
    S.mount('hana.rail.header', headerSlot);
    actions.appendChild(headerSlot);
    actions.appendChild(h('button', {
      class: 'hn-icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close panel',
      onclick: () => opts && opts.onClose && opts.onClose(),
    }, svgIcon('M18 6L6 18M6 6l12 12', 15)));
    header.appendChild(actions);
    root.appendChild(header);

    // The body is a slot: activity cards, a todo list, the file registry.
    const body = h('div', { class: 'hn-rail-body hn-scroll-quiet', 'data-slot': 'rail.items' });
    S.mount('hana.rail.items', body);
    root.appendChild(body);

    el.appendChild(root);
    return undefined;
  };

  return { render };
})();
