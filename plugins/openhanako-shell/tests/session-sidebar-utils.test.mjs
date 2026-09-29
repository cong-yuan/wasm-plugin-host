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
const row = load('session-row.js');
const actionLock = load('session-action-lock.js');
const mutationSource = readFileSync(join(ROOT, 'js/lib/session-mutations.js'), 'utf8');
const searchControllerSource = readFileSync(join(ROOT, 'js/lib/session-search-controller.js'), 'utf8');
const searchController = new Function('studio', searchControllerSource)({
  require(name) {
    if (name === 'lib/session-search') return search;
    throw new Error(`unexpected dependency: ${name}`);
  },
});

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
  let active = 0;
  let maxActive = 0;
  const concurrent = await bulk.runBatch(['1', '2', '3', '4', '5'], async (id) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, id === '2' ? 4 : 1));
    active -= 1;
    return id === '4' ? { ok: false } : { ok: true };
  }, 3);
  check('batch runner uses bounded concurrency', maxActive === 3);
  check('batch runner preserves failure order under concurrency',
    concurrent.completed === 4 && concurrent.failed.join(',') === '4');
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

{
  const session = { id: 'a', messageCount: 2, modelId: 'gpt-x', modelProvider: 'openai' };
  const state = { sessionId: 'a', status: 'running', isStreaming: true, activeToolCount: 3 };
  const derived = row.deriveRuntime(session, state, false);
  check('row runtime derives running and tool state',
    derived.running === true && derived.error === false && derived.toolCount === 3);
  check('row metadata summarizes runtime and message count',
    row.metaText(session, derived, false) === 'Running · 2 messages · gpt-x');
  const details = row.detailEntries(session, state, derived, false);
  check('row details include model and tool count',
    details.some(([label, value]) => label === 'Model' && value === 'openai/gpt-x')
    && details.some(([label, value]) => label === 'Tools' && value === '3'));
  check('row keyboard navigation stays within visible bounds',
    row.nextKeyboardId(['a', 'b'], 'a', 'ArrowDown') === 'b'
    && row.nextKeyboardId(['a', 'b'], 'a', 'ArrowUp') === 'a');
}

{
  let calls = 0;
  const controller = searchController.create({
    adapter: {
      async http(_method, path) {
        calls += 1;
        if (path.includes('phase=title')) {
          return { results: [{ sessionId: 'x', title: 'Example', matchKind: 'title' }] };
        }
        return { results: [{ sessionId: 'x', title: 'Example', matchKind: 'content', snippet: 'hello world' }] };
      },
    },
    ttlMs: 10000,
    maxEntries: 2,
  });
  const first = await controller.search('Example');
  const second = await controller.search('example');
  check('search controller merges remote phases', first.rows[0]?.searchSnippet === 'hello world');
  check('search controller reuses case-insensitive cache', calls === 2 && second.cached === true);
  controller.clear();
  check('search controller clear drops cache', controller.size() === 0);
}

{
  let activeLoads = 0;
  let maxLoads = 0;
  const rows = Array.from({ length: 6 }, (_value, index) => ({ id: `s-${index}`, title: `S${index}` }));
  const contentMatches = await search.searchContentRows(
    rows,
    'needle',
    async (session) => {
      activeLoads += 1;
      maxLoads = Math.max(maxLoads, activeLoads);
      await new Promise((resolve) => setTimeout(resolve, session.id === 's-1' ? 4 : 1));
      activeLoads -= 1;
      return session.id === 's-4' || session.id === 's-1'
        ? [{ text: `contains needle in ${session.id}` }]
        : [{ text: 'nothing' }];
    },
    (session) => ({ sessionId: session.id, title: session.title }),
    1,
    3,
  );
  check('content search uses bounded transcript concurrency', maxLoads === 3);
  check('content search preserves source ordering before limit',
    contentMatches.length === 1 && contentMatches[0].sessionId === 's-1');
}

{
  const lock = actionLock.create();
  let entered = 0;
  let release;
  const first = lock.run('bulk:archive', async () => {
    entered += 1;
    await new Promise((resolve) => { release = resolve; });
    return 'done';
  });
  const duplicate = await lock.run('bulk:archive', async () => {
    entered += 1;
    return 'duplicate';
  });
  check('action lock skips duplicate mutation while pending',
    duplicate.skipped === true && entered === 1 && lock.isPending('bulk:archive'));
  release();
  const finished = await first;
  check('action lock releases after completion',
    finished.value === 'done' && !lock.isPending('bulk:archive') && lock.size() === 0);
}

{
  const calls = [];
  const mutations = new Function('studio', mutationSource)({
    require() { throw new Error('unexpected dependency'); },
  }).create({
    adapter: {
      async http(method, path, body) {
        calls.push({ method, path, body });
        if (path === '/api/sessions/archive') return { ok: false, error: 'archive denied' };
        return { ok: true, sessionId: body?.sessionId || null };
      },
    },
    api: { cancel: async (id) => calls.push({ cancel: id }) },
  });
  const session = { id: 's1', path: 'studio://s1' };
  await mutations.setPinned(session, true);
  await mutations.rename(session, 'Renamed');
  await mutations.stop(session);
  check('session mutations normalize adapter calls',
    calls.some((c) => c.path === '/api/sessions/pin' && c.body.pinned === true)
    && calls.some((c) => c.path === '/api/sessions/rename' && c.body.title === 'Renamed')
    && calls.some((c) => c.cancel === 's1'));
  let archiveError = null;
  try { await mutations.archive(session); } catch (err) { archiveError = err; }
  check('session mutations normalize failed responses into errors',
    archiveError?.message === 'archive denied');
}

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('session sidebar utils: ok');
