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
  removeEventListener(ev, fn) {
    if (this._ev && this._ev[ev] === fn) delete this._ev[ev];
  }
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
global.MutationObserver = class {
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
};

// --- plugin module loader (mirrors the host's studio.require) ---
const sources = new Map();
for (const name of [
  'lib/dom.js', 'lib/slots.js', 'lib/tauri-invoke.js', 'lib/api.js', 'lib/hana-adapter.js', 'lib/avatar.js',
  'lib/session-search.js', 'lib/session-search-controller.js', 'lib/session-bulk.js', 'lib/session-runtime.js', 'lib/session-row.js', 'lib/session-action-lock.js',
  'lib/theme.js', 'lib/i18n.js', 'lib/resize.js',
  'lib/motion.js', 'lib/tokens.js',
  'panels/titlebar.js', 'panels/sidebar.js', 'panels/conversation.js',
  'panels/preview.js', 'panels/rail.js', 'shell.js',
]) {
  sources.set(name.replace(/\.js$/, ''), readFileSync(join(ROOT, 'js', name), 'utf8'));
}
// fonts.js is generated by build:css and gitignored (~8 MiB). A stub is enough
// for DOM smoke — the shell only needs theme.install() not to throw.
sources.set('lib/fonts', 'return { faces: "", files: {} };');

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
  renderSlot(name, box) {
    if (name === 'openhanako.sidebar.notice') {
      const contribution = document.createElement('div');
      contribution.setAttribute('data-contribution', 'smoke-plugin');
      contribution.textContent = 'Injected notice';
      box.appendChild(contribution);
    }
    return () => {};
  },
};

// --- run ---
const failures = [];
const check = (label, cond) => { if (!cond) failures.push(label); };

const api = studio.require('lib/api');
let streamedSends = 0;
const originalSendWithProgress = api.sendWithProgress;
const originalCancel = api.cancel;
api.sendWithProgress = async (...args) => {
  streamedSends += 1;
  return originalSendWithProgress(...args);
};

const shell = studio.require('shell');
const host = new El('div');
shell.render(host);

const root = host.children[0];
const slotState = studio.require('lib/slots').snapshot();
check('all openhanako manifest slots mount in the shell',
  slotState.total === 17 && slotState.mounted === 17);
check('slot diagnostics detect real contribution nodes',
  slotState.contributions === 1
  && slotState.slots.find((slot) => slot.name === 'openhanako.sidebar.notice')?.hasContribution === true);
check('rail mirrors slot contribution count',
  root.querySelector('.slotSummary')?.getAttribute('data-contributions') === '1');
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
  '.sidebar-bridge-dot', '.sidebar-bridge-status', '.session-list', '.sessionListControls',
  '.sessionSearchInput', '.sessionViewToggle', '.sessionViewBtn', '.sessionSearchStatus',
  '.sessionActionStatus', '.sessionListScroller', '.resize-handle',
  '.main-content', '.chat-area', '.welcome', '.welcomeAvatar', '.welcomeText',
  '.folderSelectWrap', '.folderSelectBtn', '.memoryToggleBtn',
  '.input-area', '.input-surface', '.input-stack', '.input-wrapper', '.input-box',
  '.input-bottom-bar', '.input-actions', '.input-controls', '.attach-btn',
  '.plan-mode-btn', '.model-selector', '.model-pill', '.send-btn', '.send-label',
  '.preview-panel', '.jian-sidebar', '.jian-sidebar-inner', '.workspaceShell',
  '.workspaceCard', '.universal-card', '.workspaceHeader', '.workspaceTitle', '.runtimeSummary', '.slotSummary',
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

