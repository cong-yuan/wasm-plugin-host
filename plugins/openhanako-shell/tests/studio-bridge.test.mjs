// Parent-side vertical slice: Tauri commands when invoke exists, mock
// fallback when it does not, iframe postMessage contract, and incremental
// streaming deltas (best-effort via transcript poll / mock chunks).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const messageHandlers = [];
global.window = {
  __TAURI_INTERNALS__: null,
  __TAURI__: null,
  addEventListener(type, fn) {
    if (type === 'message') messageHandlers.push(fn);
  },
  removeEventListener(type, fn) {
    if (type !== 'message') return;
    const i = messageHandlers.indexOf(fn);
    if (i >= 0) messageHandlers.splice(i, 1);
  },
};

const sources = new Map();
for (const name of [
  'lib/tauri-invoke.js',
  'lib/api.js',
  'lib/hana-adapter.js',
  'lib/host-bridge.js',
]) {
  sources.set(name.replace(/\.js$/, ''), readFileSync(join(ROOT, 'js', name), 'utf8'));
}
const cache = new Map();
const studio = {
  require(name) {
    const key = name.replace(/\.js$/, '');
    if (cache.has(key)) return cache.get(key);
    const src = sources.get(key);
    if (!src) throw new Error('module not found: ' + name);
    const value = new Function('studio', src)(studio);
    cache.set(key, value);
    return value;
  },
};

const failures = [];
const check = (label, cond) => { if (!cond) failures.push(label); };

const tauri = studio.require('lib/tauri-invoke');
const api = studio.require('lib/api');
const adapter = studio.require('lib/hana-adapter');
const host = studio.require('lib/host-bridge');

let invokeError = null;
try { await tauri.invoke('list_sessions'); } catch (err) { invokeError = err; }
check('invoke rejects with a clear error when Tauri is missing',
  invokeError && /Tauri invoke is not available/.test(invokeError.message));
check('api mode is mock without invoke', api.mode() === 'mock');

const health = await adapter.http('GET', '/api/health');
check('mock health is labeled', health.studioBridge === 'mock' && health.status === 'ok');
const listed = await adapter.http('GET', '/api/sessions');
check('mock sessions use studio:// paths',
  listed.length === 2 && listed[0].path === 'studio://sess-welcome' && listed[0].sessionId === 'sess-welcome');
check('mock sessions keep a stable assistant id', listed.every((s) => s.agentId === 'studio'));

const stubArchived = await adapter.http('GET', '/api/sessions/archived');
check('archived sessions stub returns array', Array.isArray(stubArchived));
const stubRename = await adapter.http('POST', '/api/sessions/rename', { sessionId: 'x', title: 'y' });
check('rename stub returns ok', stubRename && stubRename.ok === true);
const stubProfile = await adapter.http('GET', '/api/user-profile');
check('user-profile stub', stubProfile && stubProfile.name === 'User');

// Pin / unpin persists locally and is reflected in GET /api/sessions
{
  const target = listed[0].sessionId;
  const pinned = await adapter.http('POST', '/api/sessions/pin', {
    path: listed[0].path,
    sessionId: target,
    pinned: true,
  });
  check('pin returns pinnedAt', pinned && pinned.ok === true && typeof pinned.pinnedAt === 'string');
  check('pin returns pinOrder', pinned && Number.isFinite(pinned.pinOrder));
  const afterPin = await adapter.http('GET', '/api/sessions');
  const pinnedRow = afterPin.find((s) => s.sessionId === target);
  check('pinned session appears in list', pinnedRow && pinnedRow.pinnedAt === pinned.pinnedAt);
  const unpinned = await adapter.http('POST', '/api/sessions/pin', {
    path: listed[0].path,
    sessionId: target,
    pinned: false,
  });
  check('unpin clears pinnedAt', unpinned && unpinned.ok === true && unpinned.pinnedAt === null);
  const afterUnpin = await adapter.http('GET', '/api/sessions');
  const unpinnedRow = afterUnpin.find((s) => s.sessionId === target);
  check('unpinned session has no pinnedAt', unpinnedRow && unpinnedRow.pinnedAt == null);
}

