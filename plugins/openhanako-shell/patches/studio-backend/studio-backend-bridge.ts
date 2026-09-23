/**
 * Studio backend bridge — iframe side.
 *
 * When the parent shell (openhanako-shell) says hello, chat HTTP and the
 * `/ws` socket are forwarded with postMessage. Tauri stays in the parent.
 * Standalone openhanako (no parent hello) keeps using its own server.
 *
 * Upstream shapes this matches:
 * - loadSessions → GET /api/sessions (session-actions.ts)
 * - ensureSession → POST /api/sessions/new-detached
 * - switchSession → POST /api/sessions/switch
 * - loadMessages → GET /api/sessions/messages?path=&sessionId=
 * - prompt → WS `{ type: 'prompt', text, sessionId, sessionPath, clientMessageId }`
 * - assistant text → `text_delta` + `turn_end` with `sessionPath`
 *   (ws-message-handler.ts REACT_CHAT_EVENTS → StreamBufferManager)
 */

export const PEER_SOURCE = 'openhanako-studio-bridge';
export const SHELL_SOURCE = 'openhanako-shell';

type BridgeMode = 'pending' | 'on' | 'off';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const HANDSHAKE_MS = 2000;
const HTTP_TIMEOUT_MS = 20000;
const WS_TIMEOUT_MS = 120000;

let mode: BridgeMode = 'pending';
let installed = false;
let readyPromise: Promise<boolean> | null = null;
let readyWaiters: Array<() => void> = [];
let seq = 0;
const pending = new Map<string, Pending>();

function inIframe(): boolean {
  try {
    return !!window.parent && window.parent !== window;
  } catch {
    return false;
  }
}

function enable(): void {
  if (mode === 'on') return;
  mode = 'on';
  const waiters = readyWaiters;
  readyWaiters = [];
  waiters.forEach((fn) => fn());
}

function whenReady(): Promise<boolean> {
  if (!inIframe()) {
    mode = 'off';
    return Promise.resolve(false);
  }
  if (mode === 'on') return Promise.resolve(true);
  if (mode === 'off') return Promise.resolve(false);
  if (!readyPromise) {
    readyPromise = new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        if (mode === 'pending') mode = 'off';
        resolve(mode === 'on');
      }, HANDSHAKE_MS);
      readyWaiters.push(() => {
        window.clearTimeout(timer);
        resolve(true);
      });
    });
  }
  return readyPromise;
}

function probe(): void {
  if (!inIframe()) return;
  try {
    window.parent.postMessage({ source: PEER_SOURCE, type: 'hello' }, '*');
  } catch {
    // parent gone
  }
}

function rpc(payload: Record<string, unknown>): Promise<unknown> {
  const requestId = 'sb-' + (++seq);
  const timeout = payload.op === 'ws' ? WS_TIMEOUT_MS : HTTP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('studio bridge timeout'));
    }, timeout);
    pending.set(requestId, { resolve, reject, timer });
    try {
      window.parent.postMessage({
        source: PEER_SOURCE,
        type: 'request',
        requestId,
        ...payload,
      }, '*');
    } catch (err) {
      window.clearTimeout(timer);
      pending.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function onParentMessage(ev: MessageEvent): void {
  if (ev.source !== window.parent) return;
  const data = ev.data;
  if (!data || data.source !== SHELL_SOURCE) return;
  if (data.type === 'studio-backend-hello') {
    enable();
    return;
  }
  if (data.type !== 'response' || !data.requestId) return;
  const item = pending.get(data.requestId);
  if (!item) return;
  pending.delete(data.requestId);
  window.clearTimeout(item.timer);
  if (data.ok) item.resolve(data.result);
  else item.reject(new Error(data.error || 'studio bridge error'));
}

function requestUrl(input: RequestInfo | URL): { pathname: string; search: string } {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    const url = new URL(raw, window.location.origin);
    return { pathname: url.pathname, search: url.search };
  } catch {
    const q = raw.indexOf('?');
    if (q < 0) return { pathname: raw, search: '' };
    return { pathname: raw.slice(0, q), search: raw.slice(q) };
  }
}

/** Paths the vertical slice must answer from Studio, plus the init gates
 *  that otherwise abort before loadSessions / the socket. */
export function intercepts(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname === '/api/config') return true;
  if (pathname === '/api/agents') return true;
  if (pathname === '/api/models') return true;
  if (pathname === '/api/server/identity') return true;
  if (pathname === '/api/ws-ticket') return true;
  if (pathname === '/api/preferences/session-permission-default') return true;
  if (pathname === '/api/sessions') return true;
  if (pathname === '/api/sessions/messages') return true;
  if (pathname === '/api/sessions/switch') return true;
  if (pathname === '/api/sessions/new') return true;
  if (pathname === '/api/sessions/new-detached') return true;
  if (/^\/api\/agents\/[^/]+\/config$/.test(pathname)) return true;
  return false;
}

function isChatSocket(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.pathname === '/ws';
  } catch {
    return /\/ws(\?|$)/.test(url);
  }
}

