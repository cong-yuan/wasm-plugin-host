// Backend access. A plugin window loads the app, so Tauri's IPC is present; if
// it is not, every call degrades instead of throwing, and the shell still draws.
return (function () {
  const invoke = (cmd, args) => {
    const i = window.__TAURI_INTERNALS__;
    if (i && typeof i.invoke === 'function') return i.invoke(cmd, args || {});
    const g = window.__TAURI__;
    if (g && g.core && typeof g.core.invoke === 'function') return g.core.invoke(cmd, args || {});
    return Promise.reject(new Error('no Tauri IPC in this window'));
  };
  const safe = async (cmd, args) => {
    try { return await invoke(cmd, args); } catch (e) { return null; }
  };
  return {
    raw: invoke,
    status: () => safe('studio_status'),
    agents: () => safe('list_agents').then((r) => r || []),
    plugins: () => safe('list_plugins').then((r) => r || []),
    tools: () => safe('list_tools').then((r) => r || []),
    services: () => safe('list_services').then((r) => r || []),
    // `create_agent` takes `id` (not `agentId`) and returns the id as a string.
    createAgent: (provider, model, id) =>
      safe('create_agent', { provider, model, cwd: null, id: id || null }),
    send: (agentId, text, msgId) => safe('send_message', { agentId, text, msgId }),
    // `ChatMessage` carries `text`.
    transcript: (agentId) => safe('transcript', { agentId }).then((r) => r || []),
    cancel: (agentId) => safe('cancel_agent', { agentId }),
  };
})();
