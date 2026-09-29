return (function () {
  function create(options) {
    const adapter = options.adapter;
    const ttlMs = Number(options.ttlMs) || 15000;
    const maxEntries = Number(options.maxEntries) || 20;
    const cache = new Map();

    const clear = () => cache.clear();

    const cached = (query) => {
      const key = String(query || '').trim().toLocaleLowerCase();
      if (!key) return null;
      const hit = cache.get(key);
      if (!hit || Date.now() - hit.at >= ttlMs) {
        if (hit) cache.delete(key);
        return null;
      }
      return hit.rows.map((row) => ({ ...row }));
    };

    const search = async (query) => {
      const raw = String(query || '').trim();
      if (!raw) return { rows: [], cached: false };
      const hit = cached(raw);
      if (hit) return { rows: hit, cached: true };

      const encoded = encodeURIComponent(raw);
      const [titleData, contentData] = await Promise.all([
        adapter.http('GET', `/api/sessions/search?q=${encoded}&phase=title&limit=20`),
        adapter.http('GET', `/api/sessions/search?q=${encoded}&phase=content&limit=20`),
      ]);
      const searchUtil = studio.require('lib/session-search');
      const rows = searchUtil.mergeResults(titleData, contentData);
      const key = raw.toLocaleLowerCase();
      cache.set(key, { at: Date.now(), rows: rows.map((row) => ({ ...row })) });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return { rows, cached: false };
    };

    return { search, clear, cached, size: () => cache.size };
  }

  return { create };
})();