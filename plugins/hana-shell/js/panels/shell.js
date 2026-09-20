// The frame: HanaAgent's `.app-shell` — a titlebar row above a flex row of
// columns.
//
// Upstream's structure (`App.tsx` + `styles.css`):
//
//   .app-shell (flex column, 100vh)
//   ├─ .titlebar           44px, the drag row
//   └─ .app (flex row)
//       ├─ .sidebar        240px, collapsible
//       ├─ .main-content   flex:1 — the conversation
//       ├─ preview         580px, collapsible (chat only)
//       └─ .jian-sidebar   260px, collapsible (the right rail)
//
// The previous shell was a three-column grid with no titlebar. This one adds
// the titlebar, the preview column and splits the right column into preview and
// rail, matching Hana's chrome. Columns collapse by width rather than by
// unmounting, so a slot inside a hidden column keeps its contributions and
// reappears with them.
return (function () {
  const { h } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const titlebar = studio.require('panels/titlebar');
  const sidebar = studio.require('panels/sidebar');
  const conversation = studio.require('panels/conversation');
  const preview = studio.require('panels/preview');
  const rail = studio.require('panels/rail');

  const render = (el) => {
    const shell = h('div', { class: 'hn-shell', 'data-slot': 'root' });

    const row = h('div', { class: 'hn-app', 'data-pane': 'app' });
    const sideCol = h('div', { class: 'hn-col-sidebar', 'data-pane': 'sidebar' });
    const mainCol = h('div', { class: 'hn-col-main', 'data-pane': 'conversation' });
    const previewCol = h('div', { class: 'hn-col-preview', 'data-pane': 'preview', 'data-collapsed': '' });
    const railCol = h('div', { class: 'hn-col-rail', 'data-pane': 'rail' });
    row.appendChild(sideCol);
    row.appendChild(mainCol);
    row.appendChild(previewCol);
    row.appendChild(railCol);

    // ── collapse state ──────────────────────────────────────────────────────
    const setSidebar = (open) => {
      sideCol.toggleAttribute('data-collapsed', !open);
      shell.setAttribute('data-sidebar-open', open ? '' : 'false');
    };
    const setPreview = (open) => {
      previewCol.toggleAttribute('data-collapsed', !open);
      shell.setAttribute('data-preview-open', open ? '' : 'false');
    };
    const setRail = (open) => {
      railCol.toggleAttribute('data-collapsed', !open);
      shell.setAttribute('data-rail-open', open ? '' : 'false');
    };

    setSidebar(true);
    setPreview(false);
    setRail(true);

    // ── titlebar (owns the toggles) ─────────────────────────────────────────
    // Toggling passes the *state to move to*, which is "the opposite of where
    // it is now" — `hasAttribute` is true when collapsed, so it already reads
    // as the value we want to flip to.
    titlebar.render(shell, {
      title: 'New session',
      onToggleSidebar: () => setSidebar(sideCol.hasAttribute('data-collapsed')),
      onTogglePreview: () => setPreview(previewCol.hasAttribute('data-collapsed')),
      onToggleRail: () => setRail(railCol.hasAttribute('data-collapsed')),
    });

    // The titlebar is row one; the columns are row two. `tb.render` appended it
    // to `shell` — move the row beneath it.
    shell.appendChild(row);

    // ── columns ─────────────────────────────────────────────────────────────
    // The three panels are separate files, but a few actions cross between
    // them: "new session" lives in the sidebar's header and changes the
    // conversation; creating a session in the conversation must refresh the
    // sidebar's list. `hub` is the small join — each panel publishes what it
    // can do and calls the other's, looked up lazily so render order does not
    // matter.
    const hub = {};

    const dSide = sidebar.render(sideCol, {
      onCollapse: () => setSidebar(false),
      onOpenSettings: () => {
        const ta = document.querySelector('.hn-comp-input');
        if (ta) ta.focus();
      },
      onNewSession: () => hub.controls && hub.controls.newSession(),
      onSelectSession: (id) => {
        if (hub.select) hub.select(id);
        if (hub.controls) hub.controls.openSession(id);
      },
      registerRefresh: (fn) => { hub.refresh = fn; },
      registerSelection: (fn) => { hub.select = fn; },
    });

    const dConv = conversation.render(mainCol, {
      titleSetter: (text) => titlebar.setTitle(shell, text),
      registerControls: (c) => { hub.controls = c; },
      onSessionCreated: (id) => {
        if (hub.select) hub.select(id);
        if (hub.refresh) hub.refresh();
      },
      onSessionChanged: () => { if (hub.refresh) hub.refresh(); },
      // The model defaults to the provider name, which is what dsh's OpenAI
      // adapter expects when the provider is the model family (`deepseek` →
      // `deepseek-chat` is configured per-provider in studio.json, so the
      // route name is the honest default here).
      modelFor: (provider) => provider,
    });
    const dPreview = preview.render(previewCol, { onClose: () => setPreview(false) });
    const dRail = rail.render(railCol, { onClose: () => setRail(false) });

    // ── column resizing ─────────────────────────────────────────────────────
    // Each panel renders its own handle tagged with `data-resize`; the frame owns
    // the drag logic. The shell root carries the size variable, so one value
    // sizes a column and its inner content together. The preview's ceiling is
    // dynamic: a fixed one would let a wide window push the conversation below
    // its minimum, which is the failure upstream's `getPreviewMaxWidth` guards.
    const resize = studio.require('lib/resize');
    const disposers = [];
    const wireHandle = (side, column, max) => {
      const handle = column.querySelector('[data-resize="' + side + '"]');
      if (!handle) return;
      disposers.push(resize.install(handle, { root: shell, target: column, side, max }));
    };
    const CONV_MIN = 400;
    const previewCeiling = () => {
      const others = sideCol.getBoundingClientRect().width + railCol.getBoundingClientRect().width;
      return Math.max(320, window.innerWidth - others - CONV_MIN);
    };
    wireHandle('sidebar', sideCol);
    wireHandle('preview', previewCol, previewCeiling);
    wireHandle('rail', railCol);

    // The titlebar's bottom edge resizes it vertically. Its target is the whole
    // shell (the bar spans it), so the handle is measured against the bar
    // itself — `--dw-titlebar-h` is what the bar reads, so the drag tracks it.
    const hTitlebar = shell.querySelector('[data-resize="titlebar"]');
    if (hTitlebar) {
      disposers.push(resize.install(hTitlebar, { root: shell, target: shell.querySelector('.hn-tb'), side: 'titlebar' }));
    }

    // ── frame-level overlay ─────────────────────────────────────────────────
    // Above every column, `pointer-events:none` while empty so it never eats a
    // click; a plugin adding content re-enables it locally.
    const overlay = h('div', { class: 'hn-overlay', 'data-slot': 'shell.overlay' });
    S.mount('hana.shell.overlay', overlay);
    shell.appendChild(overlay);

    el.appendChild(shell);
    return () => {
      for (const d of disposers) {
        if (typeof d === 'function') d();
      }
      for (const d of [dSide, dConv, dPreview, dRail]) {
        if (typeof d === 'function') d();
      }
    };
  };

  return { render };
})();
