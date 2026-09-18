// A tiny DOM builder, so panel code reads as structure rather than string
// concatenation. Mirrors the shape used by `ui-multifile`.
return (function () {
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
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
  // Styling helpers that keep every component reading the same tokens.
  const sv = (name) => `var(--qs-${name})`;
  const muted = (size) => `font-size:${size || 13}px;color:${sv('text-tertiary')}`;
  return { h, sv, muted };
})();
