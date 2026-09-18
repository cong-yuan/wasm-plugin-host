// dsh-web-shell — a slot-bearing shell wearing HanaAgent's visual language.
//
// Thin by design. The plugin's value is the **slot surface** (see
// lib/slots.js), not the pixels; the look is tokens + a stylesheet, so it can
// be replaced without touching the panels or anything that plugs into them.
const tokens = studio.require('lib/tokens');
const motion = studio.require('lib/motion');
const layout = studio.require('panels/shell');

/** Install the keyframes once. `@keyframes` cannot be set per element, so this
 *  has to be a stylesheet rather than inline styles. */
function installMotion() {
  const id = 'dw-shell-motion';
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = motion.CSS;
  document.head.appendChild(el);
}

studio.register('DshWebShell', (el) => {
  // Tokens on <html> so anything a later plugin adds inherits the palette.
  tokens.apply(document.documentElement, 'warm-paper');
  installMotion();
  return layout.render(el);
});

// A dashboard card, so the plugin is useful in the host app's own window too.
studio.register('DshWebCard', (el) => {
  const { h, v } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  el.appendChild(h('div', {
    class: 'dw-comp-card',
    style: 'font-size:var(--dw-fs-body)',
  }, 'Hana shell',
     h('div', { style: `color:${v('text-muted')};font-size:var(--dw-fs-caption);margin-top:4px` },
       `${S.SLOTS.length} slots open for later plugins`)));
  return undefined;
});
studio.inject('dashboard.cards', 'DshWebCard', 0);
