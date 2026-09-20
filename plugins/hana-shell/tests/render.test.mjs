import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal DOM shim, enough for the shell to build its tree.
class StyleShim { setProperty(k,v){ this[k]=String(v); } cssText=''; }
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = new StyleShim(); this._text = ''; this.dataset = {}; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  setProperty(k, v) { this.style[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
  addEventListener(ev, fn) { (this._ev ||= {})[ev] = fn; }
  // `dom.js` assigns handlers as properties (`el.onclick = fn`), so `fire` has
  // to look in both places.
  fire(ev, obj = {}) {
    const prop = this['on' + ev];
    if (typeof prop === 'function') prop(obj);
    for (const fn of [].concat(this._ev && this._ev[ev] || [])) fn(obj);
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  replaceChildren(...cs) { this.children = cs; }
  querySelector(sel) { return this._find(sel)[0] ?? null; }
  querySelectorAll(sel) { return this._find(sel); }
  _find(sel) {
    const out = [];
    const match = (el) => {
      if (sel.startsWith('[data-slot="') ) { const v=sel.slice(12,-2); return el.attrs['data-slot']===v; }
      if (sel.startsWith('.')) return (el.className||'').split(/\s+/).includes(sel.slice(1));
      if (sel.startsWith('[data-role]')) return 'data-role' in el.attrs;
      return false;
    };
    const walk = (el) => { for (const c of (el.children || [])) { if (c && c.attrs && match(c)) out.push(c); walk(c); } };
    // `[attr="value"]` is what the suite uses to find a specific session row;
    // the earlier selectors here were all slot/class probes.
    const attrExact = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
    if (attrExact) {
      const [, k, v] = attrExact;
      const matchAttr = (el) => el.attrs && el.attrs[k] === v;
      const walkAttr = (el) => { for (const c of (el.children || [])) { if (c && c.attrs && matchAttr(c)) out.push(c); walkAttr(c); } };
      walkAttr(this);
      return out;
    }
    walk(this); return out;
  }
}
const documentElement = new El('html');
global.document = {
  documentElement,
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  getElementById: () => null,
  head: new El('head'),
  querySelector: () => null,
};
global.window = {};
global.setInterval = () => 0;
global.clearInterval = () => {};

const assets = {};
const JS_ROOT = join(ROOT, 'js');
const walkDir = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDir(p);
    else assets[p.slice(JS_ROOT.length + 1)] = readFileSync(p, 'utf8');
  }
};
walkDir(JS_ROOT);

// ── a fake backend ──────────────────────────────────────────────────────────
// `api.js` goes through `window.__TAURI_INTERNALS__.invoke`. Standing it up here
// is what lets the render harness assert what the shell does with **real data**
// rather than only that its skeleton builds.
const AGENTS = [
  { id: 'a1', status: 'idle', messages: 4, turns: 9, busy: false,
    title: 'refactor the token estimator',
    usage: { input: 1200, output: 800, calls: 2 } },
  { id: 'a2', status: 'running', messages: 1, turns: 2, busy: true,
    title: '', usage: { input: 0, output: 0, calls: 0 } },
];
const BACKEND = {
  studio_status: { booted: true, providers: ['mock', 'deepseek'], tool_count: 7,
                   service_count: 2, watching: true, slot_count: 2,
                   plugins_dir: '/p', config_path: '/c', wasm_tool_count: 3 },
  list_agents: AGENTS,
  list_plugins: [{ slot: 'shell', plugin: 'hana-shell', state: 'active', tool_count: 0 }],
  list_tools: [{ name: 'alpha_tool', plugin: 'alpha' }],
  list_services: [],
  plugin_windows: [{ label: 'plugin-shell-main', slot: 'shell', title: 'Hana' }],
  transcript: [{ role: 'user', text: 'hi', reasoning: '', tool_calls: [], tool_results: [] }],
};
const invokeLog = [];
global.window = global.window || {};
global.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    invokeLog.push(cmd);
    if (cmd === 'create_agent') return Promise.resolve('a-new');
    const v = BACKEND[cmd];
    return v === undefined ? Promise.reject(new Error('unknown ' + cmd)) : Promise.resolve(v);
  },
};

