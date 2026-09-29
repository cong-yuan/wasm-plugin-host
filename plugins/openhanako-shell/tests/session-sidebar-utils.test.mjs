import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => new Function(
  'studio',
  readFileSync(join(ROOT, 'js/lib', name), 'utf8'),
)({ require() { throw new Error('unexpected dependency'); } });

const search = load('session-search.js');
const bulk = load('session-bulk.js');
const runtime = load('session-runtime.js');

const failures = [];
const check = (label, condition) => { if (!condition) failures.push(label); };

{
  const rows = search.sortRows([
    { sessionId: 'b', title: 'Beta', modified: '2026-01-01T00:00:00Z' },
    { sessionId: 'a', title: 'Alpha', pinnedAt: 'x', pinOrder: 2 },
    { sessionId: 'c', title: 'Gamma', pinnedAt: 'x', pinOrder: 1 },
  ], false);
  check('search sort keeps pinned sessions ordered first',
    rows.map((row) => row.id).join(',') === 'c,a,b');
  check('local search covers title and session id',
    search.localFilter(rows, 'bet').map((row) => row.id).join(',') === 'b'
    && search.localFilter(rows, 'a').some((row) => row.id === 'a'));

  const merged = search.mergeResults(
    { results: [{ sessionId: 'a', title: 'Alpha', matchKind: 'title', snippet: 'Alpha' }] },
    { results: [{ sessionId: 'a', title: 'Alpha', matchKind: 'content', snippet: 'message alpha' }] },
  );
  check('search merge preserves content snippet',
    merged.length === 1 && merged[0].searchSnippet === 'message alpha');
  const parts = search.highlightParts('Welcome home', 'come');
  check('highlight splits matching text',
    parts.before === 'Wel' && parts.match === 'come' && parts.after === ' home');
}

{
  let selected = bulk.toggleVisible(new Set(), ['a', 'b']);
  check('toggle visible selects visible ids', selected.has('a') && selected.has('b'));
  selected = bulk.toggleVisible(selected, ['a', 'b']);
  check('toggle visible clears fully selected visible ids', selected.size === 0);
  selected = bulk.pruneSelection(new Set(['a', 'gone']), ['a', 'b']);
  check('prune selection drops unavailable ids', selected.size === 1 && selected.has('a'));

  const result = await bulk.runBatch(['a', 'b', 'c'], async (id) => {
    if (id === 'b') return { ok: false, error: 'nope' };
    if (id === 'c') throw new Error('boom');
    return { ok: true };
  });
  check('batch runner records partial failures',
    result.completed === 1 && result.failed.join(',') === 'b,c');
}

{
  const one = { mode: 'live', sessions: [
    { sessionId: 'b', status: 'running', isStreaming: true, activeToolCount: 2 },
    { sessionId: 'a', status: 'idle' },
  ] };
  const reordered = { mode: 'live', sessions: [...one.sessions].reverse() };
  check('runtime signature is stable across session ordering',
    runtime.signature(one) === runtime.signature(reordered));
  check('runtime summary prioritizes running state',
    runtime.summarize(one).state === 'running' && runtime.summarize(one).text === '1 running');
  check('runtime summary prioritizes errors over running',
    runtime.summarize({ sessions: [...one.sessions, { sessionId: 'e', status: 'error' }] }).state === 'error');
}

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('session sidebar utils: ok');
