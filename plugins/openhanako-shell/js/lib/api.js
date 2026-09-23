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
//
// Studio's `send_message` awaits the whole turn (`when_idle`). While it runs,
// Studio emits `studio://chat-partial` from live `assistant/chunk` assembly.
// `sendWithProgress` listens for those events (and polls transcript as a
// coarse fallback) so the UI updates on each push without waiting for idle.
return (function () {
  const tauri = studio.require('lib/tauri-invoke');

  // Studio chat page uses this pair for offline demos.
  const DEFAULT_PROVIDER = 'mock';
  const DEFAULT_MODEL = 'mock-1';
  const POLL_MS = 40;

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

  const lastAssistant = (rows) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i] && rows[i].role === 'assistant') return rows[i];
    }
    return null;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // Chunked mock turn so unit tests can assert incremental deltas.
    sendStreaming: async (agentId, text, msgId, onProgress) => {
      if (!transcripts[agentId]) transcripts[agentId] = [];
      transcripts[agentId].push({ role: 'user', text, reasoning: '', tool_calls: [], tool_results: [] });
      const reply = '（mock fallback）已收到，但当前窗口没有 Tauri invoke，没有调用 send_message。';
      const reasoning = 'mock-think';
      const assistant = {
        role: 'assistant',
        text: '',
        reasoning: '',
        tool_calls: [],
        tool_results: [],
      };
      transcripts[agentId].push(assistant);
      const row = sessionsStore.find((s) => s.id === agentId);
      if (row) {
        row.busy = true;
        row.status = 'running';
        row.updated_at = Date.now();
      }
      if (typeof onProgress === 'function') {
        onProgress({ kind: 'thinking_start' });
        for (const piece of ['mock-', 'think']) {
          await sleep(5);
          assistant.reasoning += piece;
          onProgress({ kind: 'thinking_delta', delta: piece });
        }
        onProgress({ kind: 'thinking_end' });
        for (const piece of chunkText(reply, 24)) {
          await sleep(5);
          assistant.text += piece;
          onProgress({ kind: 'text_delta', delta: piece });
        }
      } else {
        assistant.reasoning = reasoning;
        assistant.text = reply;
      }
      if (row) {
        row.busy = false;
        row.status = 'idle';
        row.messages = transcripts[agentId].length;
        row.turns += 1;
        row.updated_at = Date.now();
        if (!row.title || row.title === 'New session') row.title = String(text || '').slice(0, 48);
      }
      return true;
    },
    cancel: async () => null,
    steer: async (agentId, text, msgId) => mock.send(agentId, text, msgId || 'steer'),
    dispose: async (agentId) => {
      const i = sessionsStore.findIndex((s) => s.id === agentId);
      if (i >= 0) sessionsStore.splice(i, 1);
      delete transcripts[agentId];
      return null;
    },
    pickProvider: async () => DEFAULT_PROVIDER,
  };

  const chunkText = (text, size) => {
    const out = [];
    const src = String(text || '');
    if (!src) return out;
    for (let i = 0; i < src.length; i += size) out.push(src.slice(i, i + size));
    return out;
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

  const readTranscript = async (agentId) => {
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
  };

  // Diff assistant growth against the previous snapshot and emit progress.
  const emitDiff = (prev, next, onProgress, state) => {
    if (typeof onProgress !== 'function') return;
    const reasoning = (next && next.reasoning) || '';
    const text = (next && next.text) || '';
    if (reasoning.length > state.reasoning.length && reasoning.startsWith(state.reasoning)) {
      if (!state.thinking) {
        onProgress({ kind: 'thinking_start' });
        state.thinking = true;
      }
      onProgress({ kind: 'thinking_delta', delta: reasoning.slice(state.reasoning.length) });
      state.reasoning = reasoning;
    } else if (reasoning && reasoning !== state.reasoning && !reasoning.startsWith(state.reasoning)) {
      if (!state.thinking) {
        onProgress({ kind: 'thinking_start' });
        state.thinking = true;
      }
      onProgress({ kind: 'thinking_delta', delta: reasoning });
      state.reasoning = state.reasoning + reasoning;
    }
    if (text.length > state.text.length && text.startsWith(state.text)) {
      if (state.thinking) {
        onProgress({ kind: 'thinking_end' });
        state.thinking = false;
      }
      onProgress({ kind: 'text_delta', delta: text.slice(state.text.length) });
      state.text = text;
    } else if (text && text !== state.text && !text.startsWith(state.text)) {
      // New assistant segment (e.g. next step after tools): append.
      if (state.thinking) {
        onProgress({ kind: 'thinking_end' });
        state.thinking = false;
      }
      onProgress({ kind: 'text_delta', delta: text });
      state.text = state.text + text;
    }
  };

  // Apply a studio://chat-partial payload. Prefer explicit *Delta fields from
  // Studio (already computed against its last emit) when present.
  const applyPartial = (partial, onProgress, state, agentId) => {
    if (!partial || partial.agentId !== agentId) return;
    if (typeof onProgress !== 'function') return;
    const textDelta = typeof partial.textDelta === 'string' ? partial.textDelta : null;
    const reasoningDelta = typeof partial.reasoningDelta === 'string' ? partial.reasoningDelta : null;
    if (reasoningDelta) {
      if (!state.thinking) {
        onProgress({ kind: 'thinking_start' });
        state.thinking = true;
      }
      onProgress({ kind: 'thinking_delta', delta: reasoningDelta });
      state.reasoning = (typeof partial.reasoning === 'string')
        ? partial.reasoning
        : (state.reasoning + reasoningDelta);
    }
    if (textDelta) {
      if (state.thinking) {
        onProgress({ kind: 'thinking_end' });
        state.thinking = false;
      }
      onProgress({ kind: 'text_delta', delta: textDelta });
      state.text = (typeof partial.text === 'string' && partial.text.startsWith(state.text))
        ? partial.text
        : (state.text + textDelta);
      return;
    }
    // No deltas — sync from absolute fields (older Studio builds).
    emitDiff(null, {
      text: typeof partial.text === 'string' ? partial.text : '',
      reasoning: typeof partial.reasoning === 'string' ? partial.reasoning : '',
    }, onProgress, state);
  };

  const sendWithProgress = async (agentId, text, msgId, onProgress) => {
    if (!tauri.available()) return mock.sendStreaming(agentId, text, msgId, onProgress);

    const before = await readTranscript(agentId);
    const beforeCount = before.length;
    const state = { text: '', reasoning: '', thinking: false };
    let stopped = false;

    // Primary path: Studio push (assistant/chunk → studio://chat-partial).
    let unlisten = () => {};
    try {
      unlisten = await tauri.listen('studio://chat-partial', (partial) => {
        applyPartial(partial, onProgress, state, agentId);
      });
    } catch (_) {
      unlisten = () => {};
    }

    const pollOnce = async () => {
      const rows = await readTranscript(agentId);
      // ONLY consider assistants appended after this turn started.
      // Falling back to lastAssistant(rows) re-seeds the new bubble with A1
      // (previous turn), then prefix-slices A2 against A1 → A1+A2 glue /
      // mid-message corruption like 「要干活直接说。件（`write_file`）」.
      if (rows.length <= beforeCount) return;
      const assistant = lastAssistant(rows.slice(beforeCount));
      if (!assistant) return;
      emitDiff(null, assistant, onProgress, state);
    };

    const sendPromise = tauri.invoke('send_message', {
      agentId,
      text,
      msgId: msgId || ('ohk-' + Date.now()),
    });

    // Coarse fallback if listen is unavailable or an emit is missed.
    // After Studio chunk assembly lands, transcript still only grows on
    // completed assistant/message — so listen is what makes mid-token UI work.
    const loop = (async () => {
      while (!stopped) {
        try { await pollOnce(); } catch (_) { /* mid-turn read can race */ }
        await sleep(POLL_MS);
      }
    })();

    try {
      await sendPromise;
    } finally {
      stopped = true;
      try { unlisten(); } catch (_) {}
      await loop.catch(() => {});
      try { await pollOnce(); } catch (_) {}
      if (state.thinking && typeof onProgress === 'function') {
        onProgress({ kind: 'thinking_end' });
        state.thinking = false;
      }
    }
    return true;
  };

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

    transcript: async (agentId) => readTranscript(agentId),

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

    // Blocking whole-turn send (legacy). Prefer sendWithProgress for chat UI.
    send: async (agentId, text, msgId) => {
      if (!tauri.available()) return mock.send(agentId, text, msgId);
      await tauri.invoke('send_message', {
        agentId,
        text,
        msgId: msgId || ('ohk-' + Date.now()),
      });
      return true;
    },

    sendWithProgress,

    cancel: async (agentId) => {
      if (!tauri.available()) return mock.cancel(agentId);
      return tauri.invoke('cancel_agent', { agentId });
    },

    // Studio's steer_agent requires msgId (same as send_message).
    steer: async (agentId, text, msgId) => {
      if (!tauri.available()) return mock.steer(agentId, text, msgId);
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
