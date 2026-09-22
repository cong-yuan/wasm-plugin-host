// Unit-test lib/resize.js against a tiny DOM stub.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = new Map();
const docListeners = Object.create(null);

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.id = '';
    this.style = {
      _props: Object.create(null),
      setProperty(k, v) { this._props[k] = String(v); },
      removeProperty(k) { delete this._props[k]; },
      getPropertyValue(k) { return this._props[k] || ''; },
    };
    this._listeners = Object.create(null);
  }
  get classList() {
    const self = this;
    return {
      add: (c) => {
        const parts = new Set(self.className.split(/\s+/).filter(Boolean));
        parts.add(c);
        self.className = [...parts].join(' ');
      },
      remove: (c) => {
        self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' ');
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) {
    this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn);
  }
  dispatchEvent(ev) {
    for (const fn of this._listeners[ev.type] || []) fn(ev);
  }
  getBoundingClientRect() {
    const w = Number.parseFloat(this.style.getPropertyValue('width')) || 240;
    return { width: w, height: 800, top: 0, left: 0, right: w, bottom: 800 };
  }
  querySelector(sel) {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      const walk = (el) => {
        if (el.id === id) return el;
        for (const c of el.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    }
    return null;
  }
}

global.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};
global.localStorage = window.localStorage;
global.document = {
  body: new El('body'),
  addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
  removeEventListener: (t, fn) => {
    docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn);
  },
};

const resize = new Function(
  'studio',
  readFileSync(join(ROOT, 'js/lib/resize.js'), 'utf8'),
)({ require: () => ({}) });

const fails = [];
const check = (l, c, d) => { if (!c) fails.push(d ? `${l}: ${d}` : l); };

check('install', typeof resize.install === 'function');
check('wireAll', typeof resize.wireAll === 'function');

const root = new El('div');
const target = new El('aside');
target.id = 'sidebar';
target.style.setProperty('width', '240px');
const handle = new El('div');
handle.id = 'sidebarResizeHandle';
root.children.push(target, handle);

const un = resize.install(handle, { root, target, side: 'sidebar' });
handle.dispatchEvent({
  type: 'mousedown', button: 0, clientX: 240, clientY: 0,
  preventDefault() {}, stopPropagation() {},
});
for (const fn of docListeners.mousemove || []) fn({ clientX: 300, clientY: 0 });
for (const fn of docListeners.mouseup || []) fn({ clientX: 300, clientY: 0 });

const applied = root.style.getPropertyValue('--sidebar-width');
check('width applied', applied === '300px', applied);
check(
  'persisted',
  store.get('openhanako-shell-sidebar-width') === '300',
  store.get('openhanako-shell-sidebar-width'),
);

handle.dispatchEvent({ type: 'dblclick' });
check('reset clears storage', !store.has('openhanako-shell-sidebar-width'));
check('reset clears inline var', !root.style.getPropertyValue('--sidebar-width'));
un();

if (fails.length) {
  for (const f of fails) console.log('FAIL', f);
  process.exit(1);
}
console.log('resize-unit: ok');
