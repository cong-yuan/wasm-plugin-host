// Design tokens: HanaAgent's visual language, kept as Hana names them.
//
// Source: `liliMozi/openhanako` (Apache-2.0) — `desktop/src/styles.css` for the
// structural scale and `desktop/src/themes/*.css` for the palettes. The names
// are kept verbatim (`--bg`, `--accent`, `--fs-body`, `--radius-lg`) so a rule
// copied from their code lands here unchanged, and so anyone who knows Hana can
// read this file.
//
// Two layers, as upstream separates them:
//
//   1. structural — spacing, radius, type scale, motion. Theme-independent.
//   2. palette    — colours. One block per theme.
//
// A plugin only ever sets `--dw-*` on the document root, so nothing leaks into
// another plugin's names.
return (function () {
  // ── layer 1: structural (theme-independent) ──────────────────────────────
  const STRUCTURAL = {
    // Spacing, a 4px grid — the real subset upstream uses, not a full ramp.
    'space-2': '0.125rem', 'space-4': '0.25rem', 'space-6': '0.375rem',
    'space-8': '0.5rem', 'space-10': '0.625rem', 'space-12': '0.75rem',
    'space-16': '1rem', 'space-24': '1.5rem', 'space-32': '2rem', 'space-40': '2.5rem',

    // Radius. `--radius-input` / `--radius-chat-surface` are the two that give
    // the interface its softness: controls are 6px, the composer is 16px.
    'radius-xs': '3px', 'radius-sm': '5px', 'radius-md': '8px', 'radius-lg': '12px',
    'radius-input': '6px', 'radius-chat-surface': '16px', 'radius-card': '8px',

    // Type scale — six steps, smaller than a typical web ramp because the UI is
    // dense. Body text is 0.9rem, not 1rem.
    'fs-title': '1rem', 'fs-body': '0.9rem', 'fs-ui': '0.82rem',
    'fs-caption': '0.78rem', 'fs-hint': '0.7rem', 'fs-micro': '0.62rem',

    // Fonts. The serif is the identifiable part of the look: headings and
    // display text are serif, UI text is sans. Only system faces are listed —
    // we do not ship Inter or EB Garamond, and a missing webfont would flash
    // fallback anyway. The stacks degrade in the same order upstream's do.
    'font-ui': "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    'font-serif': "'Songti SC', 'STSong', 'Noto Serif SC', Georgia, 'Times New Roman', serif",
    'font-mono': "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",

    // Motion. Three durations and four curves cover every transition upstream
    // ships; `--ease-out` is the one that makes things feel soft.
    'duration-instant': '0.1s', 'duration-fast': '0.15s', 'duration-slow': '0.25s',
    'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
    'ease-in': 'cubic-bezier(0.7, 0, 0.84, 0)',
    'ease-standard': 'cubic-bezier(0.2, 0, 0, 1)',
    'ease-smooth': 'cubic-bezier(0.22, 0.68, 0, 1)',

    // Layout. The composer is narrower than the window and the columns are
    // fixed widths, which is what makes the proportions read as a document
    // rather than a dashboard. `titlebar-h` is the row above the columns; the
    // rail and preview are the two right-hand columns (Hana's `jian-sidebar`
    // and preview panel).
    'sidebar-width': '240px',
    'rail-width': '260px',
    'preview-width': '580px',
    // One divider height, shared by the titlebar and every column header, so a
    // drag on any of them lines the bars up rather than growing one alone.
    'titlebar-h': '44px',
    'chat-column-width': '720px',
    'chat-column-extra': '1.25rem',
  };

  // ── layer 2: palettes ────────────────────────────────────────────────────
  //
  // `warm-paper` — the default, and the one that defines the product: warm
  // off-white paper, dusty blue accent, an all-over brown-tinted border.
  const warmPaper = {
    'bg': '#F8F4ED',
    'bg-card': '#FCFAF5',
    'bg-glass': 'rgba(250, 248, 242, 0.92)',
    'sidebar-bg': '#F4F0EA',
    'accent': '#537D96',
    'accent-hover': '#456A80',
    'accent-light': 'rgba(83, 125, 150, 0.08)',
    'accent-rgb': '83, 125, 150',
    'text': '#3B3D3F',
    'text-light': '#6B6F73',
    'text-muted': '#8E9196',
    // Borders are tinted brown, not grey — the single change that stops the
    // light theme looking like every other neutral admin panel.
    'border': 'rgba(122, 96, 88, 0.18)',
    'shadow': 'rgba(59, 61, 63, 0.09)',
    'green': '#7BAE7F',
    'green-rgb': '123, 174, 127',
    'coral': '#EC8F8D',
    'coral-rgb': '236, 143, 141',
    'danger': '#8B3A3A',
    'danger-rgb': '139, 58, 58',
    'hanako-text': '#2B3A4E',
    'user-bg': 'rgba(83, 125, 150, 0.08)',
    'tool-bg': 'rgba(0, 0, 0, 0.03)',
    'tool-text': '#6B6F73',
    'jian-note-bg': '#FAF5E9',
    'jian-note-border': 'rgba(180, 160, 130, 0.15)',
    'overlay-subtle': 'rgba(0, 0, 0, 0.03)',
    'overlay-light': 'rgba(0, 0, 0, 0.05)',
    'overlay-medium': 'rgba(0, 0, 0, 0.08)',
    'overlay-strong': 'rgba(0, 0, 0, 0.15)',
    'scheme': 'light',
  };

  // `midnight` — deep teal-blue with a warm rose accent. Kept as the dark
  // counterweight; the accent turning pink is what makes it recognisably the
  // same family rather than "a dark grey theme".
  const midnight = {
    'bg': '#3B4A54',
    'bg-card': '#445560',
    'bg-glass': 'rgba(59, 74, 84, 0.92)',
    'sidebar-bg': '#34424B',
    'accent': '#C99AAF',
    'accent-hover': '#D8AFC0',
    'accent-light': 'rgba(201, 154, 175, 0.11)',
    'accent-rgb': '201, 154, 175',
    'text': '#E1EAF0',
    'text-light': '#B7C5CE',
    'text-muted': '#A3B5C0',
    'border': 'rgba(170, 121, 141, 0.16)',
    'shadow': 'rgba(0, 0, 0, 0.36)',
    'green': '#8CC790',
    'green-rgb': '140, 199, 144',
    'coral': '#EAB2A0',
    'coral-rgb': '234, 178, 160',
    'danger': '#C77070',
    'danger-rgb': '199, 112, 112',
    'hanako-text': '#DCE6EC',
    'user-bg': 'rgba(170, 121, 141, 0.10)',
    'tool-bg': 'rgba(255, 255, 255, 0.03)',
    'tool-text': '#B7C5CE',
    'jian-note-bg': '#4B5A63',
    'jian-note-border': 'rgba(170, 121, 141, 0.14)',
    'overlay-subtle': 'rgba(255, 255, 255, 0.03)',
    'overlay-light': 'rgba(255, 255, 255, 0.05)',
    'overlay-medium': 'rgba(255, 255, 255, 0.08)',
    'overlay-strong': 'rgba(255, 255, 255, 0.15)',
    'scheme': 'dark',
  };

  const THEMES = { 'warm-paper': warmPaper, midnight: midnight };

  /** Write a theme onto an element as CSS custom properties. */
  const apply = (el, name) => {
    const palette = THEMES[name] || THEMES['warm-paper'];
    for (const [k, v] of Object.entries(STRUCTURAL)) el.style.setProperty('--dw-' + k, v);
    for (const [k, v] of Object.entries(palette)) {
      if (k === 'scheme') continue;
      el.style.setProperty('--dw-' + k, v);
    }
    el.dataset.theme = name;
    el.style.colorScheme = palette.scheme;
    return palette;
  };

  return { THEMES, apply, names: Object.keys(THEMES) };
})();
