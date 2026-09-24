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
    updated_at: row && Number.isFinite(Number(row.updated_at ?? row.updatedAt))
      ? Number(row.updated_at ?? row.updatedAt)
      : null,
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
    softUnbind: async (agentId) => {
      // Mock keeps the transcript fixture.
      const row = sessions.find((s) => s.id === agentId);
      if (row) row.live = true;
      return null;
    },
    rebind: async (agentId, provider, model) => {
      const row = sessions.find((s) => s.id === agentId);
      if (row) {
        row.live = true;
        row.provider = provider;
        row.model = model;
      }
      return agentId;
    },
    listModels: () => ([{
      id: DEFAULT_MODEL,
      name: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
    }]),

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

  // Longest prefix of `segment` that is already a suffix of `haystack`.
  // Used so current-step absolute snapshots (Studio live_assistant_partial)
  // can grow in place without re-appending the whole segment.
  const suffixPrefixOverlap = (haystack, segment) => {
    const src = String(haystack || '');
    const seg = String(segment || '');
    if (!seg) return 0;
    let k = Math.min(src.length, seg.length);
    while (k > 0 && !src.endsWith(seg.slice(0, k))) k -= 1;
    return k;
  };

  // Diff assistant growth against the previous snapshot and emit progress.
  // `next.text` may be either cumulative or the current step segment
  // (Studio live_assistant_partial). Never append a snapshot that is already
  // present as a prefix/suffix of state — that is the listen↔poll stutter.
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
      if (state.reasoning.startsWith(reasoning)) {
        // Stale shorter reasoning snapshot — ignore.
      } else {
        const overlap = suffixPrefixOverlap(state.reasoning, reasoning);
        if (overlap === reasoning.length) {
          // already applied
        } else if (overlap > 0) {
          if (!state.thinking) {
            onProgress({ kind: 'thinking_start' });
            state.thinking = true;
          }
          const d = reasoning.slice(overlap);
          onProgress({ kind: 'thinking_delta', delta: d });
          state.reasoning = state.reasoning + d;
        } else {
          if (!state.thinking) {
            onProgress({ kind: 'thinking_start' });
            state.thinking = true;
          }
          onProgress({ kind: 'thinking_delta', delta: reasoning });
          state.reasoning = state.reasoning + reasoning;
        }
      }
    }
    if (!text || text === state.text) {
      // no text change
    } else if (text.startsWith(state.text)) {
      if (state.thinking) {
        onProgress({ kind: 'thinking_end' });
        state.thinking = false;
      }
      const d = text.slice(state.text.length);
      if (d) onProgress({ kind: 'text_delta', delta: d });
      state.text = text;
    } else if (state.text.startsWith(text)) {
      // Stale shorter absolute snapshot — ignore.
    } else {
      const overlap = suffixPrefixOverlap(state.text, text);
      if (overlap === text.length) {
        // Segment already fully applied (listen↔poll race).
      } else if (overlap > 0) {
        // Current step segment grew: append only the new suffix.
        if (state.thinking) {
          onProgress({ kind: 'thinking_end' });
          state.thinking = false;
        }
        const d = text.slice(overlap);
        onProgress({ kind: 'text_delta', delta: d });
        state.text = state.text + d;
      } else {
        // New assistant segment (e.g. next step after tools): append once.
        if (state.thinking) {
          onProgress({ kind: 'thinking_end' });
          state.thinking = false;
        }
        onProgress({ kind: 'text_delta', delta: text });
        state.text = state.text + text;
      }
    }
  };

  // Push payloads carry both a current-step snapshot and the exact growth for
  // that step. Delta owns live output when present: content-based de-dup across
  // steps is invalid because adjacent model messages may overlap or be equal.
  // Absolute snapshots remain a fallback for hosts without event delivery.
  const applyPartial = (partial, onProgress, state, agentId) => {
    if (!partial || partial.agentId !== agentId) return;
    if (typeof onProgress !== 'function') return;

    const absText = typeof partial.text === 'string' ? partial.text : null;
    const absReasoning = typeof partial.reasoning === 'string' ? partial.reasoning : null;
    const textDelta = typeof partial.textDelta === 'string' ? partial.textDelta : null;
    const reasoningDelta = typeof partial.reasoningDelta === 'string' ? partial.reasoningDelta : null;

    if (reasoningDelta !== null) {
      if (reasoningDelta) {
        if (!state.thinking) {
          onProgress({ kind: 'thinking_start' });
          state.thinking = true;
        }
        onProgress({ kind: 'thinking_delta', delta: reasoningDelta });
        state.reasoning += reasoningDelta;
      }
    } else if (absReasoning !== null) {
      emitDiff(null, { text: state.text, reasoning: absReasoning }, onProgress, state);
    }

    if (textDelta !== null) {
      if (!textDelta) return;
      if (state.thinking) {
        onProgress({ kind: 'thinking_end' });
        state.thinking = false;
      }
      onProgress({ kind: 'text_delta', delta: textDelta });
      state.text += textDelta;
    } else if (absText !== null) {
      emitDiff(null, { text: absText, reasoning: state.reasoning }, onProgress, state);
    }
  };

  // ── Tool call propagation ──
  // Studio's transcript carries `tool_calls` (raw JSON `arguments`) plus
  // `tool_results`, but the live stream only ever pushed text/reasoning. The UI
  // renders tool cards, the todo list and file/reference cards from tool events,
  // so diff the transcript across polls and emit one start/end per call.
  const parseToolArgs = (raw) => {
    if (raw == null) return undefined;
    if (typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch (_) {
      return undefined;
    }
  };

  const toolCallId = (value) => {
    if (!value || typeof value !== 'object') return '';
    const id = value.id ?? value.call_id ?? value.tool_call_id ?? value.toolCallId;
    return id == null ? '' : String(id);
  };

  const toolTimestamp = (value, snakeKey, camelKey) => {
    if (!value || typeof value !== 'object') return undefined;
    const timestamp = value[snakeKey] ?? value[camelKey];
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
  };

  // Studio/provider results may be strings, JSON objects, or multipart text.
  // Keep a plain-text rendering for users and a structured copy for cards.
  const toolResultText = (content) => {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        try { return JSON.stringify(part); } catch (_) { return String(part); }
      }).filter(Boolean).join('\n');
    }
    try { return JSON.stringify(content, null, 2); } catch (_) { return String(content); }
  };

  const parseToolDetails = (content) => {
    if (content == null) return undefined;
    if (typeof content === 'object' && !Array.isArray(content)) return content;
    const trimmed = toolResultText(content).trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch (_) {
      return undefined;
    }
  };

  // Todo tools carry the authoritative list in their CALL ARGUMENTS; Studio's
  // tool result is only text ("todo list updated (N items)"), and dsh emits
  // `todo/write` as a session event the transcript never surfaces. The Hana UI
  // reads `details.todos` on `tool_end`, so synthesise it from the args and
  // normalise to that shape (`activeForm` is required by the frontend gate).
  const TODO_TOOL_NAMES = new Set(['todo', 'todo_write']);
  const todoDetailsFromArgs = (name, args) => {
    if (!TODO_TOOL_NAMES.has(name)) return undefined;
    const list = args && Array.isArray(args.todos) ? args.todos : null;
    if (!list) return undefined;
    const todos = list.map((entry) => {
      const content = entry && typeof entry.content === 'string' ? entry.content : '';
      const activeForm = entry && typeof entry.activeForm === 'string' && entry.activeForm
        ? entry.activeForm
        : content;
      const status = entry && (entry.status === 'in_progress' || entry.status === 'completed')
        ? entry.status
        : 'pending';
      return { content, activeForm, status };
    }).filter((t) => t.content);
    return { todos };
  };

  const emitToolProgress = (rows, baseline, state, onProgress) => {
    if (typeof onProgress !== 'function') return;
    if (!state.tools) state.tools = new Map();
    const slice = rows.slice(baseline);
    const results = new Map();
    for (const m of slice) {
      const trs = (m && m.tool_results) || [];
      for (const tr of trs) {
        const id = toolCallId(tr);
        if (id) results.set(id, tr);
      }
    }
    for (let rowIndex = 0; rowIndex < slice.length; rowIndex += 1) {
      const m = slice[rowIndex];
      if (!m || m.role !== 'assistant') continue;
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      tcs.forEach((tc, index) => {
        if (!tc || !tc.name) return;
        // Studio always supplies `call_id`; the synthetic key is defensive and
        // scoped to the absolute row so id-less calls never collide across
        // messages when the same tool name repeats.
        const callId = toolCallId(tc);
        const id = callId || `row${baseline + rowIndex}:${index}:${tc.name}`;
        let entry = state.tools.get(id);
        if (!entry) {
          const args = parseToolArgs(tc.arguments);
          const startedAt = toolTimestamp(tc, 'started_at', 'startedAt') ?? Date.now();
          entry = { name: tc.name, done: false, args, startedAt };
          state.tools.set(id, entry);
          onProgress({ kind: 'tool_start', id, name: tc.name, args, startedAt });
        }
        if (entry.done) return;
        const res = callId ? results.get(callId) : null;
        if (!res) return;
        entry.done = true;
        const finishedAt = toolTimestamp(res, 'finished_at', 'finishedAt') ?? Date.now();
        const isError = res.is_error === true || res.isError === true;
        const output = toolResultText(res.content ?? res.output);
        const resultDetails = (res.details && typeof res.details === 'object' ? res.details : undefined)
          || parseToolDetails(res.content ?? res.output);
        const todoDetails = isError ? undefined : todoDetailsFromArgs(tc.name, entry.args);
        const details = todoDetails
          ? {
              ...(resultDetails && !Array.isArray(resultDetails) ? resultDetails : {}),
              ...todoDetails,
            }
          : resultDetails;
        onProgress({
          kind: 'tool_end',
          id,
          name: tc.name,
          success: !isError,
          startedAt: entry.startedAt,
          finishedAt,
          output: output || undefined,
          error: isError ? output : undefined,
          details,
        });
      });
    }
  };

  const sendWithProgress = async (agentId, text, msgId, onProgress) => {
    if (!tauri.available()) return mock.sendStreaming(agentId, text, msgId, onProgress);

    const before = await readTranscript(agentId);
    const beforeCount = before.length;
    const state = { text: '', reasoning: '', thinking: false, tools: new Map() };
    let stopped = false;

    // Primary path: Studio push (assistant/chunk → studio://chat-partial).
    let unlisten = null;
    let listenOk = false;
    try {
      unlisten = await tauri.listen('studio://chat-partial', (partial) => {
        applyPartial(partial, onProgress, state, agentId);
      });
      listenOk = typeof unlisten === 'function';
    } catch (_) {
      unlisten = null;
      listenOk = false;
    }

    // Live chunk poll — only when event.listen is unavailable. Running it
    // alongside studio://chat-partial double-applies the same growth
    // (absolute snapshot vs textDelta race → stuttered / duplicated text).
    const pollLivePartial = async () => {
      try {
        const partial = await tauri.invoke('chat_partial', { agentId });
        if (!partial || typeof partial !== 'object') return;
        applyPartial({
          agentId,
          text: typeof partial.text === 'string' ? partial.text : '',
          reasoning: typeof partial.reasoning === 'string' ? partial.reasoning : '',
        }, onProgress, state, agentId);
      } catch (_) { /* command missing on older Studio */ }
    };

    const pollOnce = async () => {
      if (!listenOk) await pollLivePartial();
      const rows = await readTranscript(agentId);
      // ONLY consider assistants appended after this turn started.
      // Falling back to lastAssistant(rows) re-seeds the new bubble with A1
      // (previous turn), then prefix-slices A2 against A1 → A1+A2 glue /
      // mid-message corruption like 「要干活直接说。件（`write_file`）」.
      if (rows.length <= beforeCount) return;
      // Transcript owns tool lifecycle in both modes. With push available it
      // must not also emit text: that would apply one model step twice.
      emitToolProgress(rows, beforeCount, state, onProgress);
      if (listenOk) return;
      const assistant = lastAssistant(rows.slice(beforeCount));
      if (assistant) emitDiff(null, assistant, onProgress, state);
    };

    if (!listenOk) {
      try { console.warn('[openhanako] tauri.listen unavailable; using chat_partial poll'); } catch (_) {}
    }

    const sendPromise = tauri.invoke('send_message', {
      agentId,
      text,
      msgId: msgId || ('ohk-' + Date.now()),
    });

    // Event push (if listen works) + chat_partial/transcript poll fallback.
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
      try { if (unlisten) unlisten(); } catch (_) {}
      await loop.catch(() => {});
      try { await pollOnce(); } catch (_) {}
      // Final transcript is authoritative and includes every completed
      // assistant step. Only append a missing suffix; never overlap-merge
      // distinct steps or replay content already emitted by push deltas.
      try {
        const rows = await readTranscript(agentId);
        const completed = rows.slice(beforeCount).filter((row) => row && row.role === 'assistant');
        // Preserve empty text slots. Each assistant row before a tool group owns
        // one slot; dropping an empty value makes a lost pre-tool delta
        // indistinguishable from a genuinely absent segment in the renderer.
        const segments = completed.map((row) => row.text || '');
        const finalText = segments.join('');
        const finalReasoning = completed.map((row) => row.reasoning || '').join('');
        // Deltas can be dropped by WebView/event delivery. Snapshot replaces
        // provisional text, so never emit a suffix after it: doing both can
        // overwrite the reconciled final segment in the renderer.
        onProgress({ kind: 'assistant_snapshot', segments });
        state.text = finalText;
        if (finalReasoning.startsWith(state.reasoning) && finalReasoning.length > state.reasoning.length) {
          if (!state.thinking) {
            onProgress({ kind: 'thinking_start' });
            state.thinking = true;
          }
          onProgress({ kind: 'thinking_delta', delta: finalReasoning.slice(state.reasoning.length) });
          state.reasoning = finalReasoning;
        }
      } catch (_) { /* final transcript can race persistence */ }
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
      let chosenProvider = provider || '';
      let chosenModel = model || '';
      if ((!chosenProvider || !chosenModel) && tauri.available()) {
        try {
          const llm = await tauri.invoke('get_llm_config');
          const current = llm && llm.current && typeof llm.current === 'object' ? llm.current : {};
          const fallbackProvider = (typeof llm.default === 'string' && llm.default)
            || chosenProvider
            || DEFAULT_PROVIDER;
          if (!chosenProvider) {
            chosenProvider = (typeof current.provider === 'string' && current.provider)
              || fallbackProvider;
          }
          if (!chosenModel) {
            chosenModel = (typeof current.model === 'string' && current.model)
              || (llm.providers && llm.providers[chosenProvider] && llm.providers[chosenProvider].model)
              || (chosenProvider === DEFAULT_PROVIDER ? DEFAULT_MODEL : chosenProvider);
          }
        } catch (_) { /* keep defaults below */ }
      }
      if (!chosenProvider) chosenProvider = DEFAULT_PROVIDER;
      if (!chosenModel) {
        chosenModel = chosenProvider === DEFAULT_PROVIDER ? DEFAULT_MODEL : chosenProvider;
      }
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

    
    softUnbind: async (agentId) => {
      if (!tauri.available()) return mock.softUnbind(agentId);
      return tauri.invoke('soft_unbind_agent', { agentId });
    },

    // Soft-unbind + recreate same id with new provider/model; keeps jsonl.
    rebind: async (agentId, provider, model) => {
      if (!tauri.available()) return mock.rebind(agentId, provider, model);
      return asId(await tauri.invoke('rebind_agent_model', {
        agentId,
        provider,
        model,
      }));
    },

    listModels: async () => {
      if (!tauri.available()) return mock.listModels();
      try {
        const rows = await tauri.invoke('list_models');
        if (Array.isArray(rows) && rows.length) {
          return rows.map((m) => ({
            id: String(m.id || ''),
            name: String(m.name || m.id || ''),
            provider: String(m.provider || ''),
          })).filter((m) => m.id && m.provider);
        }
      } catch (_) { /* older Studio builds omit list_models */ }
      try {
        const llm = await tauri.invoke('get_llm_config');
        const lists = (llm && llm.model_lists) || {};
        const out = [];
        Object.keys(lists).forEach((prov) => {
          const arr = Array.isArray(lists[prov]) ? lists[prov] : [];
          arr.forEach((id) => {
            const mid = typeof id === 'string' ? id : (id && id.id);
            if (mid) out.push({ id: String(mid), name: String(mid), provider: String(prov) });
          });
        });
        if (out.length) return out;
      } catch (_) {}
      return mock.listModels();
    },

    getLlmConfig: async () => {
      if (!tauri.available()) {
        return {
          providers: { mock: { model: DEFAULT_MODEL } },
          model_lists: { mock: [DEFAULT_MODEL] },
          current: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
          default: DEFAULT_PROVIDER,
          registered: [DEFAULT_PROVIDER],
        };
      }
      return tauri.invoke('get_llm_config');
    },

    setLlmConfig: async (patch) => {
      if (!tauri.available()) {
        return { ok: false, error: 'tauri unavailable' };
      }
      return tauri.invoke('set_llm_config', { patch: patch || {} });
    },

    fetchLlmModels: async (opts) => {
      const o = opts || {};
      if (!tauri.available()) return { models: [] };
      return tauri.invoke('fetch_llm_models', {
        provider: o.provider || null,
        base_url: o.baseUrl || o.base_url || null,
        api_key: o.apiKey || o.api_key || null,
      });
    },

    syncLlmAdapters: async () => {
      if (!tauri.available()) return [];
      return tauri.invoke('sync_llm_adapters');
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