const drain = () => new Promise((r) => setTimeout(r, 0));

const registered = {};
const injected = [];
const studio = {
  require(name) {
    if (!(name in assets) && !(name + '.js' in assets)) throw new Error('asset not declared: ' + name);
    const key = name in assets ? name : name + '.js';
    const fn = new Function('studio', assets[key]);
    return fn(studio);
  },
  register(name, factory) { registered[name] = factory; },
  inject(slot, component, priority) { injected.push({ slot, component, priority }); },
  renderSlot() { return () => {}; },
};

// Load every asset once, as the host would.
for (const [path, src] of Object.entries(assets)) {
  if (!path.endsWith('.js')) continue;
  try { new Function('studio', src); } catch (e) { console.error('PARSE FAIL', path, e.message); process.exit(1); }
}

// Run entry.js
const entry = new Function('studio', assets['entry.js']);
entry(studio);


// Mount the shell
const root = new El('div');
registered['HanaShell'](root);
const shell = root.querySelector('.hn-shell') || root.children[0];
const slots = [];
const collect = (el) => { for (const c of (el.children || [])) { if (c && c.attrs && c.attrs['data-host-slot']) slots.push('HOST:'+c.attrs['data-host-slot']); collect(c); } };
collect(root);
const mounted = [...new Set(slots)].map((s) => s.replace('HOST:', ''));
const expected = ['hana.titlebar.left','hana.titlebar.center','hana.titlebar.right',
  'hana.sidebar.header','hana.sidebar.activities','hana.sidebar.sessions',
  'hana.sidebar.notice','hana.sidebar.footer','hana.conversation.header',
  'hana.conversation.hero','hana.conversation.stream','hana.conversation.input.dock',
  'hana.conversation.input.right','hana.preview.panel','hana.rail.header',
  'hana.rail.items','hana.shell.overlay'];

let bad = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) { bad++; process.exitCode = 1; }
};
check('entry registers HanaShell and HanaCard',
  'HanaShell' in registered && 'HanaCard' in registered, Object.keys(registered).join(','));
check('the shell mounts all ' + expected.length + ' declared slots',
  expected.every((s) => mounted.includes(s)) && mounted.length === expected.length,
  mounted.length + ' mounted');
for (const s of expected) {
  check('mounts ' + s, mounted.includes(s));
}

// ── the shell renders real backend data ─────────────────────────────────────
// The panel fetches on mount, so let the microtask queue drain first.
await drain(); await drain();

const textOf = (el) => {
  if (!el || typeof el !== 'object') return '';
  // Text nodes are plain objects in this shim, with no children.
  let out = el._text || '';
  if (el.attrs && el.attrs.text) out += ' ' + el.attrs.text;
  for (const c of (el.children || [])) out += ' ' + textOf(c);
  return out.replace(/\s+/g, ' ').trim();
};
const all = textOf(root);

check('the session list renders agent titles, not ids',
  all.includes('refactor the token estimator'), all.slice(0, 200));
check('an untitled session shows a placeholder rather than blank',
  all.includes('New session'));
check('usage is shown for a session that reported tokens',
  all.includes('2.0k'), 'expected 2000 tokens rendered as 2.0k: ' + all.slice(0, 250));
check('the sidebar lists the configured providers, not just mock',
  all.includes('deepseek'), all.slice(0, 250));

// The rail's cards come from the same backend.
check('the rail reports the harness state',
  all.includes('online'), all.slice(0, 250));
check('the rail lists the mounted plugin',
  all.includes('hana-shell'), all.slice(0, 300));
check('the rail lists the contributed tool',
  all.includes('alpha_tool'), all.slice(0, 300));

