// Studio agent backend.
//
// When Tauri IPC is present this calls the same commands as Studio's Svelte
// chat page. When it is not (plain browser, unit tests) every method falls
// back to an in-memory fixture. That fallback is labeled `mode() === 'mock'`
// and is not used once invoke exists — a failed command rejects instead of
// silently inventing a session.
//
// Default provider/model match Studio's offline demo (`mock` / `mock-1`).
// Callers may pass another pair; nothing here reads the user's settings.
return (function () {
  const tauri = studio.require('lib/tauri-invoke');

  // Studio chat page uses this pair for offline demos.
  const DEFAULT_PROVIDER = 'mock';
  const DEFAULT_MODEL = 'mock-1';

  const sessionsStore = [
    { id: 'sess-welcome', title: 'Welcome', busy: false, live: true, status: 'idle', messages: 1, turns: 1, usage: null, updated_at: Date.now() },
    { id: 'sess-sketch', title: 'Page design sketch', busy: false, live: true, status: 'idle', messages: 0, turns: 0, usage: null, updated_at: Date.now() - 3600e3 },
  ];
  const transcripts = {
    'sess-welcome': [
      { role: 'assistant', text: '这是 openhanako-shell 的 mock fallback（当前窗口没有 Tauri invoke）。会话与发送都还在本地 fixture 里。', reasoning: '', tool_calls: [], tool_results: [] },
    ],
    'sess-sketch': [],
  };

  const normalize = (row) => ({
    id: row && row.id != null ? String(row.id) : '',
    title: (row && row.title) || '',
    busy: !!(row && row.busy),
    live: !row || row.live !== false,
    status: (row && row.status) || '',
    messages: (row && row.messages) || 0,
    turns: (row && row.turns) || 0,
    usage: (row && row.usage) || null,
    updated_at: Date.now(),
  });

  const asId = (value) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object' && value.id != null) return String(value.id);
    return String(value);
  };

  const mock = {
    status: () => ({
      providers: [DEFAULT_PROVIDER],
      model: DEFAULT_MODEL,
      offline: true,
      note: 'openhanako-shell: mock fallback (Tauri invoke unavailable)',
    }),
    sessions: () => sessionsStore.map((s) => ({ ...s })),
    plugins: () => [{ id: 'openhanako-shell', name: 'openhanako-shell', state: 'active', tool_count: 0 }],
    tools: () => [
      { name: 'read_file', description: 'mock fallback' },
      { name: 'write_file', description: 'mock fallback' },
    ],
    transcript: (agentId) => (transcripts[agentId] || []).map((m) => ({ ...m })),
    resume: (sessionId) => {
      const row = sessionsStore.find((s) => s.id === sessionId);
      if (row) row.live = true;
      return row ? row.id : sessionId;
    },
    create: async (_provider, _model) => {
      const id = 'sess-' + Math.random().toString(36).slice(2, 8);
      sessionsStore.unshift({
        id,
        title: 'New session',
        busy: false,
        live: true,
        status: 'idle',
        messages: 0,
        turns: 0,
        usage: null,
        updated_at: Date.now(),
      });
      transcripts[id] = [];
      return id;
    },
    send: async (agentId, text, _msgId) => {
      if (!transcripts[agentId]) transcripts[agentId] = [];
      transcripts[agentId].push({ role: 'user', text, reasoning: '', tool_calls: [], tool_results: [] });
      transcripts[agentId].push({
        role: 'assistant',
        text: '（mock fallback）已收到，但当前窗口没有 Tauri invoke，没有调用 send_message。',
        reasoning: '',
        tool_calls: [],
        tool_results: [],
      });
      const row = sessionsStore.find((s) => s.id === agentId);
      if (row) {
        row.messages = transcripts[agentId].length;
        row.turns += 1;
        row.updated_at = Date.now();
        if (!row.title || row.title === 'New session') row.title = String(text || '').slice(0, 48);
      }
      return true;
    },
    cancel: async () => null,
    steer: async (agentId, text) => mock.send(agentId, text, 'steer'),
    dispose: async (agentId) => {
      const i = sessionsStore.findIndex((s) => s.id === agentId);
      if (i >= 0) sessionsStore.splice(i, 1);
      delete transcripts[agentId];
      return null;
    },
    pickProvider: async () => DEFAULT_PROVIDER,
  };

  const liveSessions = async () => {
    let rows;
    try {
      rows = await tauri.invoke('list_sessions');
    } catch (err) {
      rows = null;
      try {
        rows = await tauri.invoke('list_agents');
      } catch (_) {
        throw err;
      }
    }
    if (!Array.isArray(rows)) rows = [];
    return rows.map(normalize).filter((row) => row.id);
  };

  const mode = () => (tauri.available() ? 'tauri' : 'mock');

  return {
    DEFAULT_PROVIDER,
    DEFAULT_MODEL,
    available: () => tauri.available(),
    mode,

    status: async () => {
      if (!tauri.available()) return mock.status();
      try {
        const s = await tauri.invoke('studio_status');
        if (s && typeof s === 'object') return s;
      } catch (_) { /* older hosts omit studio_status */ }
      return {
        providers: [DEFAULT_PROVIDER],
        model: DEFAULT_MODEL,
        offline: false,
        note: 'studio_status unavailable; create_agent still uses mock/mock-1 unless the caller passes another pair',
      };
    },

    sessions: () => (tauri.available() ? liveSessions() : Promise.resolve(mock.sessions())),

    plugins: async () => {
      if (!tauri.available()) return mock.plugins();
      try {
        const rows = await tauri.invoke('list_plugins');
        return Array.isArray(rows) ? rows : [];
      } catch (_) {
        return [];
      }
    },

    tools: async () => {
      if (!tauri.available()) return mock.tools();
      try {
        const rows = await tauri.invoke('list_tools');
        return Array.isArray(rows) ? rows : [];
      } catch (_) {
        return [];
      }
    },

    transcript: async (agentId) => {
      if (!tauri.available()) return mock.transcript(agentId);
      const rows = await tauri.invoke('transcript', { agentId });
      if (!Array.isArray(rows)) return [];
      return rows.map((m) => ({
        role: (m && m.role) || 'assistant',
        text: (m && m.text) || '',
        reasoning: (m && m.reasoning) || '',
        tool_calls: (m && m.tool_calls) || [],
        tool_results: (m && m.tool_results) || [],
      }));
    },

    resume: async (sessionId) => {
      if (!tauri.available()) return mock.resume(sessionId);
      return asId(await tauri.invoke('resume_session', { sessionId }));
    },

    // `create_agent` takes `id` (optional) and returns the id string.
    create: async (provider, model, id) => {
      const chosenProvider = provider || DEFAULT_PROVIDER;
      const chosenModel = model || (chosenProvider === DEFAULT_PROVIDER ? DEFAULT_MODEL : chosenProvider);
      if (!tauri.available()) return mock.create(chosenProvider, chosenModel);
      return asId(await tauri.invoke('create_agent', {
        provider: chosenProvider,
        model: chosenModel,
        cwd: null,
        id: id || null,
      }));
    },

    // `send_message` awaits the whole turn (no token stream). Void success is
    // not an error — only a rejected invoke fails the call.
    send: async (agentId, text, msgId) => {
      if (!tauri.available()) return mock.send(agentId, text, msgId);
      await tauri.invoke('send_message', {
        agentId,
        text,
        msgId: msgId || ('ohk-' + Date.now()),
      });
      return true;
    },

    cancel: async (agentId) => {
      if (!tauri.available()) return mock.cancel(agentId);
      return tauri.invoke('cancel_agent', { agentId });
    },

    // Argument names follow send_message (agentId/text/msgId).
    steer: async (agentId, text, msgId) => {
      if (!tauri.available()) return mock.steer(agentId, text);
      return tauri.invoke('steer_agent', {
        agentId,
        text,
        msgId: msgId || ('ohk-steer-' + Date.now()),
      });
    },

    dispose: async (agentId) => {
      if (!tauri.available()) return mock.dispose(agentId);
      return tauri.invoke('dispose_agent', { agentId });
    },

    pickProvider: async () => {
      if (!tauri.available()) return mock.pickProvider();
      try {
        const s = await tauri.invoke('studio_status');
        const list = (s && s.providers) || [];
        if (list.length) return list.find((p) => p !== 'mock') || list[0];
      } catch (_) { /* fall through to the offline demo pair */ }
      return DEFAULT_PROVIDER;
    },
  };
})();
