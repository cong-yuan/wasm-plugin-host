// Official DSH Web theme tokens (`@deepseek-ai/dsh-client-ui-theme`).
//
// Source of truth: the installed package's dark/light alias + specific surface
// values (resolved from `--dsw-static-*`). Names stay `--dsw-*` so CSS written
// against the real shell (and dsh-web skins) can land here without remapping.
//
// Craft kept from earlier experiments (not their palette): quiet scrollbars,
// reduced-motion respect, dense calm chrome — those live in `style.css`.
return (function () {
  const FONT =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", ' +
    '"Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif';

  const ELEVATION_SOFT =
    '0 0 0 0.5px color-mix(in srgb, var(--dsw-alias-border-l2) 80%, transparent), ' +
    '0 4px 16px 0 #00000008, 0 0 24px 0 #00000008';

  /** Dark theme — `body[data-ds-dark-theme]` in the official shell. */
  const dark = {
    '--dsw-alias-bg-base': '#151517',
    '--dsw-alias-bg-layer-1': '#232324',
    '--dsw-alias-bg-layer-2': '#2c2c2e',
    '--dsw-alias-bg-layer-3': '#353638',
    '--dsw-alias-bg-overlay': '#61666b',
    '--dsw-alias-bg-module-platform': '#353638',
    '--dsw-alias-border-l1': '#ffffff0f',
    '--dsw-alias-border-l2': '#ffffff1f',
    '--dsw-alias-border-l3': '#ffffff29',
    '--dsw-alias-border-l4': '#fff3',
    '--dsw-alias-brand-primary': '#f9fafb',
    '--dsw-alias-brand-text': '#f9fafb',
    '--dsw-alias-brand-primary-invert': '#f9fafb',
    '--dsw-alias-label-primary': '#f9fafb',
    '--dsw-alias-label-secondary': '#cfd3d6',
    '--dsw-alias-label-tertiary': '#adb2b8',
    '--dsw-alias-label-dimmed': '#43454a',
    '--dsw-alias-label-caption': '#81858c',
    '--dsw-alias-label-primary-foreground': '#0f1115',
    '--dsw-alias-label-primary-inverted': '#353638',
    '--dsw-alias-label-primary-dimmed': '#ebeef2',
    '--dsw-alias-label-primary-bluish': '#f9fafb',
    '--dsw-alias-button-primary-fill': '#f9fafb',
    '--dsw-alias-button-primary-hover': '#ebeef2',
    '--dsw-alias-button-floating-fill': '#2c2c2e',
    '--dsw-alias-button-floating-hover': '#353638',
    '--dsw-alias-button-elevated-fill': '#43454a',
    '--dsw-alias-button-info-fill': '#679efe',
    '--dsw-alias-button-info-hover': '#4176e6',
    '--dsw-alias-interactive-bg-hover': '#ffffff14',
    '--dsw-alias-interactive-bg-active': '#ffffff24',
    '--dsw-alias-interactive-bg-hover-solid': '#353638',
    '--dsw-alias-interactive-bg-hover-accent': '#ffffff3d',
    '--dsw-alias-state-error-primary': '#f25a5a',
    '--dsw-alias-state-warn-primary': '#f59e0b',
    '--dsw-alias-state-success-primary': '#22c55e',
    '--dsw-alias-state-business-primary': '#679efe',
    '--dsw-alias-state-business-tertiary': '#34415b',
    '--dsw-alias-scrollbar-bg-l1': '#3c3c3d',
    '--dsw-alias-scrollbar-bg-l2': '#545557',
    '--dsw-alias-scrollbar-hover-l1': '#545557',
    '--dsw-alias-scrollbar-hover-l2': '#65676b',
    '--dsw-alias-toast-bg': '#43454a',
    '--dsw-alias-tooltip-bg': '#43454a',
    '--dsw-specific-sidebar-fill': '#1b1b1c',
    '--dsw-specific-sidebar-nav-item-hover': '#2c2c2e',
    '--dsw-specific-sidebar-nav-item-active': '#43454a',
    '--dsw-specific-sidebar-nav-item-active-accent': '#353638',
    '--dsw-specific-input-major': '#2c2c2e',
    '--dsw-specific-bubble': '#2c2c2e',
    '--dsw-specific-bubble-highlight': '#43454a',
    '--dsw-specific-menu': '#353638',
    '--dsw-specific-selector': '#353638',
    '--dsw-specific-tip': '#353638',
  };

  /** Light theme — official `:root` / `body` defaults. */
  const light = {
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-bg-layer-2': '#ffffff',
    '--dsw-alias-bg-layer-3': '#ffffff',
    '--dsw-alias-bg-overlay': '#e9ecf2',
    '--dsw-alias-bg-module-platform': '#f5f6f7',
    '--dsw-alias-border-l1': '#0000000a',
    '--dsw-alias-border-l2': '#0000001a',
    '--dsw-alias-border-l3': '#0000001f',
    '--dsw-alias-border-l4': '#00000029',
    '--dsw-alias-brand-primary': '#0f1115',
    '--dsw-alias-brand-text': '#0f1115',
    '--dsw-alias-brand-primary-invert': '#0f1115',
    '--dsw-alias-label-primary': '#0f1115',
    '--dsw-alias-label-secondary': '#61666b',
    '--dsw-alias-label-tertiary': '#81858c',
    '--dsw-alias-label-dimmed': '#e1e5ee',
    '--dsw-alias-label-caption': '#adb2b8',
    '--dsw-alias-label-primary-foreground': '#ffffff',
    '--dsw-alias-label-primary-inverted': '#ffffff',
    '--dsw-alias-label-primary-dimmed': '#151517',
    '--dsw-alias-label-primary-bluish': '#0e3074',
    '--dsw-alias-button-primary-fill': '#0f1115',
    '--dsw-alias-button-primary-hover': '#43454a',
    '--dsw-alias-button-floating-fill': '#ffffff',
    '--dsw-alias-button-floating-hover': '#f1f3f5',
    '--dsw-alias-button-elevated-fill': '#ffffff',
    '--dsw-alias-button-info-fill': '#4176e6',
    '--dsw-alias-button-info-hover': '#679efe',
    '--dsw-alias-interactive-bg-hover': '#2631480f',
    '--dsw-alias-interactive-bg-active': '#2631481a',
    '--dsw-alias-interactive-bg-hover-solid': '#f1f3f5',
    '--dsw-alias-interactive-bg-hover-accent': '#26314824',
    '--dsw-alias-state-error-primary': '#ec1313',
    '--dsw-alias-state-warn-primary': '#f59e0b',
    '--dsw-alias-state-success-primary': '#22c55e',
    '--dsw-alias-state-business-primary': '#4176e6',
    '--dsw-alias-state-business-tertiary': '#e4edfd',
    '--dsw-alias-scrollbar-bg-l1': '#e5e5e5',
    '--dsw-alias-scrollbar-bg-l2': '#e5e5e5',
    '--dsw-alias-scrollbar-hover-l1': '#d4d4d4',
    '--dsw-alias-scrollbar-hover-l2': '#d4d4d4',
    '--dsw-alias-toast-bg': '#353638',
    '--dsw-alias-tooltip-bg': '#2c2c2e',
    '--dsw-specific-sidebar-fill': '#f9fafb',
    '--dsw-specific-sidebar-nav-item-hover': '#f1f3f5',
    '--dsw-specific-sidebar-nav-item-active': '#ebeef2',
    '--dsw-specific-sidebar-nav-item-active-accent': '#e4edfd',
    '--dsw-specific-input-major': '#ffffff',
    '--dsw-specific-bubble': '#edf3fe',
    '--dsw-specific-bubble-highlight': '#d3e2ff',
    '--dsw-specific-menu': '#ffffff',
    '--dsw-specific-selector': '#f5f6f7',
    '--dsw-specific-tip': '#f9fafb',
  };

  const THEMES = { dark, light };

  /** Paint a palette onto `el` (usually `<html>`), mirroring official attrs. */
  const apply = (el, name) => {
    const theme = THEMES[name] || THEMES.dark;
    for (const [k, v] of Object.entries(theme)) el.style.setProperty(k, v);
    el.style.setProperty('--dsw-font-family', FONT);
    el.style.setProperty('--dsw-elevation-soft', ELEVATION_SOFT);
    el.style.setProperty('--ds-ease-in-out', 'cubic-bezier(0.4, 0, 0.2, 1)');
    el.style.setProperty('--ds-transition-duration-slow', '200ms');
    el.dataset.theme = name;
    el.style.colorScheme = name === 'light' ? 'light' : 'dark';
    // Official dark flag lives on `document.body`.
    if (el.ownerDocument && el.ownerDocument.body) {
      if (name === 'dark') el.ownerDocument.body.setAttribute('data-ds-dark-theme', '');
      else el.ownerDocument.body.removeAttribute('data-ds-dark-theme');
    }
    return theme;
  };

  return { THEMES, apply, names: Object.keys(THEMES) };
})();