function readJsonBody(init?: RequestInit): unknown {
  const raw = init && init.body;
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

type SocketHandler = ((ev: { type?: string; data?: string; target?: unknown }) => void) | null;

function StudioSocket(this: {
  url: string;
  readyState: number;
  protocol: string;
  extensions: string;
  binaryType: string;
  bufferedAmount: number;
  onopen: SocketHandler;
  onmessage: SocketHandler;
  onclose: SocketHandler;
  onerror: SocketHandler;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, fn: SocketHandler) => void;
  removeEventListener: () => void;
}, url: string) {
  this.url = String(url);
  this.readyState = 0;
  this.protocol = '';
  this.extensions = '';
  this.binaryType = 'blob';
  this.bufferedAmount = 0;
  this.onopen = null;
  this.onmessage = null;
  this.onclose = null;
  this.onerror = null;
  const self = this;
  queueMicrotask(() => {
    if (self.readyState !== 0) return;
    self.readyState = 1;
    if (typeof self.onopen === 'function') self.onopen({ type: 'open', target: self });
  });
}

StudioSocket.prototype.send = function send(data: string) {
  let message: Record<string, unknown> = {};
  try { message = JSON.parse(String(data)); } catch { return; }
  const self = this;
  rpc({ op: 'ws', message }).then((result) => {
    const events = result && typeof result === 'object' && Array.isArray((result as { events?: unknown }).events)
      ? (result as { events: unknown[] }).events
      : [];
    events.forEach((event) => {
      if (typeof self.onmessage === 'function') {
        self.onmessage({ data: JSON.stringify(event), target: self });
      }
    });
  }).catch((err) => {
    const sessionPath = typeof message.sessionPath === 'string' ? message.sessionPath : '';
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
    if (typeof self.onmessage === 'function') {
      self.onmessage({
        data: JSON.stringify({
          type: 'error',
          sessionPath,
          sessionId,
          message: err instanceof Error ? err.message : String(err),
        }),
        target: self,
      });
    }
  });
};

StudioSocket.prototype.close = function close() {
  this.readyState = 3;
  if (typeof this.onclose === 'function') this.onclose({ type: 'close', target: this });
};

StudioSocket.prototype.addEventListener = function addEventListener(type: string, fn: SocketHandler) {
  if (type === 'open') this.onopen = fn;
  else if (type === 'message') this.onmessage = fn;
  else if (type === 'close') this.onclose = fn;
  else if (type === 'error') this.onerror = fn;
};

StudioSocket.prototype.removeEventListener = function removeEventListener() {};

function installWebSocketShim(): void {
  const Native = window.WebSocket;
  if (!Native || (Native as unknown as { __studioBridge?: boolean }).__studioBridge) return;

  function Patched(this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const href = String(url);
    // pending 阶段也要走桥：hello 尚未到达时若先连原生 /ws（假端口），
    // 会失败且不会在握手后自动重建。
    if (mode !== 'off' && isChatSocket(href)) {
      return new (StudioSocket as unknown as new (u: string) => WebSocket)(href);
    }
    if (protocols === undefined) return new Native(url);
    return new Native(url, protocols);
  }
  Patched.CONNECTING = Native.CONNECTING;
  Patched.OPEN = Native.OPEN;
  Patched.CLOSING = Native.CLOSING;
  Patched.CLOSED = Native.CLOSED;
  Patched.prototype = Native.prototype;
  (Patched as unknown as { __studioBridge?: boolean }).__studioBridge = true;
  window.WebSocket = Patched as unknown as typeof WebSocket;
}

function installFetchShim(): void {
  const native = window.fetch.bind(window);
  if ((window.fetch as unknown as { __studioBridge?: boolean }).__studioBridge) return;
  const patched = async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = requestUrl(input);
    const on = intercepts(target.pathname) ? await whenReady() : false;
    if (!on || !intercepts(target.pathname)) return native(input, init);
    const result = await rpc({
      op: 'http',
      method: (init && init.method) || 'GET',
      path: target.pathname,
      search: target.search,
      body: readJsonBody(init),
    });
    return new Response(JSON.stringify(result == null ? null : result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  (patched as unknown as { __studioBridge?: boolean }).__studioBridge = true;
  window.fetch = patched as typeof window.fetch;
}

function ensurePlatform(): void {
  if (!inIframe()) return;
  const host = window as unknown as { platform?: Record<string, unknown> };
  if (!host.platform) {
    host.platform = {
      getServerPort: async () => '17321',
      getServerToken: async () => 'studio-bridge',
      appReady() {},
      onSettingsChanged() {},
    };
    return;
  }
  const platform = host.platform;
  if (platform.__studioBridgePort) return;
  platform.__studioBridgePort = true;
  const orig = typeof platform.getServerPort === 'function'
    ? (platform.getServerPort as () => Promise<unknown>).bind(platform)
    : null;
  platform.getServerPort = async () => {
    if (orig) {
      try {
        const port = await orig();
        if (port !== undefined && port !== null && String(port).trim() !== '') return port;
      } catch {
        // embedded shell has no Hana port; the dummy below is loopback-only
      }
    }
    const on = await whenReady();
    return on ? '17321' : null;
  };
  if (typeof platform.getServerToken !== 'function') {
    platform.getServerToken = async () => 'studio-bridge';
  }
  if (typeof platform.appReady !== 'function') platform.appReady = () => {};
  if (typeof platform.onSettingsChanged !== 'function') platform.onSettingsChanged = () => {};
}

/** Install fetch/WS shims and handshake with the parent. Idempotent. */
export function startStudioBackendBridge(): () => void {
  if (!inIframe()) return () => {};
  if (installed) return () => {};
  installed = true;
  window.addEventListener('message', onParentMessage);
  ensurePlatform();
  installFetchShim();
  installWebSocketShim();
  probe();
  const iv = window.setInterval(() => {
    if (mode !== 'pending') {
      window.clearInterval(iv);
      return;
    }
    probe();
  }, 300);
  return () => {
    window.removeEventListener('message', onParentMessage);
    window.clearInterval(iv);
  };
}
