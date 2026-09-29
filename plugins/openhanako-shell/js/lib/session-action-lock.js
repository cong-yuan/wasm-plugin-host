return (function () {
  function create() {
    const pending = new Set();

    const run = async (key, task) => {
      const token = String(key || '');
      if (!token || pending.has(token)) return { skipped: true, value: undefined };
      pending.add(token);
      try {
        return { skipped: false, value: await task() };
      } finally {
        pending.delete(token);
      }
    };

    return {
      run,
      isPending: (key) => pending.has(String(key || '')),
      size: () => pending.size,
    };
  }

  return { create };
})();