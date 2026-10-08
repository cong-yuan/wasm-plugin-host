return (function () {
  const deriveRuntime = (session, state, archived) => {
    const running = !archived && !!(session?.busy || state?.isStreaming || state?.status === 'running');
    const error = !archived && (state?.status === 'error' || !!state?.error);
    const toolCount = Number(state?.activeToolCount) || 0;
    return { running, error, toolCount };
  };

  const metaText = (session, runtime, archived) => {
    const parts = [];
    if (archived) parts.push('Archived');
    else if (runtime.running) parts.push('Running');
    else if (runtime.error) parts.push('Error');
    else parts.push('Idle');
    const messageCount = Number(session?.messageCount ?? session?.messages);
    if (Number.isFinite(messageCount) && messageCount > 0) {
      parts.push(`${messageCount} message${messageCount === 1 ? '' : 's'}`);
    }
    if (session?.modelId) parts.push(String(session.modelId));
    return parts.join(' · ');
  };

  const detailEntries = (session, state, runtime, archived) => ([
    ['Session', session.id],
    ['Path', session.path || `studio://${session.id}`],
    ['Model', session.modelId ? `${session.modelProvider || ''}/${session.modelId}`.replace(/^\//, '') : null],
    ['Runtime', runtime.running ? 'running' : runtime.error ? 'error' : archived ? 'archived' : 'idle'],
    ['Tools', runtime.toolCount > 0 ? String(runtime.toolCount) : null],
    ['Error', state?.error || session.error || null],
  ].filter((entry) => entry[1]));

  const nextKeyboardId = (visibleIds, currentId, key) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return null;
    const visible = Array.from(visibleIds || []);
    const index = visible.indexOf(currentId);
    if (index < 0 || visible.length === 0) return null;
    const target = key === 'Home' ? 0 : key === 'End' ? visible.length - 1
      : Math.max(0, Math.min(visible.length - 1, index + (key === 'ArrowDown' ? 1 : -1)));
    return visible[target] || null;
  };

  return { deriveRuntime, metaText, detailEntries, nextKeyboardId };
})();