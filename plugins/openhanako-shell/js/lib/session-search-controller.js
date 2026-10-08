return (function () {
  function create(options) {
    const adapter = options.adapter;
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 15000;
    const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 20;
    const cache = new Map();
    const inflight = new Map();
    let generation = 0;

    const copyRows = (rows) => rows.map((row) => ({ ...row }));
    const clear = () => {
      generation += 1;
      cache.clear();
      inflight.clear();
    };

    const cached = (query) => {
      const key = String(query || '').trim().toLocaleLowerCase();
      if (!key) return null;
      const hit = cache.get(key);
      if (!hit || Date.now() - hit.at >= ttlMs) {
        if (hit) cache.delete(key);
        return null;
      }
      // Refresh recency so frequently used searches survive eviction.
      cache.delete(key);
      cache.set(key, hit);
      return copyRows(hit.rows);
    };

    const search = async (query) => {
      const raw = String(query || '').trim();
      if (!raw) return { rows: [], cached: false };
      const hit = cached(raw);
      if (hit) return { rows: hit, cached: true };

      const key = raw.toLocaleLowerCase();
      // Concurrent identical searches share transport work, but never share mutable rows.
      if (inflight.has(key)) {
        const rows = await inflight.get(key);
        return { rows: copyRows(rows), cached: false };
      }
      const requestGeneration = generation;
      const request = (async () => {
        const encoded = encodeURIComponent(raw);
        const [titleData, contentData] = await Promise.all([
          adapter.http('GET', `/api/sessions/search?q=${encoded}&phase=title&limit=20`),
          adapter.http('GET', `/api/sessions/search?q=${encoded}&phase=content&limit=20`),
        ]);
        // An HTTP error response is not a valid empty search result.
        for (const data of [titleData, contentData]) {
          if (!data || data.ok === false || !Array.isArray(data.results)) {
            throw new Error('Invalid session search response');
          }
        }
        const searchUtil = studio.require('lib/session-search');
        const rows = searchUtil.mergeResults(titleData, contentData);
        if (generation === requestGeneration) {
          cache.delete(key);
          cache.set(key, { at: Date.now(), rows: copyRows(rows) });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return rows;
      })();
      inflight.set(key, request);
      try {
        return { rows: copyRows(await request), cached: false };
      } finally {
        if (inflight.get(key) === request) inflight.delete(key);
      }
    };

    return { search, clear, cached, size: () => cache.size };
  }

  return { create };
})();