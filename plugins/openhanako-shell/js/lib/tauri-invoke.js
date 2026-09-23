// Thin Tauri IPC wrapper for plugin JS running in the Studio main webview.
//
// `entry.js` is evaluated with `new Function("studio", source)` in that
// webview, so `window.__TAURI__` / `__TAURI_INTERNALS__` are the same objects
// the Svelte chat page uses. The openhanako iframe is cross-origin and must
// not call this directly.
return (function () {
  const missing = 'Tauri invoke is not available in this window (missing window.__TAURI__.core.invoke and window.__TAURI_INTERNALS__.invoke)';

  const resolveInvoke = () => {
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

  // Tauri 2: `window.__TAURI__.event.listen` (and some builds expose
  // `__TAURI_INTERNALS__.transformCallback` + plugin listen). Prefer the
  // public event API used by Studio's own `onChatPartial`.
  const resolveListen = () => {
    const tauri = window.__TAURI__;
    if (tauri && tauri.event && typeof tauri.event.listen === 'function') {
      return (event, handler) => tauri.event.listen(event, handler);
    }
    // Some Tauri 2 builds expose listen only via internals + plugin IPC.
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.transformCallback === 'function' && typeof internals.invoke === 'function') {
      return async (event, handler) => {
        const cb = internals.transformCallback((ev) => {
          try { handler(ev); } catch (_) {}
        }, true);
        await internals.invoke('plugin:event|listen', { event, handler: cb, target: { kind: 'Any' } });
        return () => { try { internals.invoke('plugin:event|unlisten', { event, handlerId: cb }); } catch (_) {} };
      };
    }
    return null;
  };

  const available = () => !!resolveInvoke();

  const invoke = (cmd, args) => {
    const fn = resolveInvoke();
    if (!fn) return Promise.reject(new Error(missing));
    return fn(cmd, args || {});
  };

  /** @returns {Promise<() => void>} unlisten */
  const listen = async (event, handler) => {
    const fn = resolveListen();
    if (!fn) {
      return () => {};
    }
    const unlisten = await fn(event, (ev) => {
      try {
        handler(ev && Object.prototype.hasOwnProperty.call(ev, 'payload') ? ev.payload : ev);
      } catch (_) { /* UI handler errors must not break the turn */ }
    });
    return typeof unlisten === 'function' ? unlisten : () => {};
  };

  return { available, invoke, listen, missing };
})();
