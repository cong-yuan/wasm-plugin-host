// Column resize for openhanako-shell (upstream CSS vars).
// Persists widths/heights in localStorage. Double-click resets a target.
return (function () {
  const TARGETS = {
    sidebar: {
      axis: 'x',
      prop: '--sidebar-width',
      edge: 'right',
      fallback: 240,
      min: 180,
      max: 480,
      handle: '#sidebarResizeHandle',
      target: '#sidebar',
    },
    preview: {
      axis: 'x',
      prop: '--preview-panel-width',
      edge: 'left',
      fallback: 580,
      min: 320,
      max: null,
      handle: '#previewPanel .resize-handle-left, #previewPanel .resize-handle',
      target: '#previewPanel',
    },
    rail: {
      axis: 'x',
      prop: '--jian-sidebar-width',
      edge: 'left',
      fallback: 260,
      min: 200,
      max: 600,
      handle: '#jianResizeHandle',
      target: '#jianSidebar',
    },
    titlebar: {
      axis: 'y',
      prop: '--titlebar-h',
      edge: 'bottom',
      fallback: 44,
      min: 36,
      max: 120,
      handle: '[data-resize="titlebar"]',
      target: '.titlebar',
    },
  };

  const storageKey = (side, axis) =>
    'openhanako-shell-' + side + (axis === 'y' ? '-height' : '-width');

  const load = (key) => {
    try {
      const n = Number(window.localStorage.getItem(key));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) {
      return null;
    }
  };
  const save = (key, v) => {
    try {
      window.localStorage.setItem(key, String(v));
    } catch (_) {}
  };
  const forget = (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch (_) {}
  };

  const clamp = (v, min, max) => {
    const upper = max == null ? Infinity : Math.max(min, max);
    return Math.max(min, Math.min(upper, v));
  };

  const qs = (root, sel) => {
    if (!sel) return null;
    // Support comma selectors (preview handle aliases).
    for (const part of sel.split(',')) {
      const el = root.querySelector(part.trim());
      if (el) return el;
    }
    return null;
  };

  /**
   * @param handle
   * @param opts {{ root: Element, target?: Element, side: string, max?: number|function }}
   */
  const install = (handle, opts) => {
    const spec = TARGETS[opts.side];
    if (!handle || !spec) return () => {};
    const { axis, prop, edge, fallback, min } = spec;
    const root = opts.root;
    const target = opts.target || root;
    const before = edge === 'left' || edge === 'top';
    const key = storageKey(opts.side, axis);

    const ceiling = () => {
      const source = opts.max !== undefined ? opts.max : spec.max;
      return typeof source === 'function' ? source() : source;
    };
    const measure = () => {
      const rect = target.getBoundingClientRect();
      const size = axis === 'y' ? rect.height : rect.width;
      return size > 0 ? size : fallback;
    };
    const apply = (v) => {
      const clamped = clamp(v, min, ceiling());
      root.style.setProperty(prop, clamped + 'px');
      return clamped;
    };

    const stored = load(key);
    if (stored != null) apply(stored);

    let drag = null;
    const onMove = (e) => {
      if (!drag) return;
      const pos = axis === 'y' ? e.clientY : e.clientX;
      const delta = before ? drag.start - pos : pos - drag.start;
      drag.live = apply(drag.startSize + delta);
    };
    const endDrag = () => {
      if (!drag) return;
      save(key, drag.live);
      handle.classList.remove('active');
      document.body.classList.remove(axis === 'y' ? 'resizing-y' : 'resizing');
      drag = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', endDrag);
    };
    const onDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (target.hasAttribute && target.hasAttribute('data-collapsed')) return;
      e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      drag = {
        start: axis === 'y' ? e.clientY : e.clientX,
        startSize: measure(),
        live: measure(),
      };
      handle.classList.add('active');
      document.body.classList.add(axis === 'y' ? 'resizing-y' : 'resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', endDrag);
    };
    const onReset = () => {
      root.style.removeProperty(prop);
      forget(key);
    };

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('dblclick', onReset);
    return () => {
      endDrag();
      handle.removeEventListener('mousedown', onDown);
      handle.removeEventListener('dblclick', onReset);
    };
  };

  /** Wire every known handle found under `root`. */
  const wireAll = (root) => {
    const disposers = [];
    const CONV_MIN = 400;
    const previewMax = () => {
      const side = qs(root, '#sidebar');
      const rail = qs(root, '#jianSidebar');
      const others =
        (side ? side.getBoundingClientRect().width : 0) +
        (rail ? rail.getBoundingClientRect().width : 0);
      return Math.max(320, window.innerWidth - others - CONV_MIN);
    };
    for (const [side, spec] of Object.entries(TARGETS)) {
      const handle = qs(root, spec.handle);
      const target = qs(root, spec.target) || root;
      if (!handle) continue;
      const max = side === 'preview' ? previewMax : undefined;
      disposers.push(install(handle, { root, target, side, max }));
    }
    return () => disposers.forEach((d) => d && d());
  };

  return { install, wireAll, TARGETS };
})();
