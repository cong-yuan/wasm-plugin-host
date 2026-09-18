// dsh-web-shell — official DSH Web GUI chrome as a WASM plugin.
const tokens = studio.require('lib/tokens');
const layout = studio.require('panels/shell');

studio.register('DshWebShell', (el) => {
  tokens.apply(document.documentElement, 'dark');
  document.documentElement.style.height = '100%';
  document.body.style.height = '100%';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  // Inter if available locally; otherwise system stack from tokens.
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap';
  document.head.appendChild(link);
  return layout.render(el);
});
