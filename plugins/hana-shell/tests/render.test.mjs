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
    const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } };
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
const collect = (el) => { for (const c of el.children) { if (c.attrs['data-host-slot']) slots.push('HOST:'+c.attrs['data-host-slot']); collect(c); } };
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
console.log(bad ? 'FAILED' : 'OK');
