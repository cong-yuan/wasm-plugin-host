return (function () {
  const signature = (runtime) => (runtime?.sessions || [])
    .map((state) => [
      state.sessionId,
      state.status || '',
      state.isStreaming ? 1 : 0,
      Number(state.activeToolCount) || 0,
      state.error || '',
    ].join(':'))
    .sort()
    .join('|');

  const summarize = (runtime) => {
    const rows = Array.from(runtime?.sessions || []);
    const errors = rows.filter((state) => state.status === 'error').length;
    const running = rows.filter((state) => state.status === 'running' || state.isStreaming).length;
    if (errors) return { text: `${errors} error${errors === 1 ? '' : 's'}`, state: 'error' };
    if (running) return { text: `${running} running`, state: 'running' };
    return { text: runtime?.mode === 'mock' ? 'Mock' : 'Connected', state: 'connected' };
  };

  return { signature, summarize };
})();