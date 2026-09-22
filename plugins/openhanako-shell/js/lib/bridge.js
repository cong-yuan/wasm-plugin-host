// Geometry bridge: iframe reports [data-ohk-slot] rects; we position hosts.
//
// Contributions still render in the Studio parent (they need studio.*). Anchors
// live in the real openhanako DOM — this only syncs placement.
return (function () {
  const SOURCE = 'openhanako-shell';
  const BRIDGE = 'openhanako-slot-bridge';

  const applyRects = (layer, hosts, slots, frameEl) => {
    const fr = frameEl.getBoundingClientRect();
    const lr = layer.getBoundingClientRect();
    // Rects from iframe are viewport-relative inside the iframe document.
    // Map into the overlay layer's coordinate space.
    for (const [name, host] of Object.entries(hosts)) {
      const r = slots[name];
      if (!r || !r.visible || r.width < 1 || r.height < 1) {
        host.style.display = 'none';
        host.style.pointerEvents = 'none';
        continue;
      }
      const top = fr.top + r.top - lr.top;
      const left = fr.left + r.left - lr.left;
      host.style.display = 'block';
      host.style.top = `${top}px`;
      host.style.left = `${left}px`;
      host.style.width = `${r.width}px`;
      host.style.height = `${r.height}px`;
      // pointer-events still gated by contribution presence (slots.mount sync)
    }
  };

  const attach = (frameEl, layer, hosts) => {
    const onMessage = (ev) => {
      const data = ev.data;
      if (!data || data.source !== BRIDGE || data.type !== 'rects') return;
      if (ev.source !== frameEl.contentWindow) return;
      applyRects(layer, hosts, data.slots || {}, frameEl);
    };
    window.addEventListener('message', onMessage);

    const hello = () => {
      try {
        frameEl.contentWindow && frameEl.contentWindow.postMessage(
          { source: SOURCE, type: 'hello' },
          '*',
        );
      } catch (_) {}
    };

    frameEl.addEventListener('load', hello);
    // In case the bridge booted before we listened.
    hello();
    const iv = setInterval(hello, 2000);

    return () => {
      window.removeEventListener('message', onMessage);
      frameEl.removeEventListener('load', hello);
      clearInterval(iv);
    };
  };

  return { attach, SOURCE };
})();
