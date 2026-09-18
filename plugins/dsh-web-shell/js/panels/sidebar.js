// Official SidebarRoot structure — no fake sessions / admin rows.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');

  const render = (el) => {
    const root = h('aside', {
      class: 'dw-side-root',
      'data-slot': 'sidebar',
      'data-dsh-surface': 'sidebar',
    });

    const logoRow = h('div', { class: 'dw-side-logoRow' });
    const brand = h('button', {
      class: 'dw-side-brand',
      type: 'button',
    },
      h('span', { class: 'dw-side-brandIdentity' },
        h('span', { class: 'dw-side-brandMark', 'data-slot': 'sidebar.brand.mark' },
          // Simple mark — real logo comes from brand plugin later.
          h('svg', {
            width: 22, height: 22, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true',
          }, h('path', {
            d: 'M12 3c-3.2 2.4-5 5.3-5 8.2 0 3.4 2.5 6.3 5 8.8 2.5-2.5 5-5.4 5-8.8C17 8.3 15.2 5.4 12 3z',
          })),
        ),
        h('span', {
          class: 'dw-side-brandName',
          'data-slot': 'sidebar.brand.name',
          text: 'DeepSeek',
        }),
      ),
    );
    const brandSlot = h('span', { style: 'display:inline-flex' });
    S.mount('dsh-web.sidebar.brand', brandSlot);
    brand.querySelector('.dw-side-brandIdentity').appendChild(brandSlot);

    const actions = h('div', { style: 'display:inline-flex;align-items:center;gap:2px' });
    S.mount('dsh-web.sidebar.actions', actions);
    logoRow.appendChild(brand);
    logoRow.appendChild(actions);
    root.appendChild(logoRow);

    root.appendChild(h('button', {
      class: 'dw-side-newSession',
      type: 'button',
      'data-dsh-part': 'new-session',
      onclick: () => {
        const ta = document.querySelector('[data-dsh-part="composer-input"]');
        if (ta) ta.focus();
      },
    },
      svgIcon('M12 5v14M5 12h14', 14),
      h('span', { class: 'dw-side-newSessionLabel', text: 'New Session' }),
    ));

    // Workspaces region — empty until a plugin fills the slot.
    const region = h('div', {
      class: 'dw-side-regionArea',
      'data-slot': 'sidebar.workspaces',
    });
    const list = h('div', {
      class: 'dw-side-regionArea dw-scroll-quiet',
      style: 'overflow-y:auto;padding-right:8px',
      'data-slot': 'sidebar.items',
    });
    S.mount('dsh-web.sidebar.items', list);
    region.appendChild(list);
    root.appendChild(region);

    const foot = h('div', { class: 'dw-side-footArea', 'data-slot': 'sidebar.footer' });
    const footerSlot = h('div', {
      class: 'dw-side-footerActions',
      'data-slot': 'sidebar.footer.action',
    });
    S.mount('dsh-web.sidebar.footer', footerSlot);
    foot.appendChild(footerSlot);
    root.appendChild(foot);

    el.appendChild(root);
    return undefined;
  };
  return { render };
})();