// ---- mock incremental streaming ----
{
  const created = await adapter.http('POST', '/api/sessions/new-detached', {});
  const sid = created.sessionId;
  const pushed = [];
  const turn = await adapter.ws({
    type: 'prompt',
    text: 'stream please',
    sessionId: sid,
    sessionPath: 'studio://' + sid,
    clientMessageId: 'c-stream',
    displayMessage: { text: 'stream please' },
  }, (ev) => pushed.push(ev));

  check('mock prompt marks streamed', turn.streamed === true);
  check('mock prompt pushes status streaming true first',
    pushed[0] && pushed[0].type === 'status' && pushed[0].isStreaming === true);
  check('mock prompt pushes session_user_message early',
    pushed.some((e) => e.type === 'session_user_message'));

  const deltaIdx = [];
  pushed.forEach((e, i) => { if (e.type === 'text_delta' && e.delta) deltaIdx.push(i); });
  check('mock prompt emits multiple text_delta chunks', deltaIdx.length >= 2);
  const joined = pushed.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  check('mock text_delta chunks reassemble the reply',
    joined.includes('mock fallback') || joined.includes('没有调用'));
  check('mock thinking arrives before or with text',
    pushed.some((e) => e.type === 'thinking_delta'));
  check('mock turn ends with turn_end + status false',
    pushed.some((e) => e.type === 'turn_end')
    && pushed[pushed.length - 1].type === 'status'
    && pushed[pushed.length - 1].isStreaming === false);

  // Incremental: first text_delta must arrive before the final status.
  const firstDelta = pushed.findIndex((e) => e.type === 'text_delta' && e.delta);
  const lastStatus = pushed.length - 1;
  check('first text_delta arrives before final status (incremental)',
    firstDelta >= 0 && firstDelta < lastStatus);
}

const calls = [];
let liveTranscript = [
  { role: 'user', text: 'hi', reasoning: '', tool_calls: [], tool_results: [] },
  { role: 'assistant', text: 'pong', reasoning: 'because', tool_calls: [], tool_results: [] },
];
let sendResolve;
let sendStarted = null;
global.window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    calls.push({ cmd, args });
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'agent-1', title: 'Hello', busy: false, live: true, messages: 2, turns: 1, status: 'idle', usage: null },
        { id: 'agent-2', title: 'Cold', busy: false, live: false, messages: 1, turns: 1, status: 'idle', usage: null },
      ]);
    }
    if (cmd === 'list_agents') return Promise.resolve([]);
    if (cmd === 'create_agent') return Promise.resolve('agent-new');
    if (cmd === 'resume_session') return Promise.resolve(args.sessionId);
    if (cmd === 'send_message') {
      sendStarted = Date.now();
      // Grow transcript while the invoke is outstanding so poll can stream.
      liveTranscript = [
        ...liveTranscript,
        { role: 'user', text: args.text, reasoning: '', tool_calls: [], tool_results: [] },
        { role: 'assistant', text: '', reasoning: '', tool_calls: [], tool_results: [] },
      ];
      const asstIdx = liveTranscript.length - 1;
      return new Promise((resolve) => {
        sendResolve = resolve;
        const pieces = ['Hel', 'lo ', 'from ', 'Studio'];
        let i = 0;
        const step = () => {
          if (i < pieces.length) {
            liveTranscript[asstIdx].text += pieces[i];
            if (i === 0) liveTranscript[asstIdx].reasoning = 'r1';
            if (i === 1) liveTranscript[asstIdx].reasoning = 'r1r2';
            i += 1;
            setTimeout(step, 50);
          } else {
            setTimeout(() => resolve(undefined), 40);
          }
        };
        setTimeout(step, 10);
      });
    }
    if (cmd === 'steer_agent') return Promise.resolve(undefined);
    if (cmd === 'cancel_agent') return Promise.resolve(undefined);
    if (cmd === 'transcript') {
      return Promise.resolve(liveTranscript.map((m) => ({ ...m })));
    }
    return Promise.reject(new Error('unknown ' + cmd));
  },
};

