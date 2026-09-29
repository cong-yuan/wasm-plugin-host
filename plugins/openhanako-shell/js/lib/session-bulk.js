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

  const runBatch = async (ids, request) => {
    let completed = 0;
    const failed = [];
    for (const sessionId of ids || []) {
      try {
        const result = await request(sessionId);
        if (!result || result.ok === false || result.error) failed.push(sessionId);
        else completed += 1;
      } catch {
        failed.push(sessionId);
      }
    }
    return { completed, failed };
  };

  return { toggleVisible, pruneSelection, runBatch };
})();