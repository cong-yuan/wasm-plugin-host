// Map the slice of Hana's HTTP + WS chat protocol onto `lib/api`.
//
// Studio `AgentRow.id` is openhanako `sessionId`. Paths are synthetic
// (`studio://<id>`) because the iframe keys transcripts by `sessionPath`.
// The Hana assistant id stays a constant (`studio`) so agent switch UI does
// not treat every session as a different assistant.
//
// For prompts, progress is pushed through an optional `emit` callback as soon
// as transcript growth is observed — Studio has no token Tauri channel, so the
// parent polls `transcript` while `send_message` is in flight.
return (function () {
  const api = studio.require('lib/api');

  const ASSISTANT_ID = 'studio';
  const ASSISTANT_NAME = 'Hanako';
  const PATH_PREFIX = 'studio://';

  const pathFor = (id) => PATH_PREFIX + encodeURIComponent(String(id));

  const idFrom = (value) => {
    if (value == null) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    if (raw.startsWith(PATH_PREFIX)) {
      try { return decodeURIComponent(raw.slice(PATH_PREFIX.length)); } catch (_) { return raw.slice(PATH_PREFIX.length); }
    }
    return raw;
  };

  const splitPath = (path) => {
    const raw = String(path || '/');
    const q = raw.indexOf('?');
    if (q < 0) return { pathname: raw, search: '' };
    return { pathname: raw.slice(0, q), search: raw.slice(q + 1) };
  };

  const queryOf = (search) => {
    const params = {};
    const src = String(search || '').replace(/^\?/, '');
    if (!src) return params;
    src.split('&').forEach((part) => {
      if (!part) return;
      const i = part.indexOf('=');
      const key = decodeURIComponent(i < 0 ? part : part.slice(0, i));
      const val = decodeURIComponent(i < 0 ? '' : part.slice(i + 1));
      params[key] = val;
    });
    return params;
  };

  const projection = (row) => ({
    path: pathFor(row.id),
    sessionId: row.id,
    title: row.title || null,
    firstMessage: row.title || '',
    modified: new Date(row.updated_at || Date.now()).toISOString(),
    created: new Date(row.updated_at || Date.now()).toISOString(),
    messageCount: row.messages || 0,
    cwd: null,
    agentId: ASSISTANT_ID,
    agentName: ASSISTANT_NAME,
    modelId: api.DEFAULT_MODEL,
    modelProvider: api.DEFAULT_PROVIDER,
    pinnedAt: null,
    live: row.live !== false,
    busy: !!row.busy,
  });

  const sessionIdOf = (body, query) => {
    const fromBody = body && (body.sessionId || body.path || body.sessionPath);
    const fromQuery = query && (query.sessionId || query.path);
    return idFrom(fromBody || fromQuery);
  };

  const historyMessage = (m, index) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = m.text || '';
    const row = {
      id: String(index),
      role,
      content: text,
      timestamp: Date.now(),
    };
    if (role === 'assistant' && m.reasoning) row.thinking = m.reasoning;
    return row;
  };

  // Soft stubs for openhanako surfaces that are not part of the Studio agent
  // vertical slice. Returning empty/ok stops noisy 404s in the harness and
  // iframe console without pretending the feature exists.
  const stubHttp = (pathname, verb) => {
    if (pathname === '/api/preferences/models' && verb === 'GET') {
      return {
        models: [{ id: api.DEFAULT_MODEL, name: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER }],
        current: api.DEFAULT_MODEL,
      };
    }
    if (pathname === '/api/session-thinking-level' && (verb === 'GET' || verb === 'POST')) {
      return { level: 'off' };
    }
    if (pathname === '/api/user-profile' && verb === 'GET') {
      return { name: 'User', avatar: null };
    }
    if (pathname === '/api/desk/cron' && verb === 'GET') {
      return { jobs: [] };
    }
    if (pathname === '/api/agents/primary' && verb === 'GET') {
      return { id: ASSISTANT_ID, name: ASSISTANT_NAME };
    }
    if (pathname === '/api/agents/switch' && verb === 'POST') {
      return { ok: true, agentId: ASSISTANT_ID };
    }
    if (pathname === '/api/providers/fetch-models' && verb === 'POST') {
      return { models: [{ id: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER }] };
    }
    if (pathname === '/api/models/auxiliary-vision' && verb === 'GET') {
      return { available: false };
    }
    if (pathname === '/api/upload-blob' && verb === 'POST') {
      return { ok: false, error: 'studio bridge: upload not supported' };
    }
    if (pathname.startsWith('/api/bridge')) {
      return { ok: true, studioBridge: api.mode() };
    }
    if (pathname === '/api/sessions/archived' && verb === 'GET') return [];
    if (pathname === '/api/sessions/archive' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/archived/delete' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/cleanup' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/continue-deleted-agent' && verb === 'POST') return { ok: false };
    if (pathname === '/api/sessions/fresh-compact' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/pin' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/pin-order' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/rename' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/restore' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/todos/complete' && verb === 'POST') return { ok: true };
    return null;
  };

  const ensureLive = async (sessionId) => {
    const rows = await api.sessions();
    const row = rows.find((s) => s.id === sessionId);
    if (row && row.live === false) {
      const resumed = await api.resume(sessionId);
      return resumed || sessionId;
    }
    return sessionId;
  };

  const http = async (method, path, body) => {
    const parts = splitPath(path);
    const pathname = parts.pathname;
    const query = queryOf(parts.search);
    const verb = String(method || 'GET').toUpperCase();

    if (pathname === '/api/health' && verb === 'GET') {
      return {
        status: 'ok',
        version: 'studio-bridge',
        agentId: ASSISTANT_ID,
        agent: ASSISTANT_NAME,
        agentYuan: 'hanako',
        user: 'User',
        model: api.DEFAULT_MODEL,
        avatars: { agent: false, user: false },
        sessionStore: null,
        studioBridge: api.mode(),
      };
    }

    if (pathname === '/api/config' && verb === 'GET') {
      return {
        locale: 'zh-CN',
        editor: null,
        studioBridge: api.mode(),
        providers: { mock: { models: [{ id: api.DEFAULT_MODEL, name: api.DEFAULT_MODEL }] } },
      };
    }

    if (pathname === '/api/server/identity' && verb === 'GET') {
      return {
        connectionKind: 'local',
        serverId: 'local',
        studioId: 'local',
        label: 'Studio',
        userLabel: 'User',
        studioLabel: 'Studio',
        version: 'studio-bridge',
        authState: 'paired',
        trustState: 'local',
        credentialKind: 'loopback_token',
        serverProtocol: 1,
      };
    }

    if (pathname === '/api/models' && verb === 'GET') {
      return {
        models: [{
          id: api.DEFAULT_MODEL,
          name: api.DEFAULT_MODEL,
          provider: api.DEFAULT_PROVIDER,
          isCurrent: true,
        }],
        current: api.DEFAULT_MODEL,
        activeModel: { id: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER },
      };
    }

    if (pathname === '/api/ws-ticket' && verb === 'POST') {
      return { ticket: 'studio-bridge', expiresAt: Date.now() + 600000 };
    }

    if (pathname === '/api/preferences/session-permission-default' && verb === 'GET') {
      return { permissionMode: 'ask' };
    }

    if (pathname === '/api/agents' && verb === 'GET') {
      return {
        agents: [{
          id: ASSISTANT_ID,
          name: ASSISTANT_NAME,
          yuan: 'hanako',
          isPrimary: true,
          hasAvatar: false,
        }],
      };
    }

    if (/^\/api\/agents\/[^/]+\/config$/.test(pathname) && verb === 'GET') {
      return { chat: {}, memory: { enabled: true } };
    }

    if (pathname === '/api/sessions' && verb === 'GET') {
      const rows = await api.sessions();
      return rows.map(projection);
    }

    if ((pathname === '/api/sessions/new' || pathname === '/api/sessions/new-detached') && verb === 'POST') {
      const id = await api.create(api.DEFAULT_PROVIDER, api.DEFAULT_MODEL);
      return {
        ok: true,
        path: pathFor(id),
        sessionId: id,
        agentId: ASSISTANT_ID,
        agentName: ASSISTANT_NAME,
        cwd: null,
        workspaceFolders: [],
      };
    }

    if (pathname === '/api/sessions/switch' && verb === 'POST') {
      const sessionId = sessionIdOf(body, query);
      if (!sessionId) return { error: 'missing session' };
      const liveId = await ensureLive(sessionId);
      return {
        ok: true,
        path: pathFor(liveId),
        sessionId: liveId,
        agentId: ASSISTANT_ID,
        agentName: ASSISTANT_NAME,
        isStreaming: false,
        memoryEnabled: true,
        workspaceFolders: [],
        cwd: null,
        permissionMode: 'ask',
        currentModelId: api.DEFAULT_MODEL,
        currentModelName: api.DEFAULT_MODEL,
        currentModelProvider: api.DEFAULT_PROVIDER,
      };
    }

    if (pathname === '/api/sessions/messages' && verb === 'GET') {
      if (query.before) {
        return { messages: [], blocks: [], todos: [], sessionFiles: [], hasMore: false, revision: null };
      }
      const sessionId = sessionIdOf(null, query);
      if (!sessionId) return { messages: [], blocks: [], todos: [], sessionFiles: [], hasMore: false };
      const liveId = await ensureLive(sessionId);
      const rows = await api.transcript(liveId);
      return {
        messages: rows.map(historyMessage),
        blocks: [],
        todos: [],
        sessionFiles: [],
        hasMore: false,
        revision: 'studio-' + liveId,
      };
    }

    const stub = stubHttp(pathname, verb);
    if (stub !== null) return stub;

    return { error: 'studio bridge: unhandled ' + verb + ' ' + pathname };
  };

  const ws = async (message, emit) => {
    const msg = message || {};
    const type = msg.type;
    const sessionId = idFrom(msg.sessionId || msg.sessionPath);
    const sessionPath = msg.sessionPath || (sessionId ? pathFor(sessionId) : '');
    const collected = [];
    const push = (event) => {
      collected.push(event);
      if (typeof emit === 'function') emit(event);
    };

    if (type === 'context_usage' || type === 'resume_stream' || type === 'stream_resume') {
      return { events: [], streamed: true };
    }

    if (type === 'abort') {
      if (sessionId) {
        try { await api.cancel(sessionId); } catch (err) {
          push({
            type: 'error',
            sessionId,
            sessionPath,
            message: err && err.message ? err.message : String(err),
          });
          return { events: collected, streamed: typeof emit === 'function' };
        }
      }
      push({ type: 'turn_end', sessionId, sessionPath });
      push({ type: 'status', sessionId, sessionPath, isStreaming: false });
      return { events: collected, streamed: typeof emit === 'function' };
    }

    if (type === 'prompt' || type === 'interject') {
      if (!sessionId) {
        push({ type: 'error', message: 'missing sessionId', code: 'session_identity_unresolved' });
        return { events: collected, streamed: typeof emit === 'function' };
      }
      const text = typeof msg.text === 'string' ? msg.text : '';
      const shown = msg.displayMessage && typeof msg.displayMessage.text === 'string'
        ? msg.displayMessage.text
        : text;
      const clientMessageId = typeof msg.clientMessageId === 'string' ? msg.clientMessageId : '';
      const liveId = await ensureLive(sessionId);
      const livePath = msg.sessionPath || pathFor(liveId);
      const msgId = clientMessageId || ('ohk-' + Date.now());

      push({ type: 'status', sessionId: liveId, sessionPath: livePath, isStreaming: true });
      push({
        type: 'session_user_message',
        sessionId: liveId,
        sessionPath: livePath,
        clientMessageId: clientMessageId || null,
        message: {
          id: clientMessageId || ('user-' + Date.now()),
          clientMessageId: clientMessageId || null,
          text: shown || '',
          timestamp: Date.now(),
        },
      });

      try {
        if (type === 'interject') {
          await api.steer(liveId, text, msgId);
          // Steer is fire-and-forget at a step boundary; surface a short ack.
          push({ type: 'text_delta', sessionId: liveId, sessionPath: livePath, delta: '' });
        } else {
          await api.sendWithProgress(liveId, text, msgId, (progress) => {
            const kind = progress && progress.kind;
            if (kind === 'thinking_start') {
              push({ type: 'thinking_start', sessionId: liveId, sessionPath: livePath });
            } else if (kind === 'thinking_delta') {
              push({
                type: 'thinking_delta',
                sessionId: liveId,
                sessionPath: livePath,
                delta: progress.delta || '',
              });
            } else if (kind === 'thinking_end') {
              push({ type: 'thinking_end', sessionId: liveId, sessionPath: livePath });
            } else if (kind === 'text_delta') {
              push({
                type: 'text_delta',
                sessionId: liveId,
                sessionPath: livePath,
                delta: progress.delta || '',
              });
            }
          });
        }
      } catch (err) {
        push({
          type: 'error',
          sessionId: liveId,
          sessionPath: livePath,
          message: err && err.message ? err.message : String(err),
        });
        push({ type: 'status', sessionId: liveId, sessionPath: livePath, isStreaming: false });
        return { events: collected, streamed: typeof emit === 'function' };
      }

      push({ type: 'turn_end', sessionId: liveId, sessionPath: livePath });
      push({ type: 'status', sessionId: liveId, sessionPath: livePath, isStreaming: false });
      return { events: collected, streamed: typeof emit === 'function' };
    }

    return { events: [], streamed: true };
  };

  const handle = (req, emit) => {
    const data = req || {};
    if (data.op === 'ws') return ws(data.message || {}, emit);
    const path = data.path || '/';
    const search = data.search ? String(data.search).replace(/^\?/, '') : '';
    const full = search ? (path + (path.indexOf('?') >= 0 ? '&' : '?') + search) : path;
    return http(data.method, full, data.body);
  };

  return {
    handle,
    http,
    ws,
    pathFor,
    idFrom,
    ASSISTANT_ID,
    PATH_PREFIX,
  };
})();