// Session management is wired to the adapter: pinning reorders the list and
// archive removes the session from the live sidebar.
{
  for (let i = 0; i < 20 && root.querySelectorAll('.sessionItem').length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const beforeRows = root.querySelectorAll('.sessionItem');
  check('sidebar exposes session management actions',
    beforeRows.length >= 2
    && root.querySelectorAll('.sessionPinBtn').length === beforeRows.length
    && root.querySelectorAll('.sessionArchiveBtn').length === beforeRows.length);
  check('sidebar exposes multi-select controls',
    root.querySelectorAll('.sessionSelectBox').length === beforeRows.length);
  root.querySelector('.sessionBulkSelectVisible')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('select visible chooses every visible session',
    root.querySelectorAll('.sessionSelectBox').length > 0
    && root.querySelectorAll('.sessionSelectBox').every((box) => box.checked === true)
    && /selected/i.test(root.querySelector('.sessionBulkCount')?.textContent || ''));
  root.querySelector('.sessionBulkSelectVisible')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('select visible toggles back to clear visible',
    root.querySelectorAll('.sessionSelectBox').every((box) => box.checked !== true));
  const firstTwo = beforeRows.slice(0, 2);
  firstTwo.forEach((row) => {
    const box = row.querySelector('.sessionSelectBox');
    if (box) {
      box.checked = true;
      box.fire('click');
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('multi-select shows bulk archive action',
    /2 selected/i.test(root.querySelector('.sessionBulkCount')?.textContent || '')
    && /archive selected/i.test(root.querySelector('.sessionBulkPrimary')?.textContent || ''));
  root.querySelector('.sessionBulkClear')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('bulk selection can be cleared',
    /visible/i.test(root.querySelector('.sessionBulkCount')?.textContent || '')
    && root.querySelector('.sessionBulkPrimary')?.style?.display === 'none');

  const target = beforeRows[beforeRows.length - 1];
  let targetTitle = target.querySelector('.sessionItemTitle')?.textContent || '';
  target.querySelector('.sessionPinBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pinnedRows = root.querySelectorAll('.sessionItem');
  check('pinning moves the session to the top',
    pinnedRows[0]?.querySelector('.sessionItemTitle')?.textContent === targetTitle
    && pinnedRows[0]?.querySelector('.sessionPinBtn')?._classes().includes('active'));
  check('pin action reports completion',
    /session pinned/i.test(root.querySelector('.sessionActionStatus')?.textContent || ''));
  check('session rows expose lightweight status metadata',
    root.querySelectorAll('.sessionItemMeta').length === pinnedRows.length
    && root.querySelectorAll('.sessionItemMeta').every((el) => /idle|running|error/i.test(el.textContent)));
  pinnedRows[0]?.querySelector('.sessionDetailsBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('session details expand with identity and runtime metadata',
    root.querySelectorAll('.sessionDetailsPanel').length === 1
    && /Session/.test(root.querySelector('.sessionDetailsPanel')?.textContent || '')
    && /Runtime/.test(root.querySelector('.sessionDetailsPanel')?.textContent || ''));
  root.querySelectorAll('.sessionItem')[0]?.querySelector('.sessionRenameBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  let renameInput = root.querySelector('.sessionRenameInput');
  check('rename action opens inline editor', !!renameInput && root.querySelectorAll('.sessionRenameSave').length === 1);
  renameInput?.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('escape cancels inline rename', root.querySelectorAll('.sessionRenameInput').length === 0);
  root.querySelectorAll('.sessionItem')[0]?.querySelector('.sessionRenameBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  renameInput = root.querySelector('.sessionRenameInput');
  const renamedTitle = 'Renamed smoke session';
  if (renameInput) renameInput.value = renamedTitle;
  renameInput?.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('inline rename persists through adapter',
    root.querySelectorAll('.sessionItemTitle').some((el) => el.textContent === renamedTitle)
    && /session renamed/i.test(root.querySelector('.sessionActionStatus')?.textContent || ''));
  targetTitle = renamedTitle;

  root.querySelectorAll('.sessionItem')[0]?.querySelector('.sessionArchiveBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('archive removes the session from sidebar',
    !root.querySelectorAll('.sessionItemTitle').some((el) => el.textContent === targetTitle));


  const viewButtons = root.querySelectorAll('.sessionViewBtn');
  viewButtons[1]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('archived view lists archived session with restore action',
    root.querySelectorAll('.sessionItemTitle').some((el) => el.textContent === targetTitle)
    && root.querySelectorAll('.sessionRestoreBtn').length >= 1);
  check('archive action reports completion',
    /session archived/i.test(root.querySelector('.sessionActionStatus')?.textContent || ''));
  root.querySelector('.sessionDeleteBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('archived delete requires explicit second confirmation',
    root.querySelectorAll('.sessionItemTitle').some((el) => el.textContent === targetTitle)
    && root.querySelector('.sessionDeleteBtn')?._classes().includes('confirm')
    && /click delete again/i.test(root.querySelector('.sessionActionStatus')?.textContent || ''));
  // Switching views cancels the armed permanent delete.
  viewButtons[0]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  viewButtons[1]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  root.querySelector('.sessionRestoreBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('restore returns archived session to active view',
    root.querySelectorAll('.sessionItemTitle').some((el) => el.textContent === targetTitle)
    && root.querySelectorAll('.sessionRestoreBtn').length === 0);
  check('restore action reports completion',
    /session restored/i.test(root.querySelector('.sessionActionStatus')?.textContent || ''));

  const activeForBulk = root.querySelectorAll('.sessionItem').slice(0, 2);
  activeForBulk.forEach((row) => {
    const box = row.querySelector('.sessionSelectBox');
    if (box) {
      box.checked = true;
      box.fire('click');
    }
  });
  root.querySelector('.sessionBulkPrimary')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('bulk archive moves selected sessions out of active list',
    /sessions archived/i.test(root.querySelector('.sessionActionStatus')?.textContent || ''));
  viewButtons[1]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('archived view offers bulk restore',
    /restore selected/i.test(root.querySelector('.sessionBulkPrimary')?.textContent || '')
    || root.querySelectorAll('.sessionSelectBox').length >= 2);
  root.querySelectorAll('.sessionSelectBox').slice(0, 2).forEach((box) => {
    box.checked = true;
    box.fire('click');
  });
  root.querySelector('.sessionBulkDelete')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('bulk archived delete requires second confirmation',
    /confirm delete/i.test(root.querySelector('.sessionBulkDelete')?.textContent || '')
    && /confirm permanent deletion/i.test(root.querySelector('.sessionActionStatus')?.textContent || ''));
  root.querySelector('.sessionBulkClear')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  root.querySelectorAll('.sessionSelectBox').slice(0, 2).forEach((box) => {
    box.checked = true;
    box.fire('click');
  });
  root.querySelector('.sessionBulkPrimary')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('bulk restore returns to clean archived selection state',
    /sessions restored/i.test(root.querySelector('.sessionActionStatus')?.textContent || '')
    && root.querySelector('.sessionBulkPrimary')?.style?.display === 'none'
    && /visible/i.test(root.querySelector('.sessionBulkCount')?.textContent || ''));
  viewButtons[0]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const keyboardRows = root.querySelectorAll('.sessionItem');
  keyboardRows[0]?.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('arrow key navigation advances keyboard focus state',
    root.querySelectorAll('.sessionItem').some((row, index) =>
      index > 0 && row._classes().includes('sessionItemKeyboard')));

  const search = root.querySelector('.sessionSearchInput');
  search?.fire('input', { target: { value: 'Welcome' } });
  await new Promise((resolve) => setTimeout(resolve, 220));
  check('session search filters active rows',
    root.querySelectorAll('.sessionItemTitle').length >= 1
    && root.querySelectorAll('.sessionItemTitle').every((el) => /welcome/i.test(el.textContent)));
  check('session search highlights matching title text',
    root.querySelectorAll('.sessionSearchHighlight').some((el) => /welcome/i.test(el.textContent)));
  search?.fire('input', { target: { value: '当前窗口' } });
  await new Promise((resolve) => setTimeout(resolve, 220));
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('session search includes transcript content matches',
    root.querySelectorAll('.sessionSearchSnippet').some((el) => /当前窗口/.test(el.textContent))
    && /title \+ message search/i.test(root.querySelector('.sessionSearchStatus')?.textContent || ''));
  check('transcript search highlights matching snippet text',
    root.querySelectorAll('.sessionSearchSnippet .sessionSearchHighlight').length > 0
    || root.querySelectorAll('.sessionSearchHighlight').some((el) => /当前窗口/.test(el.textContent)));
  search?.fire('input', { target: { value: '' } });
  await new Promise((resolve) => setTimeout(resolve, 220));
}

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

// Main shell chat must use the incremental transport rather than the legacy
// whole-turn send path. The mock backend emits thinking + text in chunks.
const smokeInput = root.querySelector('.input-box');
smokeInput.textContent = 'stream smoke';
root.querySelector('.send-btn').fire('click');
await new Promise((resolve) => setTimeout(resolve, 120));
check('conversation uses sendWithProgress', streamedSends === 1);
check('streamed assistant response reaches DOM',
  root.querySelectorAll('.md-content').some((el) => /mock fallback/.test(el.textContent)));
check('streamed thinking reaches DOM', root.querySelectorAll('.thinkingBlock').length > 0);

// Busy chat exposes Stop, calls cancel_agent, and suppresses progress that races
// in after cancellation was requested.
{
  let heldProgress = null;
  let releaseHeld = null;
  let cancelCalls = 0;
  api.sendWithProgress = async (_agentId, _text, _msgId, onProgress) => {
    heldProgress = onProgress;
    onProgress({ kind: 'text_delta', delta: 'before-stop' });
    return new Promise((resolve) => { releaseHeld = () => resolve(true); });
  };
  api.cancel = async () => {
    cancelCalls += 1;
    heldProgress?.({ kind: 'text_delta', delta: 'late-output' });
    return null;
  };

  const cancelHost = new El('div');
  const disposeCancelShell = shell.render(cancelHost);
  const cancelRoot = cancelHost.children[0];
  const cancelInput = cancelRoot.querySelector('.input-box');
  const cancelButton = cancelRoot.querySelector('.send-btn');
  cancelInput.textContent = 'cancel smoke';
  cancelButton.fire('click');
  for (let i = 0; i < 20 && !heldProgress; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check('busy send button becomes Stop',
    cancelButton.getAttribute('data-mode') === 'stop' && /Stop/.test(cancelButton.textContent));
  check('pre-cancel progress is visible',
    cancelRoot.querySelectorAll('.md-content').some((el) => /before-stop/.test(el.textContent)));

  cancelButton.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('Stop invokes cancel once', cancelCalls === 1);
  check('late output after cancel request is suppressed',
    !cancelRoot.querySelectorAll('.md-content').some((el) => /late-output/.test(el.textContent)));
  check('Stop enters stopping state while original turn settles',
    /Stopping/.test(cancelButton.textContent) && cancelButton.disabled === true);

  releaseHeld?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('send button returns after cancelled turn settles',
    cancelButton.getAttribute('data-mode') === 'send' && cancelButton.disabled === false);
  if (typeof disposeCancelShell === 'function') disposeCancelShell();
  api.sendWithProgress = originalSendWithProgress;
  api.cancel = originalCancel;
}

// Model pill is a real selector: new sessions update the pending model, while
// opened sessions use the adapter's rebind-aware switch endpoint.
{
  const adapter = studio.require('lib/hana-adapter');
  const originalHttp = adapter.http;
  const modelCalls = [];
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/models') {
      return {
        models: [
          { id: 'model-1', name: 'Model One', provider: 'provider-a', isCurrent: true },
          { id: 'model-2', name: 'Model Two', provider: 'provider-a', isCurrent: false },
        ],
        activeModel: { id: 'model-1', provider: 'provider-a' },
      };
    }
    if (method === 'POST' && (path === '/api/models/set' || path === '/api/models/switch')) {
      modelCalls.push({ method, path, body });
      return {
        ok: true,
        model: {
          id: body.modelId,
          name: body.modelId === 'model-2' ? 'Model Two' : 'Model One',
          provider: body.provider,
        },
      };
    }
    return originalHttp(method, path, body);
  };

  const modelHost = new El('div');
  const disposeModelShell = shell.render(modelHost);
  const modelRoot = modelHost.children[0];
  await new Promise((resolve) => setTimeout(resolve, 0));
  const modelPill = modelRoot.querySelector('.model-pill');
  check('model pill loads current model label', /Model One/.test(modelPill.textContent));

  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('model dropdown opens with available models',
    modelRoot.querySelector('.model-selector').classList.contains('open')
    && modelRoot.querySelectorAll('.model-option').length === 2);
  modelRoot.querySelectorAll('.model-option')[1].fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('new-session model selection uses pending-model endpoint',
    modelCalls.some((call) => call.path === '/api/models/set'
      && call.body.modelId === 'model-2'
      && call.body.provider === 'provider-a'));
  check('model label updates after selection', /Model Two/.test(modelPill.textContent));

  const firstSession = modelRoot.querySelector('.sessionItem');
  firstSession?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 10));
  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  modelRoot.querySelectorAll('.model-option')[1].fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('opened-session model selection uses rebind-aware switch endpoint',
    modelCalls.some((call) => call.path === '/api/models/switch'
      && /^studio:\/\//.test(call.body.sessionPath || '')
      && call.body.modelId === 'model-2'));

  if (typeof disposeModelShell === 'function') disposeModelShell();
  adapter.http = originalHttp;
}

console.log(`DOM smoke: ${nodes} nodes, ${svgs.length} svg, ${count('.hana-slot')} slots`);
if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('DOM smoke: ok');
