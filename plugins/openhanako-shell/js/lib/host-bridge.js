// Parent side of the openhanako iframe ↔ Studio agent bridge.
//
// The iframe cannot call Tauri. It posts `{ source: 'openhanako-studio-bridge' }`
// and we answer with the same `requestId`, after `lib/hana-adapter` has
// invoked the agent commands.
//
// For WS turns, progress is also pushed as `{ type: 'event', requestId, event }`
// so the iframe can render text_delta / thinking_* incrementally while
// `send_message` is still awaiting Studio's when_idle.
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

  const pushEvent = (frameEl, requestId, event) => {
    try {
      if (!frameEl.contentWindow) return;
      frameEl.contentWindow.postMessage({
        source: SOURCE,
        type: 'event',
        requestId,
        event,
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
      const emit = data.op === 'ws'
        ? (event) => pushEvent(frameEl, data.requestId, event)
        : null;
      Promise.resolve()
        .then(() => adapter.handle(data, emit))
        .then((result) => {
          // When events were already pushed, strip the duplicate payload so the
          // iframe does not replay the whole turn on the final ack.
          let out = result;
          if (emit && result && typeof result === 'object' && result.streamed) {
            out = { events: [], streamed: true };
          }
          reply(frameEl, data.requestId, true, out, null);
        })
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
