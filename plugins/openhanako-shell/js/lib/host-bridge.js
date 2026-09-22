// Parent side of the openhanako iframe ↔ Studio agent bridge.
//
// The iframe cannot call Tauri. It posts `{ source: 'openhanako-studio-bridge' }`
// and we answer with the same `requestId`, after `lib/hana-adapter` has
// invoked the agent commands.
return (function () {
  const adapter = studio.require('lib/hana-adapter');

  const SOURCE = 'openhanako-shell';
  const PEER = 'openhanako-studio-bridge';

  const helloPayload = () => ({ source: SOURCE, type: 'studio-backend-hello' });

  const reply = (frameEl, requestId, ok, result, error) => {
    try {
      if (!frameEl.contentWindow) return;
      frameEl.contentWindow.postMessage({
        source: SOURCE,
        type: 'response',
        requestId,
        ok: !!ok,
        result: result == null ? null : result,
        error: error || null,
      }, '*');
    } catch (_) {}
  };

  const attach = (frameEl) => {
    const hello = () => {
      try {
        if (frameEl.contentWindow) frameEl.contentWindow.postMessage(helloPayload(), '*');
      } catch (_) {}
    };

    const onMessage = (ev) => {
      const data = ev.data;
      if (!data || data.source !== PEER) return;
      if (frameEl.contentWindow && ev.source !== frameEl.contentWindow) return;
      if (data.type === 'hello') {
        hello();
        return;
      }
      if (data.type !== 'request' || !data.requestId) return;
      Promise.resolve()
        .then(() => adapter.handle(data))
        .then((result) => reply(frameEl, data.requestId, true, result, null))
        .catch((err) => {
          reply(frameEl, data.requestId, false, null, err && err.message ? err.message : String(err));
        });
    };

    window.addEventListener('message', onMessage);
    frameEl.addEventListener('load', hello);
    hello();
    const iv = setInterval(hello, 2000);

    return () => {
      window.removeEventListener('message', onMessage);
      frameEl.removeEventListener('load', hello);
      clearInterval(iv);
    };
  };

  return { attach, SOURCE, PEER };
})();