check('api mode flips to tauri once invoke exists', api.mode() === 'tauri');
const live = await api.sessions();
check('sessions call list_sessions', calls.some((c) => c.cmd === 'list_sessions') && live[0].id === 'agent-1');
const projectedLive = await adapter.http('GET', '/api/sessions');
check('sessions without backend timestamps do not become just-now on every refresh',
  projectedLive.every((session) => session.modified == null && session.created == null));

const created = await adapter.http('POST', '/api/sessions/new-detached', {});
check('create_agent uses mock/mock-1',
  created.sessionId === 'agent-new'
  && created.path === 'studio://agent-new'
  && calls.some((c) => c.cmd === 'create_agent'
    && c.args.provider === 'mock' && c.args.model === 'mock-1'));

calls.length = 0;
const switched = await adapter.http('POST', '/api/sessions/switch', { path: 'studio://agent-2', sessionId: 'agent-2' });
check('cold session resumes without rebuilding its model driver',
  switched.sessionId === 'agent-2'
  && calls.some((c) => c.cmd === 'resume_session' && c.args.sessionId === 'agent-2')
  && !calls.some((c) => c.cmd === 'rebind_agent_model'));

const messages = await adapter.http('GET', '/api/sessions/messages?path=' + encodeURIComponent('studio://agent-1') + '&sessionId=agent-1');
check('transcript becomes history content',
  messages.messages[1].role === 'assistant' && messages.messages[1].content === 'pong' && messages.messages[1].thinking === 'because');

// ---- tauri path: incremental deltas while send_message is in flight ----
{
  calls.length = 0;
  const pushed = [];
  const timestamps = [];
  const turn = await adapter.ws({
    type: 'prompt',
    text: 'hi',
    sessionId: 'agent-1',
    sessionPath: 'studio://agent-1',
    clientMessageId: 'c1',
    displayMessage: { text: 'hi' },
  }, (ev) => {
    pushed.push(ev);
    timestamps.push(Date.now());
  });

  check('prompt awaits send_message',
    calls.some((c) => c.cmd === 'send_message' && c.args.agentId === 'agent-1' && c.args.text === 'hi' && c.args.msgId === 'c1'));
  check('tauri prompt streamed flag', turn.streamed === true);

  const deltas = pushed.filter((e) => e.type === 'text_delta' && e.delta);
  check('tauri prompt emits multiple text_delta chunks', deltas.length >= 2);
  check('tauri text_delta reassembles',
    deltas.map((e) => e.delta).join('') === 'Hello from Studio');
  check('tauri thinking forwarded',
    pushed.some((e) => e.type === 'thinking_delta'));
  check('tauri prompt emits user + turn_end',
    pushed.some((e) => e.type === 'session_user_message') && pushed.some((e) => e.type === 'turn_end'));

  // Best-effort incremental: at least one delta should have been observed
  // before send_message resolved (sendStarted set when invoke began).
  const firstDeltaAt = timestamps[pushed.findIndex((e) => e.type === 'text_delta' && e.delta)];
  check('at least one text_delta arrived during in-flight send (best-effort)',
    sendStarted != null && firstDeltaAt != null && firstDeltaAt >= sendStarted);
  const joined = deltas.map((e) => e.delta).join('');
  check('second-turn deltas are ONLY A2 (no A1 concat)',
    joined === 'Hello from Studio' && !joined.includes('pong'));
}

