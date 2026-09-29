return (function () {
  const normalizeRows = (rows) => (rows || []).map((row) => ({
    ...row,
    id: row.sessionId || row.id,
  }));

  const sortRows = (rows, archived) => normalizeRows(rows).sort((a, b) => {
    if (archived) return String(b.archivedAt || '').localeCompare(String(a.archivedAt || ''));
    const ap = !!a.pinnedAt;
    const bp = !!b.pinnedAt;
    if (ap !== bp) return ap ? -1 : 1;
    if (ap && bp) {
      const ao = Number.isFinite(a.pinOrder) ? a.pinOrder : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b.pinOrder) ? b.pinOrder : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
    }
    return String(b.modified || b.updated_at || '').localeCompare(String(a.modified || a.updated_at || ''));
  });

  const localFilter = (rows, query) => {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) return rows.slice();
    return rows.filter((row) =>
      `${row.title || ''} ${row.sessionId || row.id || ''}`.toLocaleLowerCase().includes(needle));
  };

  const mergeResults = (titleData, contentData) => {
    const merged = new Map();
    for (const result of [...(titleData?.results || []), ...(contentData?.results || [])]) {
      const id = result.sessionId || result.id;
      if (!id) continue;
      const existing = merged.get(id);
      merged.set(id, {
        ...(existing || result),
        ...result,
        id,
        title: result.title || existing?.title || null,
        searchSnippet: result.matchKind === 'content' && result.snippet
          ? result.snippet
          : existing?.searchSnippet || '',
        searchMatchKind: result.matchKind || existing?.searchMatchKind || null,
      });
    }
    return Array.from(merged.values());
  };

  const highlightParts = (text, query) => {
    const value = String(text || '');
    const needle = String(query || '').trim();
    if (!needle) return { before: value, match: '', after: '' };
    const at = value.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
    if (at < 0) return { before: value, match: '', after: '' };
    return {
      before: value.slice(0, at),
      match: value.slice(at, at + needle.length),
      after: value.slice(at + needle.length),
    };
  };

  return { normalizeRows, sortRows, localFilter, mergeResults, highlightParts };
})();