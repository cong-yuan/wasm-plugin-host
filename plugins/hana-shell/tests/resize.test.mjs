// Loads the shell the way the plugin host does (`new Function`) against a small
// DOM shim, then simulates real drags. Catches what the Rust tests cannot: the
// handle wiring, the clamp, persistence and reset.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve `js/` relative to this file, so the harness runs from any cwd.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class StyleShim {
  constructor() { this._p = {}; this.cssText = ''; }
  setProperty(k, v) { this._p[k] = String(v); }
  getPropertyValue(k) { return this._p[k] ?? ''; }
  removeProperty(k) { delete this._p[k]; }
}

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = []; this.attrs = {}; this.style = new StyleShim();
    this._text = ''; this._w = 0; this._ev = {}; this.dataset = {};
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
  set className(v) { this.attrs.class = String(v); for (const c of String(v).split(/\s+/)) if (c) this.classList._set.add(c); }
  get className() { return this.attrs.class || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
  addEventListener(ev, fn) { (this._ev[ev] ||= []).push(fn); }
  removeEventListener(ev, fn) { this._ev[ev] = (this._ev[ev] || []).filter((f) => f !== fn); }
  fire(ev, obj = {}) { for (const fn of [...(this._ev[ev] || [])]) fn(obj); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = cs; }
  getBoundingClientRect() { return { width: this._w, height: 0, top: 0, left: 0 }; }
  querySelector(sel) { return this._find(sel)[0] ?? null; }
  querySelectorAll(sel) { return this._find(sel); }
  _find(sel) {
    const out = [];
    const match = (el) => {
      const eq = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
      if (eq) return el.attrs[eq[1]] === eq[2];
      if (sel.startsWith('[data-') && sel.endsWith(']')) return sel.slice(1, -1) in el.attrs;
      if (sel.startsWith('.')) return (el.className || '').split(/\s+/).includes(sel.slice(1));
      return false;
    };
    const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } };
    walk(this); return out;
  }
}

const store = new Map();
const docEvents = {};
const body = new El('body');
global.document = {
  documentElement: new El('html'),
  body,
  head: new El('head'),
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener: (ev, fn) => { (docEvents[ev] ||= []).push(fn); },
  removeEventListener: (ev, fn) => { docEvents[ev] = (docEvents[ev] || []).filter((f) => f !== fn); },
};
const fireDoc = (ev, obj) => { for (const fn of [...(docEvents[ev] || [])]) fn(obj); };
global.window = {
  innerWidth: 1440,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
global.setInterval = () => 0;
global.clearInterval = () => {};

const assets = {};
const JS_ROOT = join(ROOT, 'js');
const walkDir = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDir(p);
    // Key by the path the plugin's `require` uses, i.e. relative to `js/`.
    else assets[p.slice(JS_ROOT.length + 1)] = readFileSync(p, 'utf8');
  }
};
walkDir(JS_ROOT);

