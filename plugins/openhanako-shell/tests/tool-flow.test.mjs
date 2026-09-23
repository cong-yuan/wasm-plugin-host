// Tool-call propagation through the Studio bridge.
//
// Studio's `transcript` carries `tool_calls` / `tool_results`, but the live
// stream used to push only text/reasoning. The tool cards, the todo list and the
// file/reference cards are all rebuilt from tool events (live) and from
// `toolCalls` (history hydrate), so any drop here silently blanks those surfaces.
//
// Also pins the user-message echo: `confirmOptimisticUserMessage` spreads the
// server payload over the optimistic bubble, so an omitted `quotedText` becomes
// an explicit `undefined` and wipes the quote the user just sent.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rows = [];
let duringSend = null;
global.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      if (cmd === 'list_agents' || cmd === 'list_sessions') {
        return [{ id: 'a1', title: 't', messages: rows.length, live: true, busy: false, updated_at: Date.now() }];
      }
      if (cmd === 'transcript') return rows.map((r) => JSON.parse(JSON.stringify(r)));
      if (cmd === 'resume_session') return args.sessionId;
      if (cmd === 'chat_partial') return { agentId: args.agentId, text: '', reasoning: '' };
      if (cmd === 'send_message') {
        await duringSend?.();
        return null;
      }
      return null;
    },
    transformCallback: () => 1,
  },
  addEventListener() {}, removeEventListener() {},
};

const sources = new Map();
for (const name of ['lib/tauri-invoke.js', 'lib/api.js', 'lib/hana-adapter.js']) {
  sources.set(name.replace(/\.js$/, ''), readFileSync(join(ROOT, 'js', name), 'utf8'));
}
const cache = new Map();
const studio = {
  require(name) {
    const key = name.replace(/\.js$/, '');
    if (cache.has(key)) return cache.get(key);
    const value = new Function('studio', sources.get(key))(studio);
    cache.set(key, value);
    return value;
  },
};
const adapter = studio.require('lib/hana-adapter');

const failures = [];
const check = (label, cond) => { if (!cond) failures.push(label); };

// ---- history hydrate carries tools ----
rows.push({ role: 'user', text: 'hi', tool_calls: [], tool_results: [] });
rows.push({
  role: 'assistant', text: 'done', reasoning: '',
  tool_calls: [
    { id: 'c1', name: 'read', arguments: '{"file_path":"/tmp/x.ts"}' },
    { id: 'c2', name: 'todo_write', arguments: '{"todos":[{"content":"a","activeForm":"a","status":"in_progress"}]}' },
  ],
  tool_results: [
    { tool_call_id: 'c1', content: 'file body', is_error: false },
    { tool_call_id: 'c2', content: '{"todos":[{"content":"a","activeForm":"a","status":"in_progress"}]}', is_error: false },
  ],
});

const msgs = await adapter.http('GET', '/api/sessions/messages?path=studio://a1&sessionId=a1');
const asst = msgs.messages.find((m) => m.role === 'assistant');
check('history assistant carries toolCalls', Array.isArray(asst.toolCalls) && asst.toolCalls.length === 2);
check('tool arguments parsed to object', asst.toolCalls[0].args?.file_path === '/tmp/x.ts');
check('tool success derived from tool_result', asst.toolCalls[0].success === true && asst.toolCalls[0].status === 'succeeded');
check('todo_write arguments stay structured', Array.isArray(asst.toolCalls[1].args?.todos));

// ---- live stream carries tools + echoes the user message ----
duringSend = async () => {
  rows.push({ role: 'user', text: 'go', tool_calls: [], tool_results: [] });
  rows.push({
    role: 'assistant', text: '', reasoning: '',
    tool_calls: [{ id: 'c9', name: 'bash', arguments: '{"command":"ls"}' }],
    tool_results: [],
  });
  await new Promise((r) => setTimeout(r, 60));
  const last = rows[rows.length - 1];
  last.tool_results = [{ tool_call_id: 'c9', content: '{"ok":true}', is_error: false }];
  last.text = 'done';
};

const events = [];
await adapter.ws(
  { type: 'prompt', sessionId: 'a1', sessionPath: 'studio://a1', clientMessageId: 'm1', text: 'go',
    displayMessage: { text: 'go', quotedText: '引用的话' } },
  (ev) => events.push(ev),
);

const kinds = events.map((e) => e.type);
check('live stream emits tool_start', kinds.includes('tool_start'));
check('live stream emits tool_end', kinds.includes('tool_end'));
const started = events.find((e) => e.type === 'tool_start');
check('tool_start names the tool with parsed args', started?.name === 'bash' && started?.args?.command === 'ls');
const ended = events.find((e) => e.type === 'tool_end');
check('tool_end marks success and carries parsed details', ended?.success === true && ended?.details?.ok === true);
const echoed = events.find((e) => e.type === 'session_user_message');
check('session_user_message echoes quotedText', echoed?.message?.quotedText === '引用的话');

// ---- todo_write normalisation (live + history) ----
// dsh's todo_write keeps the authoritative list in the CALL ARGUMENTS and only
// returns text; the checklist reads `details.todos` (with `activeForm`).
duringSend = async () => {
  rows.push({ role: 'user', text: 'plan', tool_calls: [], tool_results: [] });
  rows.push({
    role: 'assistant', text: '', reasoning: '',
    tool_calls: [{ id: 't1', name: 'todo_write', arguments: '{"todos":[{"content":"写测试","status":"in_progress"},{"content":"跑测试","status":"pending"}]}' }],
    tool_results: [],
  });
  await new Promise((r) => setTimeout(r, 60));
  rows[rows.length - 1].tool_results = [{ tool_call_id: 't1', content: 'todo list updated (2 items)', is_error: false }];
};
const todoEvents = [];
await adapter.ws(
  { type: 'prompt', sessionId: 'a1', sessionPath: 'studio://a1', clientMessageId: 'm2', text: 'plan' },
  (ev) => todoEvents.push(ev),
);
const todoEnd = todoEvents.find((e) => e.type === 'tool_end' && e.name === 'todo_write');
check('todo_write tool_end carries structured todos', Array.isArray(todoEnd?.details?.todos) && todoEnd.details.todos.length === 2);
check('todo items get activeForm + status', todoEnd?.details?.todos?.[0]?.activeForm === '写测试' && todoEnd.details.todos[0].status === 'in_progress');

const msgs2 = await adapter.http('GET', '/api/sessions/messages?path=studio://a1&sessionId=a1');
check('history response exposes latest todos', Array.isArray(msgs2.todos) && msgs2.todos.length === 2);
check('history todo keeps status', msgs2.todos[1]?.status === 'pending' && msgs2.todos[1]?.content === '跑测试');

if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('tool-flow: ok');
