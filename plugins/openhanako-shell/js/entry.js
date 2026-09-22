// openhanako-shell — real openhanako UI in an iframe.
//
// Slot hosts are positioned from geometry reported by anchors inside that UI
// (`data-ohk-slot` + StudioSlotBridge), not from guessed overlay coordinates.
studio.register('OpenhanakoShell', (el) => {
  const url = (window.__OPENHANAKO_UI_URL__) || 'http://127.0.0.1:5173/index.html';
  const S = studio.require('lib/slots');
  const B = studio.require('lib/bridge');

  el.style.cssText =
    'position:absolute;inset:0;margin:0;padding:0;overflow:hidden;background:#EFE8DB';
  el.innerHTML = '';

  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'openhanako';
  frame.style.cssText =
    'border:0;width:100%;height:100%;display:block;background:#EFE8DB;' +
    'position:absolute;inset:0;z-index:0';
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');

  const layer = document.createElement('div');
  layer.className = 'ohk-slot-layer';
  layer.style.cssText =
    'position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden';

  const hosts = {};
  const disposers = [];
  for (const { name } of S.SLOTS) {
    const h = S.mount(name, layer);
    hosts[name] = h.el;
    disposers.push(h.dispose);
  }

  el.appendChild(frame);
  el.appendChild(layer);

  const detachBridge = B.attach(frame, layer, hosts);

  return () => {
    detachBridge();
    for (const d of disposers) {
      try { d(); } catch (_) {}
    }
    frame.remove();
    layer.remove();
  };
});
