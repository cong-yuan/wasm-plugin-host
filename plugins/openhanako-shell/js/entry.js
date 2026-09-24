// openhanako-shell — real openhanako UI in an iframe.
//
// Slot hosts are positioned from geometry reported by anchors inside that UI
// (`data-ohk-slot` + StudioSlotBridge), not from guessed overlay coordinates.
// Chat HTTP/WS from that iframe is forwarded by the studio-backend host bridge
// (`lib/host-bridge`) onto Studio's Tauri agent commands.
studio.register('OpenhanakoShell', (el) => {
  const url = (window.__OPENHANAKO_UI_URL__) || 'http://127.0.0.1:5173/index.html';
  const S = studio.require('lib/slots');
  const B = studio.require('lib/bridge');
  const H = studio.require('lib/host-bridge');

  const RETRY_DELAY_MS = 4000;
  let retryTimer = null;
  let retryAttempt = 0;
  let ready = false;

  const retryUrl = () => {
    const hashAt = url.indexOf('#');
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const hash = hashAt >= 0 ? url.slice(hashAt) : '';
    const separator = base.includes('?') ? '&' : '?';
    retryAttempt += 1;
    return `${base}${separator}_ohk_retry=${retryAttempt}${hash}`;
  };

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

  const recovery = document.createElement('div');
  recovery.textContent = 'Open Hana UI unavailable. Retrying…';
  recovery.style.cssText =
    'position:absolute;inset:0;z-index:2;display:none;align-items:center;justify-content:center;' +
    'padding:24px;color:#6f6254;background:#EFE8DB;font:14px system-ui,sans-serif';

  const markReady = () => {
    ready = true;
    recovery.style.display = 'none';
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const armRecovery = () => {
    ready = false;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (ready) return;
      recovery.style.display = 'flex';
      frame.src = retryUrl();
      armRecovery();
    }, RETRY_DELAY_MS);
  };
  frame.addEventListener('load', armRecovery);

  el.appendChild(frame);
  el.appendChild(layer);
  el.appendChild(recovery);
  armRecovery();

  const detachBridge = B.attach(frame, layer, hosts, { onReady: markReady });
  const detachHost = H.attach(frame);

  return () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    frame.removeEventListener('load', armRecovery);
    detachHost();
    detachBridge();
    for (const d of disposers) {
      try { d(); } catch (_) {}
    }
    frame.remove();
    layer.remove();
    recovery.remove();
  };
});
