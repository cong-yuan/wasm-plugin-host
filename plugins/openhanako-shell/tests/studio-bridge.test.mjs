// Parent-side vertical slice: Tauri commands when invoke exists, mock
// fallback when it does not, and the iframe postMessage contract.
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

const calls = [];
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
    if (cmd === 'send_message') return Promise.resolve(undefined);
    if (cmd === 'steer_agent') return Promise.resolve(undefined);
    if (cmd === 'cancel_agent') return Promise.resolve(undefined);
    if (cmd === 'transcript') {
      return Promise.resolve([
        { role: 'user', text: 'hi', reasoning: '', tool_calls: [], tool_results: [] },
        { role: 'assistant', text: 'pong', reasoning: 'because', tool_calls: [], tool_results: [] },
      ]);
    }
    return Promise.reject(new Error('unknown ' + cmd));
  },
};

check('api mode flips to tauri once invoke exists', api.mode() === 'tauri');
const live = await api.sessions();
check('sessions call list_sessions', calls.some((c) => c.cmd === 'list_sessions') && live[0].id === 'agent-1');

const created = await adapter.http('POST', '/api/sessions/new-detached', {});
check('create_agent uses mock/mock-1',
  created.sessionId === 'agent-new'
  && created.path === 'studio://agent-new'
  && calls.some((c) => c.cmd === 'create_agent'
    && c.args.provider === 'mock' && c.args.model === 'mock-1'));

calls.length = 0;
const switched = await adapter.http('POST', '/api/sessions/switch', { path: 'studio://agent-2', sessionId: 'agent-2' });
check('cold session resumes',
  switched.sessionId === 'agent-2'
  && calls.some((c) => c.cmd === 'resume_session' && c.args.sessionId === 'agent-2'));

const messages = await adapter.http('GET', '/api/sessions/messages?path=' + encodeURIComponent('studio://agent-1') + '&sessionId=agent-1');
check('transcript becomes history content',
  messages.messages[1].role === 'assistant' && messages.messages[1].content === 'pong' && messages.messages[1].thinking === 'because');

const turn = await adapter.ws({
  type: 'prompt',
  text: 'hi',
  sessionId: 'agent-1',
  sessionPath: 'studio://agent-1',
  clientMessageId: 'c1',
  displayMessage: { text: 'hi' },
});
const types = turn.events.map((e) => e.type);
check('prompt awaits send_message',
  calls.some((c) => c.cmd === 'send_message' && c.args.agentId === 'agent-1' && c.args.text === 'hi' && c.args.msgId === 'c1'));
check('prompt emits user + text_delta + turn_end',
  types.includes('session_user_message') && types.includes('text_delta') && types.includes('turn_end'));
const delta = turn.events.find((e) => e.type === 'text_delta');
check('text_delta carries sessionPath and the full reply',
  delta && delta.delta === 'pong' && delta.sessionPath === 'studio://agent-1' && delta.sessionId === 'agent-1');
check('thinking is forwarded when reasoning is present', types.includes('thinking_delta'));

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

detach();
check('detach removes the message listener', messageHandlers.length === 0);

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('studio bridge: ok');