const results = [];
const check = (name, cond, detail) => {
  results.push((cond ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!cond) process.exitCode = 1;
};

// Parse every asset as the host would, so a syntax error fails here.
for (const [path, src] of Object.entries(assets)) {
  if (!path.endsWith('.js')) continue;
  try { new Function('studio', src); } catch (e) { check('parse ' + path, false, e.message); }
}

const registered = {};
const studio = {
  require(name) {
    const key = name in assets ? name : name + '.js';
    if (!(key in assets)) throw new Error('asset not declared: ' + name);
    return new Function('studio', assets[key])(studio);
  },
  register(name, factory) { registered[name] = factory; },
  inject() {},
  renderSlot() { return () => {}; },
};
new Function('studio', assets['entry.js'])(studio);

// ── mount ──
const host = new El('div');
registered['HanaShell'](host);
const shell = host.querySelector('.hn-shell') || host.children[0];
const col = (pane) => host.querySelector('[data-pane="' + pane + '"]');
const sidebar = col('sidebar'), preview = col('preview'), rail = col('rail');
sidebar._w = 240; preview._w = 320; rail._w = 260;
const w = (side) => shell.style.getPropertyValue('--dw-' + side + '-width');

const tb = shell.querySelector('.hn-tb');
tb._h = 44;
const hTitlebar = shell.querySelector('[data-resize="titlebar"]');
check('a titlebar handle is mounted', !!hTitlebar);
const h = (side) => shell.style.getPropertyValue('--dw-' + side + '-h');
const dragY = (handle, from, to) => { handle.fire('mousedown', { button: 0, clientY: from, preventDefault() {} }); fireDoc('mousemove', { clientY: to }); };
dragY(hTitlebar, 44, 84);
check('dragging the titlebar down grows it 44 → 84', h('titlebar') === '84px', h('titlebar'));
check('the body marks a vertical drag', body.classList.contains('resizing-y'));
fireDoc('mouseup', {});
check('the titlebar height is persisted', store.get('hana-shell-titlebar-height') === '84', store.get('hana-shell-titlebar-height'));
check('the column headers did not move', shell.style.getPropertyValue('--dw-header-h') === '', 'header-h untouched');
dragY(hTitlebar, 44, 500);
check('the titlebar clamps to its 120px maximum', h('titlebar') === '120px', h('titlebar'));
fireDoc('mouseup', {});
dragY(hTitlebar, 44, -500);
check('the titlebar clamps to its 36px minimum', h('titlebar') === '36px', h('titlebar'));
fireDoc('mouseup', {});
hTitlebar.fire('dblclick', {});
check('double-click resets the titlebar height', h('titlebar') === '', JSON.stringify(h('titlebar')));

const hSide = sidebar.querySelector('[data-resize="sidebar"]');
const hRail = rail.querySelector('[data-resize="rail"]');
const hPreview = preview.querySelector('[data-resize="preview"]');
check('a sidebar handle is mounted', !!hSide);
// The handle IS the line now; its offset is a CSS fact the shim cannot compute,
// so assert the intent instead: it is tagged with the axis and the side that
// decides the drag sign.
check('the sidebar handle is on the column right edge', (hSide.className).includes('hn-resize-right'));
check('the rail handle is on the column left edge', (rail.querySelector('[data-resize="rail"]').className).includes('hn-resize-left'));
check('a rail handle is mounted', !!hRail);
check('a preview handle is mounted', !!hPreview);

const drag = (handle, from, to) => { handle.fire('mousedown', { button: 0, clientX: from, preventDefault() {} }); fireDoc('mousemove', { clientX: to }); };

check('nothing is set before a drag', w('sidebar') === '');

drag(hSide, 300, 360);
check('dragging the sidebar right widens it 240 → 300', w('sidebar') === '300px', w('sidebar'));
check('the drag marks the body as resizing', body.classList.contains('resizing'));
fireDoc('mouseup', {});
check('the width is persisted on release', store.get('hana-shell-sidebar-width') === '300', store.get('hana-shell-sidebar-width'));
check('the body stops resizing on release', !body.classList.contains('resizing'));

drag(hSide, 300, -2000);
check('the sidebar clamps to its 180px minimum', w('sidebar') === '180px', w('sidebar'));
fireDoc('mouseup', {});

drag(hSide, 300, 5000);
check('the sidebar clamps to its 480px maximum', w('sidebar') === '480px', w('sidebar'));
fireDoc('mouseup', {});

// The rail's handle is on its left edge, so dragging left grows it.
drag(hRail, 800, 700);
check('dragging the rail left widens it 260 → 360', w('rail') === '360px', w('rail'));
fireDoc('mouseup', {});

drag(hRail, 800, 2000);
check('the rail clamps to its 200px minimum', w('rail') === '200px', w('rail'));
fireDoc('mouseup', {});

// The preview's ceiling is dynamic: window − the other columns − conversation.
// 1440 − (240 + 260) − 400 = 540, so a 700 drag must stop at 540.
//
// But the preview starts *collapsed*, and a collapsed column refuses to resize
// (correctly). Open it through the real titlebar toggle first — that is the path
// a user takes, so the test covers the toggle as well as the ceiling.
const previewToggle = host.querySelector('[data-toggle="preview"]');
check('the titlebar has a preview toggle', !!previewToggle);
previewToggle.fire('click', {});
check('the toggle opens the preview', !preview.hasAttribute('data-collapsed'));
drag(hPreview, 800, 100);
check('the preview ceiling accounts for the other columns', w('preview') === '540px', w('preview'));
fireDoc('mouseup', {});

hSide.fire('dblclick', {});
check('double-click resets the sidebar width', w('sidebar') === '', JSON.stringify(w('sidebar')));
check('double-click forgets the stored width', !store.has('hana-shell-sidebar-width'));

// A collapsed column must not start a drag.
const host2 = new El('div');
registered['HanaShell'](host2);
const shell2 = host2.querySelector('.hn-shell') || host2.children[0];
const sidebar2 = host2.querySelector('[data-pane="sidebar"]');
sidebar2._w = 240;
sidebar2.setAttribute('data-collapsed', '');
const hSide2 = sidebar2.querySelector('[data-resize="sidebar"]');
drag(hSide2, 300, 500);
check('a collapsed column does not resize', shell2.style.getPropertyValue('--dw-sidebar-width') === '');
fireDoc('mouseup', {});

console.log(results.join('\n'));
console.log(process.exitCode ? 'FAILED' : 'OK');
