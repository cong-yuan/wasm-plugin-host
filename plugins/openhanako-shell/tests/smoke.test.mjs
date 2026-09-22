// Renders the shell against a minimal DOM shim to catch runtime errors and
// assert the upstream class/SVG structure actually reaches the tree.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SVG_NS = 'http://www.w3.org/2000/svg';

class StyleShim {
  setProperty(k, v) { this[k] = String(v); }
  cssText = '';
}

class El {
  constructor(tag, ns = null) {
    this.tagName = ns === SVG_NS ? tag : tag.toUpperCase();
    this.namespaceURI = ns;
    this.children = [];
    this.attrs = {};
    this.style = new StyleShim();
    this.dataset = {};
    this._text = '';
    this.classList = {
      add: (...c) => this._setClasses([...this._classes(), ...c]),
      remove: (...c) => this._setClasses(this._classes().filter((x) => !c.includes(x))),
      contains: (c) => this._classes().includes(c),
      toggle: (c, on) => {
        const has = this._classes().includes(c);
        const want = on === undefined ? !has : !!on;
        if (want) this.classList.add(c); else this.classList.remove(c);
        return want;
      },
    };
  }
  _classes() { return (this.attrs.class || '').split(/\s+/).filter(Boolean); }
  _setClasses(list) { this.attrs.class = [...new Set(list)].join(' '); }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ''; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => (c.nodeType === 3 ? c.textContent : c.textContent)).join('');
  }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get firstElementChild() { return this.children.find((c) => c.nodeType !== 3) ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(ev, fn) { (this._ev ||= {})[ev] = fn; }
  fire(ev, obj = {}) {
    const prop = this['on' + ev];
    if (typeof prop === 'function') prop(obj);
    const bound = this._ev && this._ev[ev];
    if (typeof bound === 'function') bound(obj);
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) if (c != null) this.appendChild(c); }
  replaceChildren(...cs) { this.children = cs; this._text = ''; }
  remove() {}
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    const out = [];
    const match = (el) => {
      if (!el.attrs) return false;
      if (sel.startsWith('.')) return el._classes && el._classes().includes(sel.slice(1));
      if (sel.startsWith('#')) return el.attrs.id === sel.slice(1);
      const attrExact = sel.match(/^(\w*)\[([\w-]+)="([^"]*)"\]$/);
      if (attrExact) return el.attrs[attrExact[2]] === attrExact[3];
      const attrHas = sel.match(/^\[([\w-]+)\]$/);
      if (attrHas) return attrHas[1] in el.attrs;
      return (el.tagName || '').toLowerCase() === sel.toLowerCase();
    };
    const walk = (el) => {
      for (const c of el.children || []) {
        if (c && c.attrs && match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const head = new El('head');
const documentElement = new El('html');
global.document = {
  documentElement,
  head,
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t, ns),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  importNode: (node) => node,
  querySelector: (sel) => head.querySelector(sel),
};

// Parse the verbatim upstream SVG strings well enough to keep the real shapes.
global.DOMParser = class {
  parseFromString(markup) {
    const stack = [new El('svg', SVG_NS)];
    const re = /<\/?([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
    let m;
    while ((m = re.exec(markup))) {
      const [raw, tag, attrText, selfClose] = m;
      if (raw.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      const el = new El(tag, SVG_NS);
      for (const a of attrText.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
        el.setAttribute(a[1], a[2]);
      }
      stack[stack.length - 1].appendChild(el);
      if (!selfClose) stack.push(el);
    }
    // Real DOMParser makes the parsed root the documentElement; the synthetic
    // stack[0] is only a container, so unwrap one level to match.
    return { documentElement: stack[0].firstElementChild ?? stack[0] };
  }
};

global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
global.Blob = class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; } };
global.URL = { createObjectURL: () => 'blob:font' };
global.window = { __TAURI_INTERNALS__: null, __TAURI__: null };

// --- plugin module loader (mirrors the host's studio.require) ---
const sources = new Map();
for (const name of [
  'lib/dom.js', 'lib/slots.js', 'lib/api.js', 'lib/avatar.js',
  'lib/fonts.js', 'lib/theme.js', 'lib/i18n.js', 'lib/resize.js',
  'lib/motion.js', 'lib/tokens.js',
  'panels/titlebar.js', 'panels/sidebar.js', 'panels/conversation.js',
  'panels/preview.js', 'panels/rail.js', 'shell.js',
]) {
  sources.set(name.replace(/\.js$/, ''), readFileSync(join(ROOT, 'js', name), 'utf8'));
}
const cache = new Map();
const studio = {
  require(name) {
    const key = name.replace(/\.js$/, '');
    if (cache.has(key)) return cache.get(key);
    const src = sources.get(key);
    if (!src) throw new Error(`module not found: ${name}`);
    const value = new Function('studio', src)(studio);
    cache.set(key, value);
    return value;
  },
  register() {},
  provideSlot() {},
  renderSlot() {},
};

// --- run ---
const failures = [];
const check = (label, cond) => { if (!cond) failures.push(label); };

const shell = studio.require('shell');
const host = new El('div');
shell.render(host);

const root = host.children[0];
check('root .hana-replica', root.className.includes('hana-replica'));
check('root data-theme=new-warm-paper', root.getAttribute('data-theme') === 'new-warm-paper');
check('paper-texture enabled', root.className.includes('paper-texture'));
check('fonts injected', head.children.length > 0);

const count = (sel) => root.querySelectorAll(sel).length;
const nodes = (() => { let n = 0; const walk = (e) => { n++; for (const c of e.children || []) walk(c); }; walk(root); return n; })();

// Upstream structure landmarks.
for (const sel of [
  '.titlebar', '.tb-left-group', '.tb-toggle-left', '.tb-center-title', '.tb-right-group',
  '.app', '.sidebar', '.sidebar-inner', '.sidebar-chat-content', '.sidebar-header',
  '.sidebar-title', '.sidebar-header-actions', '.sidebar-activity-bar', '.sidebar-bridge-card',
  '.sidebar-bridge-dot', '.session-list', '.sessionListScroller', '.resize-handle',
  '.main-content', '.chat-area', '.welcome', '.welcomeAvatar', '.welcomeText',
  '.folderSelectWrap', '.folderSelectBtn', '.memoryToggleBtn',
  '.input-area', '.input-surface', '.input-stack', '.input-wrapper', '.input-box',
  '.input-bottom-bar', '.input-actions', '.input-controls', '.attach-btn',
  '.plan-mode-btn', '.model-selector', '.model-pill', '.send-btn', '.send-label',
  '.preview-panel', '.jian-sidebar', '.jian-sidebar-inner', '.workspaceShell',
  '.workspaceCard', '.universal-card', '.workspaceHeader', '.workspaceTitle',
  '.tabs', '.tabSlider', '.tab', '.tabActive', '.content',
  '.jianDrawer', '.jianHeader', '.jianTitle', '.jianBody', '.jianToggle',
]) {
  check(`missing ${sel}`, count(sel) > 0);
}

// SVG must be namespaced, or the browser renders nothing.
const svgs = root.querySelectorAll('svg');
check('has svg icons', svgs.length >= 12);
check('svg in SVG namespace', svgs.every((s) => s.namespaceURI === SVG_NS));
const shapes = svgs.flatMap((s) => s.children);
check('svg shape children namespaced',
  shapes.length > 0 && shapes.every((s) => s.namespaceURI === SVG_NS));
check('svg keeps viewBox', svgs.every((s) => s.getAttribute('viewBox') === '0 0 24 24'
  || s.getAttribute('viewBox') === '0 0 32 32' || s.getAttribute('viewBox') === '0 0 12 12'));

// Upstream sidebar puts activity bars as flat siblings of the header.
const chatContent = root.querySelector('.sidebar-chat-content');
check('4 activity bars', chatContent.children.filter(
  (c) => c._classes().includes('sidebar-activity-bar')).length === 4);

// Interactions must not throw.
root.querySelector('.tb-toggle-left').fire('click');
root.querySelector('.tb-toggle-right').fire('click');
root.querySelector('.tb-toggle-preview').fire('click');
root.querySelector('.jianToggle').fire('click');
check('jian drawer opens',
  root.querySelector('.jianDrawer').getAttribute('data-open') === 'true');
root.querySelectorAll('.tab')[0].fire('click');
check('tab switches', root.querySelectorAll('.tabActive').length === 1);
root.querySelector('.memoryToggleBtn').fire('click');

console.log(`DOM smoke: ${nodes} nodes, ${svgs.length} svg, ${count('.hana-slot')} slots`);
if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('DOM smoke: ok');
