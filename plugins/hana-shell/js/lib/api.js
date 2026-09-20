// Backend access. A plugin window loads the app, so Tauri's IPC is present; if
// it is not, every call degrades instead of throwing, and the shell still draws.
//
// The shape of every call follows `src-tauri/src/commands.rs` in the studio —
// argument names are the Rust parameter names (Tauri maps them camelCase →
// snake_case), so a mismatch fails at invoke time, not at load.
return (function () {
  const invoke = (cmd, args) => {
    const i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return i.invoke(cmd, args || {});
    const g = window.__TAURI__;
    if (g && g.core && typeof g.core.invoke === 'function') return g.core.invoke(cmd, args || {});
    return Promise.reject(new Error('no Tauri IPC in this window'));
  };
  // A failed call returns `null`, never a rejection: the shell has to keep
  // drawing when the backend is absent (a plain browser, a plugin window during
  // boot), and a rejected promise in a render path becomes an unhandled one.
  const safe = async (cmd, args) => {
    try { return await invoke(cmd, args); } catch (e) { return null; }
  };

  /** Whether we can reach the backend at all — checked before promising data. */
  const available = () => {
    const i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return true;
    const g = window.__TAURI__;
    return !!(g && g.core && typeof g.core.invoke === 'function');
  };

  return {
    raw: invoke,
    available,

    status: () => safe('studio_status'),
    agents: () => safe('list_agents').then((r) => r || []),
    plugins: () => safe('list_plugins').then((r) => r || []),
    tools: () => safe('list_tools').then((r) => r || []),
    services: () => safe('list_services').then((r) => r || []),

    /**
     * The registered LLM route names, `mock` included.
     *
     * Read from `studio_status` rather than assumed, so a configured provider
     * is actually reachable instead of the chat silently defaulting to `mock`.
     */
    providers: () => safe('studio_status').then((s) => (s && s.providers) || []),

    /**
     * Pick a provider to create an agent with.
     *
     * Prefers anything that is not `mock`, because `mock` echoes the input —
     * it is a test double, not a model, and a user who configured a real
     * endpoint means to use it. Falls back to `mock`, then to null when the
     * backend reports nothing at all.
     */
    pickProvider: async () => {
      const list = await safe('studio_status').then((s) => (s && s.providers) || []);
      if (!list.length) return null;
      return list.find((p) => p !== 'mock') || list[0];
    },

    // `create_agent` takes `id` (not `agentId`) and returns the id as a string.
    createAgent: (provider, model, id) =>
      safe('create_agent', { provider, model, cwd: null, id: id || null }),
    send: (agentId, text, msgId) => safe('send_message', { agentId, text, msgId }),
    // `ChatMessage` carries `text`, `reasoning`, `tool_calls`, `tool_results`.
    transcript: (agentId) => safe('transcript', { agentId }).then((r) => r || []),
    cancel: (agentId) => safe('cancel_agent', { agentId }),
    dispose: (agentId) => safe('dispose_agent', { agentId }),

    /** Plugins, with their windows and slots — used by the rail's status card. */
    windows: () => safe('plugin_windows').then((r) => r || []),
  };
})();
