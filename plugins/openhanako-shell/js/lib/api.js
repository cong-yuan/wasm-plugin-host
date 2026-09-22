// Frontend-only fixtures. Intentionally does NOT call Tauri / studio backend.
return (function () {
  const sessionsStore = [
    { id: 'sess-welcome', title: 'Welcome', busy: false, updated_at: Date.now() },
    { id: 'sess-sketch', title: 'Page design sketch', busy: false, updated_at: Date.now() - 3600e3 },
  ];
  const transcripts = {
    'sess-welcome': [
      { role: 'assistant', text: '这是 openhanako-shell 的前端页面设计稿。会话与发送目前是本地 fixture，尚未接后端。' },
    ],
    'sess-sketch': [],
  };

  const ok = (v) => Promise.resolve(v);

  return {
    status: () =>
      ok({
        providers: ['mock'],
        model: 'mock',
        offline: true,
        note: 'openhanako-shell: backend stubbed',
      }),
    sessions: () => ok(sessionsStore.map((s) => ({ ...s }))),
    plugins: () =>
      ok([{ id: 'openhanako-shell', name: 'openhanako-shell', state: 'active', tool_count: 0 }]),
    tools: () =>
      ok([
        { name: 'read_file', description: 'stub' },
        { name: 'write_file', description: 'stub' },
      ]),
    transcript: (agentId) => ok((transcripts[agentId] || []).slice()),
    resume: (sessionId) => ok(sessionsStore.find((s) => s.id === sessionId) || null),
    create: async (_provider, _model) => {
      const id = 'sess-' + Math.random().toString(36).slice(2, 8);
      sessionsStore.unshift({
        id,
        title: 'New session',
        busy: false,
        updated_at: Date.now(),
      });
      transcripts[id] = [];
      return id;
    },
    send: async (agentId, text, _msgId) => {
      if (!transcripts[agentId]) transcripts[agentId] = [];
      transcripts[agentId].push({ role: 'user', text });
      transcripts[agentId].push({
        role: 'assistant',
        text: '（stub）已收到，但尚未接入真实 agent / LLM。',
      });
      return true;
    },
    cancel: () => ok(null),
    pickProvider: () => ok('mock'),
  };
})();
