// Resize handles for the shell.
//
// Two axes, one mechanism:
//
//   * **Width** — the left sidebar, the preview panel and the right rail each
//     have a handle on their inner edge. The width is written to that column's
//     CSS custom property on the shell root, which is the single value both the
//     column and its inner content read (see style.css: `.hn-col-sidebar` and
//     `.hn-side > *` both size from `--dw-sidebar-width`), so one property keeps
//     the whole column coherent.
//
//   * **Height** — the titlebar is the shell's only horizontal divider, so its
//     bottom edge is a handle. It drives `--dw-titlebar-h`, and *only* the
//     titlebar: the column headers have their own `--dw-header-h`, because
//     dragging one bar and watching five headers grow is not what "resize the
//     titlebar" means.
//
// Following upstream (`use-sidebar-resize.ts`) in what is worth keeping:
//
//   * the size is clamped **live**, so a drag can never produce a broken layout;
//   * it is persisted per target, so a size survives a reload;
//   * double-clicking a handle resets that target — the only discoverable way
//     back if a drag goes somewhere silly.
return (function () {
  // One entry per draggable target. `edge` says which side of the target the
  // handle sits on, which is what decides the drag's sign — a handle on a
  // column's right edge grows when the pointer moves right; on its left edge it
  // grows when the pointer moves left. `max: null` means "no ceiling"; the
  // preview overrides it with a function, since its limit depends on the window.
  const TARGETS = {
    sidebar:  { axis: 'x', prop: '--dw-sidebar-width',  edge: 'right',  fallback: 240, min: 180, max: 480 },
    preview:  { axis: 'x', prop: '--dw-preview-width',  edge: 'left',   fallback: 580, min: 320, max: null },
    rail:     { axis: 'x', prop: '--dw-rail-width',     edge: 'left',   fallback: 260, min: 200, max: 600 },
    titlebar: { axis: 'y', prop: '--dw-titlebar-h',     edge: 'bottom', fallback: 44,  min: 36,  max: 120 },
  };

  const storageKey = (side, axis) => 'hana-shell-' + side + (axis === 'y' ? '-height' : '-width');

  const load = (key) => {
    try {
      const n = Number(window.localStorage.getItem(key));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (e) {
      // Storage can be unavailable (private mode, a locked-down webview). A
      // target that cannot remember its size still resizes; it just does not
      // persist, which is strictly better than throwing on load.
      return null;
    }
  };
  const save = (key, v) => { try { window.localStorage.setItem(key, String(v)); } catch (e) {} };
  const forget = (key) => { try { window.localStorage.removeItem(key); } catch (e) {} };

  /** Clamp to `[min, max]`; a `null`/`undefined` max means "no ceiling". */
  const clamp = (v, min, max) => {
    const upper = max == null ? Infinity : Math.max(min, max);
    return Math.max(min, Math.min(upper, v));
  };

  /**
   * Wire one drag handle.
   *
   * @param handle  the element the user grabs
   * @param opts
   *   root    element the CSS variable is written to (the shell root)
   *   target  element whose size is measured and changed (defaults to root)
   *   side    key into TARGETS
   *   max     optional number or function overriding the spec's ceiling
   * @returns a disposer that removes every listener it added
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

    // Restore the size the user set in a previous session.
    const stored = load(key);
    if (stored != null) apply(stored);

    let drag = null;

    const onMove = (e) => {
      if (!drag) return;
      const pointer = axis === 'y' ? e.clientY : e.clientX;
      // The sign depends on which edge the handle is on: dragging a handle away
      // from its column grows it, whichever direction that is.
      const delta = before ? drag.start - pointer : pointer - drag.start;
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
      // A collapsed column has nothing to grab — the handle is also hidden in
      // CSS, this is the belt to that braces.
      if (target.hasAttribute('data-collapsed')) return;
      e.preventDefault();
      // The titlebar handle lives inside a Tauri drag region; without this a
      // vertical drag would move the window instead of resizing the bar.
      if (e.stopPropagation) e.stopPropagation();
      drag = { start: axis === 'y' ? e.clientY : e.clientX, startSize: measure(), live: measure() };
      handle.classList.add('active');
      document.body.classList.add(axis === 'y' ? 'resizing-y' : 'resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', endDrag);
    };
    // Double-click returns the target to its token default.
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

  return { install, TARGETS };
})();
