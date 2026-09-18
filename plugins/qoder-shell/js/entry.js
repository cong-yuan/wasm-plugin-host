// qoder-shell — a recreation of the Qoder CN shell, as a plugin.
//
// Deliberately thin: it applies the theme, registers one component, and opens a
// slot. Everything else lives in its own module (`lib/`, `panels/`), which is
// why this stays readable at a handful of lines instead of one wall of JS.
const tokens = studio.require('lib/tokens');
const layout = studio.require('panels/shell');

// A plugin window renders a registered component full-window. The shell is that
// component: it paints sidebar, main pane and inspector as one layout.
studio.register('QoderShell', (el) => {
  // Themes are applied to <html>, so the tokens are inherited by everything —
  // including any UI a later plugin adds.
  tokens.apply(document.documentElement, 'forest-dark');
  return layout.render(el);
});

// A status card for the app's own dashboard, so the plugin is useful whether or
// not it owns the launch view.
studio.register('QoderStatusCard', (el) => {
  const { h, sv } = studio.require('lib/dom');
  const api = studio.require('lib/api');
  el.appendChild(h('div', {
    style: 'padding:14px;border:1px solid ' + sv('border-tertiary') + ';border-radius:8px;' +
           'background:' + sv('bg-elevated') + ';color:' + sv('text') + ';font-size:13px',
  }, 'Qoder shell', h('div', { style: 'color:' + sv('text-tertiary') + ';font-size:12px;margin-top:4px',
    text: 'the launch view is provided by this plugin' })));
  api.status().then((s) => {
    el.firstChild.appendChild(h('div', { style: 'font-size:12px;color:' + sv('text-tertiary') + ';margin-top:6px',
      text: s ? (s.tool_count || 0) + ' tools · ' + (s.plugin_count || 0) + ' plugins' : 'offline' }));
  });
  return undefined;
});
studio.inject('dashboard.cards', 'QoderStatusCard', 0);

// Opened for **later** plugins: this plugin owns the launch view, so it is the
// natural place for others to hang their own sidebar entries.
studio.provideSlot('qoder-shell.sidebar', 'Extra entries in the Qoder shell sidebar');