// Push events carry both an absolute current-step snapshot and its delta.
// Text from different assistant steps may overlap or even be identical; those
// are distinct model output and must not be content-deduplicated across tools.
{
  let partialHandler = null;
  window.__TAURI__ = {
    event: {
      listen: async (_event, handler) => {
        partialHandler = handler;
        return () => { partialHandler = null; };
      },
    },
  };
  const baseline = [
    { role: 'user', text: 'old', reasoning: '', tool_calls: [], tool_results: [] },
    { role: 'assistant', text: 'old reply', reasoning: '', tool_calls: [], tool_results: [] },
  ];
  liveTranscript = baseline;
  global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'agent-1', title: 'Race', busy: false, live: true, messages: liveTranscript.length, turns: 1, status: 'idle', usage: null },
      ]);
    }
    if (cmd === 'transcript') return Promise.resolve(liveTranscript.map((m) => structuredClone(m)));
    if (cmd === 'send_message') {
      return new Promise((resolve) => {
        setTimeout(() => {
          partialHandler?.({ payload: { agentId: args.agentId, text: 'abc', textDelta: 'abc', reasoning: '', reasoningDelta: '' } });
          liveTranscript = [
            ...baseline,
            { role: 'user', text: args.text, reasoning: '', tool_calls: [], tool_results: [] },
            { role: 'assistant', text: '', reasoning: '', tool_calls: [{ id: 'overlap-tool', name: 'read_file', arguments: '{"path":"x"}' }], tool_results: [] },
            { role: 'user', text: '', reasoning: '', tool_calls: [], tool_results: [{ tool_call_id: 'overlap-tool', content: 'ok', is_error: false }] },
          ];
        }, 10);
        setTimeout(() => {
          partialHandler?.({ payload: { agentId: args.agentId, text: 'cdef', textDelta: 'cdef', reasoning: '', reasoningDelta: '' } });
          liveTranscript = [
            ...liveTranscript,
            { role: 'assistant', text: 'cdef', reasoning: '', tool_calls: [{ id: 'same-tool', name: 'read_file', arguments: '{"path":"y"}' }], tool_results: [] },
            { role: 'user', text: '', reasoning: '', tool_calls: [], tool_results: [{ tool_call_id: 'same-tool', content: 'ok', is_error: false }] },
          ];
        }, 60);
        setTimeout(() => {
          partialHandler?.({ payload: { agentId: args.agentId, text: 'cdef', textDelta: 'cdef', reasoning: '', reasoningDelta: '' } });
          liveTranscript = [...liveTranscript, { role: 'assistant', text: 'cdef', reasoning: '', tool_calls: [], tool_results: [] }];
          resolve(undefined);
        }, 110);
      });
    }
    return Promise.resolve(undefined);
  };

  const progress = [];
  await api.sendWithProgress('agent-1', 'race', 'race-1', (event) => progress.push(event));
  const text = progress.filter((event) => event.kind === 'text_delta').map((event) => event.delta).join('');
  check('snapshot+delta keeps overlapping assistant steps exact', text === 'abccdefcdef');
  const snapshot = progress.find((event) => event.kind === 'assistant_snapshot');
  check('assistant snapshot preserves empty pre-tool slots',
    Array.isArray(snapshot?.segments)
    && snapshot.segments.length === 3
    && snapshot.segments[0] === ''
    && snapshot.segments[1] === 'cdef'
    && snapshot.segments[2] === 'cdef');
  check('push+transcript race emits each completed tool once',
    progress.filter((event) => event.kind === 'tool_start').length === 2
    && progress.filter((event) => event.kind === 'tool_end').length === 2);
  window.__TAURI__ = null;
}

