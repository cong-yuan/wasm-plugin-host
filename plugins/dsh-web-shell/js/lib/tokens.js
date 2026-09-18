// Design tokens for the shell.
//
// The *names* follow dsh-web's semantic convention (`bg-*`, `text-*`,
// `border-*`, `fill-*`), because it reads well and because a plugin author
// guessing a token name should guess right. The values are ours.
//
// Qoder-reconstructed values are used where they work well, since the earlier
// pass produced a palette that was verified against a real shipped app.
return (function () {
  const dark = {
    'bg-base': '#0e0e0e',
    'bg-layout': '#111110',
    'bg-container': '#161614',
    'bg-elevated': '#1d1d1a',
    'text': '#eeeeeb',
    'text-secondary': '#b4b4ac',
    'text-tertiary': '#7b7b74',
    'text-quaternary': '#585853',
    'text-on-primary': '#08120c',
    'border': '#2b2b27',
    'border-secondary': '#232320',
    'border-tertiary': '#1b1b19',
    'fill': '#31312d',
    'fill-secondary': '#232320',
    'primary': '#5cb870',
    'primary-hover': '#9be6b3',
    'primary-bg': '#14261c',
    'primary-border': '#335942',
    'primary-text': '#8ee5a1',
    'success': '#73cd94',
    'warning': '#faad14',
    'error': '#ff4d4f',
    'info': '#0b83f1',
  };
  const light = {
    'bg-base': '#fdfdfd',
    'bg-layout': '#f7f7f6',
    'bg-container': '#fff',
    'bg-elevated': '#f9f9f9',
    'text': '#141414',
    'text-secondary': '#636261',
    'text-tertiary': '#838280',
    'text-quaternary': '#aaa9a8',
    'text-on-primary': '#fdfdfd',
    'border': '#ddd',
    'border-secondary': '#e6e6e6',
    'border-tertiary': '#eee',
    'fill': '#efefef',
    'fill-secondary': '#f6f6f6',
    'primary': '#4b6f5a',
    'primary-hover': '#436651',
    'primary-bg': '#f2f4f2',
    'primary-border': '#d5dbd8',
    'primary-text': '#4b6f5a',
    'success': '#579b6e',
    'warning': '#efb041',
    'error': '#ec5b56',
    'info': '#3b81e9',
  };
  const THEMES = { dark, light };

  /** Write a palette onto an element as CSS variables. */
  const apply = (el, name) => {
    const t = THEMES[name] || THEMES.dark;
    for (const [k, v] of Object.entries(t)) el.style.setProperty('--dw-' + k, v);
    el.dataset.theme = name;
    el.style.colorScheme = name === 'light' ? 'light' : 'dark';
    return t;
  };
  return { THEMES, apply, names: Object.keys(THEMES) };
})();
