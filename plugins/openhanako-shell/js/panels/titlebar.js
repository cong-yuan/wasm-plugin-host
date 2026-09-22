// Ported verbatim from openhanako AppTitlebar.tsx (Apache-2.0).
// Upstream: desktop/src/react/components/app/AppTitlebar.tsx
// WindowControls renders nothing on macOS/web, so it is intentionally absent.
return (function () {
  const { h, svg } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const { t } = studio.require('lib/i18n');

  // Upstream SVG markup, copied character for character.
  const ICON_LEFT = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="9" y1="3" x2="9" y2="21"></line>
    </svg>`;
  const ICON_NEW = `
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>`;
  const ICON_PREVIEW = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 3.5h7l3 3v14H7z"></path>
      <path d="M14 3.5v3h3"></path>
      <path d="M9.5 11h5"></path>
      <path d="M9.5 14.5h5"></path>
    </svg>`;
  const ICON_RIGHT = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="15" y1="3" x2="15" y2="21"></line>
    </svg>`;

  function render(options) {
    const opts = options || {};

    // <div className="tb-left-group">
    const toggleLeft = h('button', {
      class: 'tb-toggle tb-toggle-left' + (opts.sidebarOpen === false ? '' : ' active'),
      id: 'tbToggleLeft',
      title: t('sidebar.toggle'),
      onmousedown: (e) => e.preventDefault(),
    }, svg(ICON_LEFT));
    const newSession = h('button', {
      class: 'tb-toggle tb-new-session',
      type: 'button',
      title: t('sidebar.newChat'),
      'aria-label': t('sidebar.newChat'),
      'data-mobile-titlebar-action': 'new-session',
      onmousedown: (e) => e.preventDefault(),
    }, svg(ICON_NEW));
    const left = h('div', { class: 'tb-left-group' }, toggleLeft, newSession);
    slots.mount('hana.titlebar.left', left);

    // {centerTitle && <div className="tb-center-title">…}
    const titleText = h('span', {}, opts.title || '');
    const center = h('div', {
      class: 'tb-center-title',
      'aria-label': t('titlebar.currentChatTitle'),
      title: opts.title || '',
    }, titleText);
    slots.mount('hana.titlebar.center', center);

    // <div className="tb-right-group">
    const togglePreview = h('button', {
      class: 'tb-toggle tb-toggle-preview' + (opts.previewOpen ? ' active' : ''),
      id: 'tbTogglePreview',
      title: t('preview.toggle'),
      onmousedown: (e) => e.preventDefault(),
    }, svg(ICON_PREVIEW));
    const toggleRight = h('button', {
      class: 'tb-toggle tb-toggle-right' + (opts.jianOpen === false ? '' : ' active'),
      id: 'tbToggleRight',
      title: t('sidebar.jian'),
      onmousedown: (e) => e.preventDefault(),
    }, svg(ICON_RIGHT));
    const right = h('div', { class: 'tb-right-group' }, togglePreview, toggleRight);
    slots.mount('hana.titlebar.right', right);

    // Upstream drives `active` from props; the shell owns the state and calls
    // the setters below, so handlers only report intent.
    toggleLeft.onclick = () => opts.onToggleSidebar?.();
    newSession.onclick = () => opts.onNew?.();
    togglePreview.onclick = () => opts.onTogglePreview?.();
    toggleRight.onclick = () => opts.onToggleJian?.();

    const root = h('div', { class: 'titlebar' }, left, center, right);

    return {
      root,
      setSidebar: (open) => toggleLeft.classList.toggle('active', !!open),
      setPreview: (open) => togglePreview.classList.toggle('active', !!open),
      setJian: (open) => toggleRight.classList.toggle('active', !!open),
      setTitle(text) {
        titleText.textContent = text || '';
        center.setAttribute('title', text || '');
      },
    };
  }

  return { render };
})();
