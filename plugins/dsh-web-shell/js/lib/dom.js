// Element builder and the small helpers every panel uses.
//
// Styling lives in `style.css` rather than inline, so the look can be changed
// in one place and the panels stay readable. The one exception is a token
// reference (`v('accent')`) for the rare property that has no class.
return (function () {
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  };

  /** A token reference, for the few properties with no class to carry them. */
  const v = (name) => `var(--dw-${name})`;

  /** A region wrapper: carries `data-slot` so CSS and tests can address it. */
  const region = (slotName, attrs, ...kids) =>
    h('div', Object.assign({ 'data-slot': slotName }, attrs || {}), ...kids);

  /** A 24×24-grid stroke icon, sized to the shell's glyph scale. */
  const svgIcon = (d, size) =>
    h('svg', {
      width: size || 16, height: size || 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
    }, h('path', { d }));

  return { h, v, region, svgIcon };
})();
