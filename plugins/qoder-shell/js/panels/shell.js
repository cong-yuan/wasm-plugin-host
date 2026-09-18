// The three-column shell: sidebar | main | inspector.
//
// Kept apart from `entry.js` so the layout can be read (and changed) without
// scrolling past registration boilerplate.
return (function () {
  const { h, sv } = studio.require('lib/dom');
  const sidebar = studio.require('panels/sidebar');
  const inspector = studio.require('panels/inspector');
  const chat = studio.require('panels/chat');

  const render = (el) => {
    const root = h('div', {
      style:
        'display:flex;height:100%;min-height:0;overflow:hidden;' +
        'background:' + sv('bg-container') + ';color:' + sv('text') +
        ";font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
    });

    // Each pane returns a disposer; the component returns their composition, so
    // unloading the plugin tears down every timer it started.
    const wrapSide = h('div', { style: 'display:flex;min-height:0' });
    const disposeS = sidebar.render(wrapSide, { activeKey: 'chats' });
    root.appendChild(wrapSide);

    const main = h('main', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;min-height:0' });
    root.appendChild(main);
    chat.render(main);

    const wrapI = h('div', { style: 'display:flex;min-height:0' });
    const disposeI = inspector.render(wrapI);
    root.appendChild(wrapI);

    el.appendChild(root);
    return () => { if (disposeS) disposeS(); if (disposeI) disposeI(); };
  };

  return { render };
})();
