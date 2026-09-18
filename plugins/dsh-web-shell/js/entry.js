// dsh-web-shell — the shell from zhu1090093659/dsh-web, as a WASM plugin.
//
// Thin on purpose. The value of this plugin is the **slot surface** it exposes,
// not the pixels: a later plugin adds a feature by declaring
// `injects: [{ slot: "dsh-web.sidebar.footer", component: "X" }]` and it appears,
// with no change here. See `lib/slots.js` for the inventory.
const tokens = studio.require('lib/tokens');
const layout = studio.require('panels/shell');

studio.register('DshWebShell', (el) => {
  // Tokens go on <html> so anything a later plugin adds inherits them.
  tokens.apply(document.documentElement, 'dark');
  return layout.render(el);
});

// A card for the host app's own dashboard, so this plugin is useful in both
// windows rather than only when it owns the launch view.
studio.register('DshWebCard', (el) => {
  const { h, sv } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  el.appendChild(h('div', {
    style: 'padding:14px;border:1px solid ' + sv('border-tertiary') + ';border-radius:8px;' +
           'background:' + sv('bg-elevated') + ';font-size:13px',
  }, 'dsh-web shell',
     h('div', { style: 'color:' + sv('text-tertiary') + ';font-size:12px;margin-top:4px',
       text: S.SLOTS.length + ' slots opened for later plugins' })));
  return undefined;
});
studio.inject('dashboard.cards', 'DshWebCard', 0);