// Stop invalidates the current progress callback before cancel_agent resolves.
// A new prompt gets a distinct stream and late output from the stopped turn
// cannot leak into either transcript.
{
  const originalSessions = api.sessions;
  const originalSendWithProgress = api.sendWithProgress;
  const originalCancel = api.cancel;
  let oldProgress = null;
  let resolveOldSend = null;
  let sendCount = 0;

  api.sessions = async () => [
    { id: 'agent-race', title: 'Race', busy: false, live: true, messages: 0, turns: 0, status: 'idle' },
  ];
  api.cancel = async () => undefined;
  api.sendWithProgress = async (_agentId, _text, _msgId, onProgress) => {
    sendCount += 1;
    if (sendCount === 1) {
      oldProgress = onProgress;
      await new Promise((resolve) => { resolveOldSend = resolve; });
      return true;
    }
    onProgress({ kind: 'text_delta', delta: 'new answer' });
    return true;
  };

  const oldEvents = [];
  const oldTurn = adapter.ws({
    type: 'prompt',
    text: 'old prompt',
    sessionId: 'agent-race',
    sessionPath: 'studio://agent-race',
    clientMessageId: 'old-message',
  }, (event) => oldEvents.push(event));
  while (!oldProgress) await new Promise((resolve) => setTimeout(resolve, 0));

  const oldStreamId = oldEvents[0]?.streamId;
  check('prompt events carry one streamId',
    typeof oldStreamId === 'string'
    && oldEvents.every((event) => event.streamId === oldStreamId));

  const stopEvents = [];
  await adapter.ws({
    type: 'abort',
    sessionId: 'agent-race',
    sessionPath: 'studio://agent-race',
    streamId: oldStreamId,
  }, (event) => stopEvents.push(event));
  const countAfterStop = oldEvents.length;

  oldProgress({ kind: 'text_delta', delta: 'late old answer' });
  oldProgress({ kind: 'tool_end', id: 'late-tool', name: 'bash', success: true, output: 'late' });
  oldProgress({ kind: 'assistant_snapshot', segments: ['late old answer'] });

  const newEvents = [];
  await adapter.ws({
    type: 'prompt',
    text: 'new prompt',
    sessionId: 'agent-race',
    sessionPath: 'studio://agent-race',
    clientMessageId: 'new-message',
  }, (event) => newEvents.push(event));
  resolveOldSend();
  await oldTurn;

  check('accepted Stop reports aborted terminal events for stopped stream',
    stopEvents.some((event) => event.type === 'abort_result' && event.status === 'accepted')
    && stopEvents.some((event) => event.type === 'turn_end' && event.aborted === true)
    && stopEvents.every((event) => event.streamId === oldStreamId));
  check('stopped turn drops all late progress and final events',
    oldEvents.length === countAfterStop
    && !oldEvents.some((event) => event.delta === 'late old answer' || event.id === 'late-tool'));
  check('next prompt uses a new isolated stream',
    newEvents[0]?.streamId
    && newEvents[0].streamId !== oldStreamId
    && newEvents.every((event) => event.streamId === newEvents[0].streamId)
    && newEvents.some((event) => event.type === 'text_delta' && event.delta === 'new answer'));

  api.sessions = originalSessions;
  api.sendWithProgress = originalSendWithProgress;
  api.cancel = originalCancel;
}

// steer must pass msgId
{
  calls.length = 0;
  await adapter.ws({
    type: 'interject',
    text: 'nudge',
    sessionId: 'agent-1',
    sessionPath: 'studio://agent-1',
    clientMessageId: 'steer-1',
  });
  check('steer_agent receives msgId',
    calls.some((c) => c.cmd === 'steer_agent'
      && c.args.agentId === 'agent-1'
      && c.args.text === 'nudge'
      && c.args.msgId === 'steer-1'));
}

const sent = [];
const cw = { postMessage(msg) { sent.push(msg); } };
const frameListeners = {};
const frame = {
  contentWindow: cw,
  addEventListener(type, fn) { (frameListeners[type] ||= []).push(fn); },
  removeEventListener() {},
};
const detach = host.attach(frame);
check('attach says hello immediately',
  sent.some((m) => m.source === 'openhanako-shell' && m.type === 'studio-backend-hello'));

