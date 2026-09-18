// Thin wrappers over the backend commands this shell drives.
//
// It talks to the backend the same way the host UI does — through Tauri's IPC —
// because a plugin window loads the app, so the real `invoke` is available. If
// it ever is not (a bare `html` window, say), every call degrades instead of
// throwing, so the shell still renders.
return (function () {
  const invoke = (cmd, args) => {
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
      return internals.invoke(cmd, args || {});
    }
    const g = window.__TAURI__;
    if (g && g.core && typeof g.core.invoke === 'function') {
      return g.core.invoke(cmd, args || {});
    }
    return Promise.reject(new Error('no Tauri IPC in this window'));
  };

  /** Call a command, returning `null` instead of throwing. */
  const safe = async (cmd, args) => {
    try { return await invoke(cmd, args); } catch (e) { console.warn('[qoder-shell]', cmd, e); return null; }
  };

  return {
    raw: invoke,
    status: () => safe('studio_status'),
    agents: () => safe('list_agents').then((r) => r || []),
    plugins: () => safe('list_plugins').then((r) => r || []),
    tools: () => safe('list_tools').then((r) => r || []),
    services: () => safe('list_services').then((r) => r || []),
    logs: () => safe('get_logs').then((r) => r || []),
    // Tauri maps camelCase keys onto Rust's snake_case parameters, so `agentId`
    // reaches `agent_id`. (Verified against the host UI's own api.ts.)
    transcript: (id) => safe('transcript', { agentId: id }).then((r) => r || []),
    // `create_agent` takes `id` (NOT `agentId`) and returns the agent id as a
    // bare string — a mismatch here is invisible except as "nothing happens".
    createAgent: (provider, model, cwd, id) =>
      safe('create_agent', { provider, model, cwd: cwd || null, id: id || null }),
    send: (agentId, text, msgId) => safe('send_message', { agentId, text, msgId }),
    cancel: (agentId) => safe('cancel_agent', { agentId }),
  };
})();
