// Qoder's main navigation, and the built-in pages of our own app that each
// entry maps onto. The recreation is a *shell*: clicking an entry shows the
// closest real page we have, so the navigation is live rather than a mock.
//
// Qoder's set (from the i18n namespace `nav`):
//   chats workDirectory projects automation extensions myWork discussion
return (function () {
  const { h, sv } = studio.require('lib/dom');

  const ENTRIES = [
    { key: 'chats',        label: 'Chats',        icon: 'M4 4h16v11H8l-4 4z', href: '/chat' },
    { key: 'workDirectory', label: 'Work Directory', icon: 'M3 6h6l2 2h10v10H3z',   href: '/' },
    { key: 'projects',     label: 'Projects',     icon: 'M4 5h7l2 2h7v11H4z',   href: '/services' },
    { key: 'automation',   label: 'Automation',   icon: 'M12 3v5l4 2',          href: '/tools' },
    { key: 'extensions',   label: 'Extensions',   icon: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z',
                           href: '/plugins' },
    { key: 'myWork',       label: 'My Work',      icon: 'M8 5h11v14H5V8',      href: '/logs' },
    { key: 'discussion',   label: 'Discussion',   icon: 'M4 6h16v9H9l-5 4z',    href: '/capabilities' },
  ];

  /** Render the navigation list. `onPick` receives the entry. */
  const render = (el, activeKey, onPick) => {
    const list = h('div', { style: 'display:flex;flex-direction:column;gap:1px;padding:0 8px' });
    for (const e of ENTRIES) {
      const active = e.key === activeKey;
      const item = h('button', {
        class: 'qs-nav-item' + (active ? ' active' : ''),
        style:
          'display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;' +
          'border-radius:6px;cursor:pointer;font:inherit;font-size:13px;text-align:left;' +
          'background:' + (active ? sv('primary-bg') : 'transparent') + ';' +
          'color:' + (active ? sv('primary-text') : sv('text-secondary')),
        // Qoder's inactive items lighten on hover; the state is a class, so a
        // stylesheet can do it instead of inline JS when a plugin prefers.
        onmouseenter: (ev) => { if (!active) ev.currentTarget.style.background = sv('fill-secondary'); },
        onmouseleave: (ev) => { if (!active) ev.currentTarget.style.background = 'transparent'; },
        onclick: () => onPick(e),
      },
        h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
                   stroke: 'currentColor', 'stroke-width': 1.7,
                   'stroke-linejoin': 'round', 'stroke-linecap': 'round' },
          h('path', { d: e.icon })),
        h('span', { text: e.label }),
      );
      list.appendChild(item);
    }
    el.appendChild(list);
  };

  return { ENTRIES, render };
})();
