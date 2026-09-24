import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class Style {
  constructor() { this.values = {}; }
  set cssText(value) {
    this.values.cssText = String(value);
    for (const declaration of String(value).split(';')) {
      const [name, rawValue] = declaration.split(':');
      if (name && rawValue) this[name.trim()] = rawValue.trim();
    }
  }
  get cssText() { return this.values.cssText || ''; }
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = new Style();
    this.listeners = new Map();
    this.attrs = {};
    this.src = '';
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  remove() { this.removed = true; }
}

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let nextTimer = 1;
globalThis.setTimeout = (callback) => {
  const id = nextTimer++;
  timers.set(id, callback);
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.window = { __OPENHANAKO_UI_URL__: 'http://127.0.0.1:5173/index.html' };
globalThis.document = { createElement: (tag) => new Element(tag) };

let renderShell;
let markReady;
let hostDetached = false;
let bridgeDetached = false;
const studio = {
  register(_name, render) { renderShell = render; },
  require(name) {
    if (name === 'lib/slots') return { SLOTS: [] };
    if (name === 'lib/bridge') {
      return {
        attach(_frame, _layer, _hosts, options) {
          markReady = options.onReady;
          return () => { bridgeDetached = true; };
        },
      };
    }
    if (name === 'lib/host-bridge') {
      return { attach: () => () => { hostDetached = true; } };
    }
    throw new Error(`unexpected module: ${name}`);
  },
};

try {
  const source = readFileSync(join(ROOT, 'js/entry.js'), 'utf8');
  new Function('studio', source)(studio);
  const host = new Element('div');
  const dispose = renderShell(host);
  const [frame, _layer, recovery] = host.children;

  if (recovery.style.display !== 'none') throw new Error('recovery overlay starts visible');
  if (timers.size !== 1) throw new Error(`expected one recovery timer, got ${timers.size}`);

  const firstTimer = timers.values().next().value;
  timers.clear();
  firstTimer();
  if (recovery.style.display !== 'flex') throw new Error('timeout did not show recovery overlay');
  if (!frame.src.includes('_ohk_retry=1')) throw new Error(`retry URL not cache-busted: ${frame.src}`);
  if (timers.size !== 1) throw new Error('retry did not re-arm health timer');

  markReady();
  if (recovery.style.display !== 'none') throw new Error('ready did not hide recovery overlay');
  if (timers.size !== 0) throw new Error('ready did not stop retries');

  dispose();
  if (!hostDetached || !bridgeDetached) throw new Error('dispose did not detach bridges');
  if (!frame.removed || !recovery.removed) throw new Error('dispose did not remove recovery DOM');
  if (timers.size !== 0) throw new Error('dispose leaked recovery timer');
  console.log('Entry recovery: ok');
} finally {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
