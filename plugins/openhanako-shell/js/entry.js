studio.register('OpenhanakoShell', (el) => {
  const url = (window.__OPENHANAKO_UI_URL__) || 'http://127.0.0.1:5173/index.html';
  el.style.cssText = 'position:absolute;inset:0;margin:0;padding:0;overflow:hidden;background:#EFE8DB';
  el.innerHTML = '';
  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'openhanako';
  frame.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#EFE8DB';
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  el.appendChild(frame);
  return () => { frame.remove(); };
});