messageHandlers[0]({
  source: cw,
  data: {
    source: 'openhanako-studio-bridge',
    type: 'request',
    requestId: 'sb-9',
    op: 'http',
    method: 'GET',
    path: '/api/sessions',
  },
});
await new Promise((resolve) => setTimeout(resolve, 20));
const response = sent.find((m) => m.type === 'response' && m.requestId === 'sb-9');
check('host bridge correlates requestId',
  response && response.ok === true && Array.isArray(response.result) && response.result[0].sessionId === 'agent-1');

// Host bridge pushes mid-turn events for WS
{
  sent.length = 0;
  // Reset live transcript growth for a short streamed turn
  liveTranscript = [
    { role: 'user', text: 'x', reasoning: '', tool_calls: [], tool_results: [] },
    { role: 'assistant', text: 'done', reasoning: '', tool_calls: [], tool_results: [] },
  ];
  global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'send_message') return Promise.resolve(undefined);
    if (cmd === 'transcript') return Promise.resolve(liveTranscript.map((m) => ({ ...m })));
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'agent-1', title: 'Hello', busy: false, live: true, messages: 2, turns: 1, status: 'idle', usage: null },
      ]);
    }
    if (cmd === 'resume_session') return Promise.resolve(args.sessionId);
    return Promise.resolve(undefined);
  };

  messageHandlers[0]({
    source: cw,
    data: {
      source: 'openhanako-studio-bridge',
      type: 'request',
      requestId: 'sb-ws-1',
      op: 'ws',
      message: {
        type: 'prompt',
        text: 'x',
        sessionId: 'agent-1',
        sessionPath: 'studio://agent-1',
        clientMessageId: 'cx',
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const events = sent.filter((m) => m.type === 'event' && m.requestId === 'sb-ws-1');
  const final = sent.find((m) => m.type === 'response' && m.requestId === 'sb-ws-1');
  check('host bridge pushes event messages for WS turns', events.length >= 2);
  check('host bridge event payloads are chat events',
    events.some((m) => m.event && m.event.type === 'session_user_message'));
  check('host bridge final WS ack is empty when streamed',
    final && final.ok && final.result && final.result.streamed === true
    && Array.isArray(final.result.events) && final.result.events.length === 0);
}


// archive must dispose the Studio agent (not a no-op stub)
{
  calls.length = 0;
  const archived = await adapter.http('POST', '/api/sessions/archive', { sessionId: 'agent-1' });
  check('archive disposes agent',
    archived && archived.ok === true && archived.removed === true
    && calls.some((c) => c.cmd === 'dispose_agent' && c.args.agentId === 'agent-1'));
}

// Busy session must refuse a second prompt (send lock).
{
  calls.length = 0;
  global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'list_sessions') {
      return Promise.resolve([
        { id: 'busy-1', title: 'Busy', busy: true, live: true, messages: 1, turns: 1, status: 'running', usage: null },
      ]);
    }
    if (cmd === 'send_message') return Promise.reject(new Error('should not send'));
    if (cmd === 'transcript') return Promise.resolve([]);
    return Promise.resolve(undefined);
  };
  // Clear module cache so api/adapter see new invoke? They close over tauri.invoke
  // which reads window each call — good.
  const pushed = [];
  const turn = await adapter.ws({
    type: 'prompt',
    text: 'second',
    sessionId: 'busy-1',
    sessionPath: 'studio://busy-1',
    clientMessageId: 'c-busy',
  }, (ev) => pushed.push(ev));
  check('busy prompt refuses with session_busy',
    pushed.some((e) => e.type === 'error' && e.code === 'session_busy'));
  check('busy prompt does not call send_message',
    !calls.some((c) => c.cmd === 'send_message'));
  check('busy prompt still reports streamed envelope', turn.streamed === true);
}


detach();
check('detach removes the message listener', messageHandlers.length === 0);

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('studio bridge: ok');
