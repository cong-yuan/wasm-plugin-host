// Injects the upstream @font-face set once per document.
//
// build-css.mjs keeps fonts out of style.css because upstream declares 521
// faces over 111 unique .woff2 files; inlining per face would repeat the same
// payloads for ~40 MiB. Here each file becomes one blob: URL, so every face
// referencing it shares a single copy.
return (function () {
  const MARK = 'data-hana-fonts';

  function toBlobUrl(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'font/woff2' }));
  }

  function install() {
    if (document.querySelector('style[' + MARK + ']')) return;
    const fonts = studio.require('lib/fonts');
    const urls = new Map();
    for (const [file, data] of Object.entries(fonts.files)) {
      urls.set(file, toBlobUrl(data));
    }
    const css = fonts.faces.replace(
      /__HANA_FONT__(.+?)__/g,
      (m, file) => urls.get(file) || '',
    );
    const style = document.createElement('style');
    style.setAttribute(MARK, '');
    style.textContent = css;
    document.head.appendChild(style);
  }

  return { install };
})();
