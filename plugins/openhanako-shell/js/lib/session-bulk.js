return (function () {
  const toggleVisible = (selectedIds, visibleIds) => {
    const next = new Set(selectedIds || []);
    const visible = Array.from(visibleIds || []);
    const allSelected = visible.length > 0 && visible.every((id) => next.has(id));
    visible.forEach((id) => {
      if (allSelected) next.delete(id);
      else next.add(id);
    });
    return next;
  };

  const pruneSelection = (selectedIds, availableIds) => {
    const available = new Set(availableIds || []);
    return new Set(Array.from(selectedIds || []).filter((id) => available.has(id)));
  };

  const runBatch = async (ids, request, concurrency = 4, options = {}) => {
    const source = Array.from(ids || []);
    const width = Math.max(1, Math.min(source.length || 1, Number(concurrency) || 1));
    const outcomes = new Array(source.length).fill(false);
    let cursor = 0;

    const worker = async () => {
      while (cursor < source.length) {
        const index = cursor;
        cursor += 1;
        const sessionId = source[index];
        try {
          const result = await request(sessionId);
          // Mutation responses must explicitly acknowledge success and identify the
          // same target when a session ID is present. A HTTP 200 or {} is not ACK.
          const acknowledged = result?.ok === true && !result.error;
          const targetMatches = options.allowRemappedSessionId === true
            || result?.sessionId == null || result.sessionId === sessionId;
          outcomes[index] = acknowledged && targetMatches;
        } catch {
          outcomes[index] = false;
        }
      }
    };

    await Promise.all(Array.from({ length: width }, () => worker()));
    const failed = source.filter((_id, index) => !outcomes[index]);
    return { completed: source.length - failed.length, failed };
  };

  return { toggleVisible, pruneSelection, runBatch };
})();