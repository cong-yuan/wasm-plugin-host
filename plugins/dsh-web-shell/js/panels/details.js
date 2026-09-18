// Right column — slot surface only. No metrics / theme chrome.
return (function () {
  const { h } = studio.require('lib/dom');
  const S = studio.require('lib/slots');

  const render = (el, opts) => {
    const root = h('aside', {
      class: 'dw-details',
      'data-slot': 'details',
      'data-dsh-surface': 'details',
    });

    const header = h('div', {
      'data-slot': 'details.header',
      style:
        'flex:none;display:flex;align-items:center;min-height:48px;padding:12px 16px;' +
        'border-bottom:0.5px solid var(--dsw-alias-border-l3);' +
        'color:var(--dsw-alias-label-caption);font-size:11px;font-weight:600;' +
        'letter-spacing:.06em;text-transform:uppercase',
    }, 'Details');
    const headerSlot = h('div', { style: 'margin-left:auto;display:flex;gap:4px' });
    headerSlot.appendChild(h('button', {
      type: 'button',
      title: 'Close',
      style:
        'width:28px;height:28px;border:0;border-radius:50%;cursor:pointer;' +
        'background:transparent;color:var(--dsw-alias-label-secondary)',
      onclick: () => opts && opts.close && opts.close(),
    }, '×'));
    S.mount('dsh-web.details.header', headerSlot);
    header.appendChild(headerSlot);
    root.appendChild(header);

    const body = h('div', {
      class: 'dw-details-slot dw-scroll-quiet',
      'data-slot': 'details.items',
    });
    S.mount('dsh-web.details.items', body);
    root.appendChild(body);

    el.appendChild(root);
    return undefined;
  };
  return { render };
})();
