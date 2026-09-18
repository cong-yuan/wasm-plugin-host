// Element builder. Prefer CSS classes over inline styles so the chrome matches
// official DSH tokens (`var(--dsw-*)`) rather than baking colours into JS.
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

  /** Official token reference helper for the rare inline case. */
  const dsw = (name) => `var(--dsw-${name})`;

  /** Region wrapper: `data-slot` (official) + optional `data-dsh-surface`. */
  const region = (slotName, attrs, ...kids) =>
    h('div', Object.assign({ 'data-slot': slotName }, attrs || {}), ...kids);

  const svgIcon = (d, size) =>
    h('svg', {
      width: size || 16, height: size || 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true',
    }, h('path', { d }));

  return { h, dsw, region, svgIcon };
})();
