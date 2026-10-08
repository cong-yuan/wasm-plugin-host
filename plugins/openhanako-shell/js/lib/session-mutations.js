return (function () {
  function create({ adapter, api }) {
    const ensureOk = (result, fallback, expectedSessionId = null) => {
      if (!result || result.ok !== true || result.error) {
        throw new Error(result?.error || fallback);
      }
      if (expectedSessionId && result.sessionId != null && result.sessionId !== expectedSessionId) {
        throw new Error(`${fallback}: response session mismatch`);
      }
      return result;
    };

    return {
      restore: async (session) => ensureOk(
        await adapter.http('POST', '/api/sessions/restore', { sessionId: session.id, path: session.path }),
        'Restore failed',
      ),
      deleteArchived: async (session) => ensureOk(
        await adapter.http('POST', '/api/sessions/archived/delete', { sessionId: session.id, path: session.path }),
        'Delete failed', session.id,
      ),
      setPinned: async (session, pinned) => ensureOk(
        await adapter.http('POST', '/api/sessions/pin', { sessionId: session.id, pinned: !!pinned }),
        'Pin update failed', session.id,
      ),
      reorderPinned: async (sessionIds) => ensureOk(
        await adapter.http('POST', '/api/sessions/pin-order', { sessionIds }),
        'Pinned order update failed',
      ),
      archive: async (session) => ensureOk(
        await adapter.http('POST', '/api/sessions/archive', { sessionId: session.id }),
        'Archive failed', session.id,
      ),
      rename: async (session, title) => ensureOk(
        await adapter.http('POST', '/api/sessions/rename', {
          sessionId: session.id,
          path: session.path,
          title,
        }),
        'Rename failed', session.id,
      ),
      stop: async (session) => api.cancel(session.id),
    };
  }

  return { create };
})();