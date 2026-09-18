// Element builder + the token accessor. Kept tiny on purpose: a plugin should
// be readable without learning a framework.
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
  const sv = (n) => `var(--dw-${n})`;
  const muted = (size) => `font-size:${size || 12}px;color:${sv('text-tertiary')}`;
  /** A region wrapper: carries a data-slot attribute so CSS and tests can find it. */
  const region = (name, style, ...kids) =>
    h('div', { 'data-slot': name, style }, ...kids);
  return { h, sv, muted, region };
})();
