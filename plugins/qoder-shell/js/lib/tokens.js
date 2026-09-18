// Design tokens lifted from Qoder CN 0.2.5 (see docs/qoder-frontend-teardown.md).
//
// They are exposed as a JS object *and* written to the document root as CSS
// variables, so both a component's inline style and any stylesheet can use the
// same values. Qoder's naming is kept verbatim — `bg-bg-container`,
// `text-text-tertiary` — because it reads like a sentence and because a
// familiar name is one less thing to translate.
return (function () {
  const light = {
    'bg-base': '#fff', 'bg-container': '#fff', 'bg-layout': '#fdfdfd',
    'bg-elevated': '#f9f9f9', 'bg-spotlight': '#fafafa',
    'text': '#141414', 'text-secondary': '#636261',
    'text-tertiary': '#838280', 'text-quaternary': '#aaa9a8',
    'text-on-primary': '#fdfdfd',
    'border': '#bcbbba', 'border-secondary': '#ddd', 'border-tertiary': '#e6e6e6',
    'fill': '#dfdfdf', 'fill-secondary': '#efefef',
    'primary': '#4b6f5a', 'primary-hover': '#436651', 'primary-bg': '#f2f4f2',
    'primary-border': '#d5dbd8', 'primary-text': '#4b6f5a',
    'success': '#579b6e', 'error': '#ec5b56', 'warning': '#efb041', 'info': '#3b81e9',
    'link': '#4d9868',
  };
  // `forest-dark` — Qoder's flagship dark palette. The app defaults to it
  // because it is the most recognisable of the nine themes.
  const dark = {
    'bg-base': '#0e0e0e', 'bg-container': '#111110', 'bg-layout': '#111110',
    'bg-elevated': '#22221f', 'bg-spotlight': '#22221f',
    'text': '#eeeeeb', 'text-secondary': '#b4b4ac',
    'text-tertiary': '#7b7b74', 'text-quaternary': '#585853',
    'text-on-primary': '#080807',
    'border': '#3b3a35', 'border-secondary': '#31312d', 'border-tertiary': '#292926',
    'fill': '#31312d', 'fill-secondary': '#292926',
    'primary': '#5cb870', 'primary-hover': '#9be6b3', 'primary-bg': '#14261c',
    'primary-border': '#335942', 'primary-text': '#8ee5a1',
    'success': '#73cd94', 'error': '#ff4d4f', 'warning': '#faad14', 'info': '#0b83f1',
    'link': '#8ee5a1',
  };

  // Qoder's rule: every dark theme name ends in `-dark`, so one selector can
  // cover them all. We keep the convention even with one dark palette.
  const THEMES = {
    'forest-dark': dark,
    'bee-dark': { ...dark, 'primary': '#e0c65c', 'primary-hover': '#f0dc8c',
                  'bg-container': '#171814', 'bg-elevated': '#22231d',
                  'primary-bg': '#2a2a1e', 'primary-border': '#47483f' },
    'mint-dark': { ...dark, 'primary': '#62c9a8', 'primary-hover': '#8fe0c4',
                   'bg-container': '#121a16', 'bg-elevated': '#1b2620',
                   'primary-bg': '#16261f', 'primary-border': '#394a42' },
    'parchment-dark': { ...dark, 'primary': '#e08a68', 'primary-hover': '#f0ab8c',
                        'bg-container': '#1b1815', 'bg-elevated': '#272220',
                        'primary-bg': '#2a211c', 'primary-border': '#4b433b' },
    'forest-light': light,
    'bee-light': { ...light, 'primary': '#0d0d0d', 'primary-hover': '#2a2a2a',
                   'primary-text': '#0d0d0d' },
    'mint-light': { ...light, 'primary': '#4fa98f', 'primary-hover': '#63c1a5',
                    'bg-container': '#fff', 'text': '#2f4b2d',
                    'border': '#afcbc1', 'primary-bg': '#eaf7f2' },
    'light-parchment': { ...light, 'primary': '#c96442', 'primary-hover': '#d97a5c',
                         'text': '#202116', 'border': '#d4cfc6', 'primary-bg': '#faf0eb' },
  };

  /** Write a theme's tokens onto an element as CSS custom properties. */
  const apply = (el, name) => {
    const t = THEMES[name] || THEMES['forest-dark'];
    for (const [k, v] of Object.entries(t)) el.style.setProperty('--qs-' + k, v);
    el.dataset.theme = name;
    // `-dark` names are covered by one selector, per Qoder's convention.
    const darkish = /-dark$/.test(name);
    el.style.colorScheme = darkish ? 'dark' : 'light';
    return t;
  };

  return { THEMES, apply, names: Object.keys(THEMES) };
})();