// The panel asked the backend for the right things.
check('it queried list_agents',
  invokeLog.includes('list_agents'), invokeLog.join(','));
check('it queried studio_status',
  invokeLog.includes('studio_status'), invokeLog.join(','));

// ── sending picks a configured provider, not mock ───────────────────────────
// This is the bug the whole change exists to fix: the panel used to hardcode
// `mock`, silently ignoring a configured endpoint.
const ta = root.querySelector('.hn-comp-input');
const sendBtn = root.querySelector('.hn-comp-primary');
let sent = null;
global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
  invokeLog.push(cmd);
  if (cmd === 'create_agent') { sent = args; return Promise.resolve('a-new'); }
  if (cmd === 'send_message') return Promise.resolve(null);
  const v = BACKEND[cmd];
  return v === undefined ? Promise.reject(new Error('unknown ' + cmd)) : Promise.resolve(v);
};
ta.value = 'hello';
sendBtn.fire('click', {});
await drain();

// `send` goes through `safe`, which awaits the invoke promise, so give the
// promise chain a tick to settle.
await new Promise((r) => setTimeout(r, 10));
check('creating an agent uses a real provider when one is configured',
  sent && sent.provider === 'deepseek',
  'provider was ' + JSON.stringify(sent && sent.provider));

// ── stored sessions are listed, marked, and resumed on open ─────────────────
// A session on disk has no driver behind it. It must still appear (hiding it
// would make persistence look broken), be distinguishable from a live one, and
// turn into a live one when opened — otherwise "restart and keep going"
// silently degrades to "restart and read".
BACKEND.list_sessions = [
  { id: 'live-1', live: true, status: 'idle', kind: 'agent', title: 'a live one',
    messages: 2, turns: 3, busy: false, usage: { input: 0, output: 0, calls: 0 } },
  { id: 'disk-1', live: false, status: 'stored', title: 'an older one',
    messages: 4, turns: 9, busy: false, usage: { input: 0, output: 0, calls: 0 } },
];
let resumed = null;
global.window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
  invokeLog.push(cmd);
  if (cmd === 'resume_session') { resumed = args; return Promise.resolve(args.sessionId); }
  const v = BACKEND[cmd];
  return v === undefined ? Promise.reject(new Error('unknown ' + cmd)) : Promise.resolve(v);
};
// A fresh mount, so the session list is built from `list_sessions`.
const root2 = new El('div');
registered['HanaShell'](root2);
await new Promise((r) => setTimeout(r, 20));

const rowFor = (id) => root2.querySelector('[data-agent="' + id + '"]');
check('the sidebar lists the session that is only on disk',
  !!rowFor('disk-1'), 'rows: ' + root2.querySelectorAll('[data-agent]').map((e) => e.attrs['data-agent']).join(','));
check('a stored session is marked as not live',
  rowFor('disk-1') && rowFor('disk-1').attrs['data-live'] === 'false',
  'data-live was ' + (rowFor('disk-1') && rowFor('disk-1').attrs['data-live']));
check('a live session is marked as live',
  rowFor('live-1') && rowFor('live-1').attrs['data-live'] === 'true',
  'data-live was ' + (rowFor('live-1') && rowFor('live-1').attrs['data-live']));
check('the stored session shows a readable title, not its id',
  /an older one/.test(JSON.stringify(rowFor('disk-1'))),
  JSON.stringify(rowFor('disk-1')));

// Opening it must resume, because there is no agent to read from yet.
rowFor('disk-1').fire('click', {});
await new Promise((r) => setTimeout(r, 20));
check('opening a stored session resumes it',
  resumed && resumed.sessionId === 'disk-1', 'resume args: ' + JSON.stringify(resumed));
check('opening a stored session does not try to resume a live one',
  resumed === null || resumed.sessionId !== 'live-1', JSON.stringify(resumed));

console.log(bad ? 'FAILED' : 'OK');
