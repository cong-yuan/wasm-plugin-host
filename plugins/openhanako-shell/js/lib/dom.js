return (function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Tags that must live in the SVG namespace. Creating them with
  // document.createElement() puts them in the HTML namespace, where the
  // browser renders nothing at all.
  const SVG_TAGS = new Set([
    'svg', 'path', 'rect', 'line', 'circle', 'ellipse', 'polyline',
    'polygon', 'g', 'defs', 'use', 'text', 'tspan', 'clipPath', 'mask',
    'linearGradient', 'radialGradient', 'stop',
  ]);

  const h = (tag, attrs, ...children) => {
    const node = SVG_TAGS.has(tag)
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'class') node.setAttribute('class', value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  // Parse a verbatim upstream <svg>…</svg> string. Lets icons be copied
  // straight out of the openhanako source instead of being re-drawn, so
  // shapes, stroke widths and viewBoxes match exactly.
  const svg = (markup) => {
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="' + SVG_NS + '">' + markup + '</svg>',
      'image/svg+xml',
    );
    const parsed = doc.documentElement.firstElementChild;
    return parsed ? document.importNode(parsed, true) : null;
  };

  const clear = (node) => node.replaceChildren();
  return { h, svg, clear };
})();
