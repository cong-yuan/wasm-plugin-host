// openhanako-shell — real openhanako UI in an iframe, plus overlay slots.
//
// The iframe stays 1:1. Slot hosts sit in a transparent overlay; when empty they
// use pointer-events:none / visibility:hidden so they never block the UI.
studio.register('OpenhanakoShell', (el) => {
  const url = (window.__OPENHANAKO_UI_URL__) || 'http://127.0.0.1:5173/index.html';
  const S = studio.require('lib/slots');

  el.style.cssText =
    'position:absolute;inset:0;margin:0;padding:0;overflow:hidden;background:#EFE8DB';
  el.innerHTML = '';

  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'openhanako';
  frame.style.cssText =
    'border:0;width:100%;height:100%;display:block;background:#EFE8DB;position:absolute;inset:0;z-index:0';
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');

  const overlay = document.createElement('div');
  overlay.className = 'ohk-slot-overlay';
  overlay.style.cssText =
    'position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden';

  // Approximate chrome anchors (desktop openhanako layout). Fine-tune later;
  // empty hosts stay invisible and non-interactive either way.
  const places = [
    ['openhanako.titlebar.left', 'position:absolute;top:6px;left:72px;display:flex;gap:6px;align-items:center;'],
    ['openhanako.titlebar.center', 'position:absolute;top:6px;left:50%;transform:translateX(-50%);display:flex;gap:6px;'],
    ['openhanako.titlebar.right', 'position:absolute;top:6px;right:12px;display:flex;gap:6px;align-items:center;'],
    ['openhanako.sidebar.header', 'position:absolute;top:48px;left:8px;width:220px;'],
    ['openhanako.sidebar.activities', 'position:absolute;top:96px;left:8px;width:220px;'],
    ['openhanako.sidebar.sessions', 'position:absolute;top:200px;left:8px;width:220px;max-height:40%;overflow:auto;'],
    ['openhanako.sidebar.notice', 'position:absolute;bottom:56px;left:8px;width:220px;'],
    ['openhanako.sidebar.footer', 'position:absolute;bottom:8px;left:8px;width:220px;'],
    ['openhanako.conversation.header', 'position:absolute;top:48px;left:260px;right:280px;'],
    ['openhanako.conversation.hero', 'position:absolute;top:40%;left:50%;transform:translate(-50%,-50%);'],
    ['openhanako.conversation.stream', 'position:absolute;top:100px;right:280px;width:0;'], // reserved; keep narrow unless filled
    ['openhanako.conversation.input.dock', 'position:absolute;bottom:72px;left:50%;transform:translateX(-50%);display:flex;gap:8px;'],
    ['openhanako.conversation.input.right', 'position:absolute;bottom:24px;right:300px;display:flex;gap:6px;'],
    ['openhanako.preview.panel', 'position:absolute;top:48px;right:12px;width:260px;bottom:12px;overflow:auto;'],
    ['openhanako.rail.header', 'position:absolute;top:48px;right:12px;width:240px;'],
    ['openhanako.rail.items', 'position:absolute;top:88px;right:12px;width:240px;bottom:12px;overflow:auto;'],
    ['openhanako.shell.overlay', 'position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:center;padding:24px;'],
  ];

  const disposers = [];
  for (const [name, style] of places) {
    disposers.push(S.mount(name, overlay, style));
  }

  el.appendChild(frame);
  el.appendChild(overlay);

  return () => {
    for (const d of disposers) {
      try { d(); } catch (_) {}
    }
    frame.remove();
    overlay.remove();
  };
});
