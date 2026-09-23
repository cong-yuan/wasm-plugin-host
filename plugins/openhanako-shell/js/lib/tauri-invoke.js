// Thin Tauri IPC wrapper for plugin JS running in the Studio main webview.
//
// `entry.js` is evaluated with `new Function("studio", source)` in that
// webview, so `window.__TAURI__` / `__TAURI_INTERNALS__` are the same objects
// the Svelte chat page uses. The openhanako iframe is cross-origin and must
// not call this directly.
return (function () {
  const missing = 'Tauri invoke is not available in this window (missing window.__TAURI__.core.invoke and window.__TAURI_INTERNALS__.invoke)';

  const resolve = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
      return (cmd, args) => internals.invoke(cmd, args || {});
    }
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      return (cmd, args) => tauri.core.invoke(cmd, args || {});
    }
    return null;
  };

  const available = () => !!resolve();

  const invoke = (cmd, args) => {
    const fn = resolve();
    if (!fn) return Promise.reject(new Error(missing));
    return fn(cmd, args || {});
  };

  // Subscribe to a Tauri event. Returns a Promise<unlisten>.
  const listen = (event, handler) => {
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.transformCallback === 'function' && window.__TAURI__?.event?.listen) {
      return window.__TAURI__.event.listen(event, (e) => handler(e.payload));
    }
    const tauri = window.__TAURI__;
    if (tauri && tauri.event && typeof tauri.event.listen === 'function') {
      return tauri.event.listen(event, (e) => handler(e && e.payload !== undefined ? e.payload : e));
    }
    return Promise.resolve(() => {});
  };

  return { available, invoke, listen, missing };
})();
