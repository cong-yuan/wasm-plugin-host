return (function () {
  function create({ adapter, api }) {
    const ensureOk = (result, fallback) => {
      if (!result || result.ok === false || result.error) {
        throw new Error(result?.error || fallback);
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
        'Delete failed',
      ),
      setPinned: async (session, pinned) => ensureOk(
        await adapter.http('POST', '/api/sessions/pin', { sessionId: session.id, pinned: !!pinned }),
        'Pin update failed',
      ),
      reorderPinned: async (sessionIds) => ensureOk(
        await adapter.http('POST', '/api/sessions/pin-order', { sessionIds }),
        'Pinned order update failed',
      ),
      archive: async (session) => ensureOk(
        await adapter.http('POST', '/api/sessions/archive', { sessionId: session.id }),
        'Archive failed',
      ),
      rename: async (session, title) => ensureOk(
        await adapter.http('POST', '/api/sessions/rename', {
          sessionId: session.id,
          path: session.path,
          title,
        }),
        'Rename failed',
      ),
      stop: async (session) => api.cancel(session.id),
    };
  }

  return { create };
})();