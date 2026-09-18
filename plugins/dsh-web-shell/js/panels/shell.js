// The three-column frame, plus the frame-level overlay.
//
// Kept separate from `entry.js` so the layout can be read at a glance: this file
// IS the structure the slot names refer to.
return (function () {
  const { h, sv } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const sidebar = studio.require('panels/sidebar');
  const conversation = studio.require('panels/conversation');
  const details = studio.require('panels/details');

  const render = (el) => {
    const root = h('div', {
      'data-slot': 'root',
      style:
        'display:flex;height:100%;min-height:0;overflow:hidden;position:relative;' +
        'background:' + sv('bg-base') + ';color:' + sv('text') +
        ";font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
    });

    const side = h('div', { style: 'display:flex;min-height:0' });
    const main = h('div', { style: 'flex:1;min-width:0;display:flex;min-height:0' });
    const right = h('div', { style: 'display:flex;min-height:0' });
    root.appendChild(side); root.appendChild(main); root.appendChild(right);

    const dSide = sidebar.render(side);
    const dConv = conversation.render(main);
    const dRight = details.render(right);

    // A frame-level overlay slot, above every column. `pointer-events:none` so
    // an empty overlay never eats a click; a plugin that puts content in it can
    // re-enable pointer events on its own element.
    const overlay = h('div', {
      'data-slot': 'shell.overlay',
      style: 'position:absolute;inset:0;pointer-events:none;z-index:10',
    });
    root.appendChild(overlay);
    S.mount('dsh-web.shell.overlay', overlay);

    el.appendChild(root);
    return () => {
      if (typeof dSide === 'function') dSide();
      if (typeof dConv === 'function') dConv();
      if (typeof dRight === 'function') dRight();
    };
  };
  return { render };
})();
