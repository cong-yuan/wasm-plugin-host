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
  focus() { this.focused = true; }
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
  'lib/session-search.js', 'lib/session-search-controller.js', 'lib/session-bulk.js', 'lib/session-runtime.js', 'lib/session-row.js', 'lib/session-row-view.js', 'lib/session-action-lock.js', 'lib/session-mutations.js', 'lib/sidebar-info-panels.js',
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
  check('session rows expose accessibility selection state',
    root.querySelectorAll('.sessionItem').every((el) => ['true', 'false'].includes(el.getAttribute('aria-selected'))));
  pinnedRows[0]?.querySelector('.sessionDetailsBtn')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('session details expand with identity and runtime metadata',
    root.querySelectorAll('.sessionDetailsPanel').length === 1
    && /Session/.test(root.querySelector('.sessionDetailsPanel')?.textContent || '')
    && /Runtime/.test(root.querySelector('.sessionDetailsPanel')?.textContent || ''));
  check('session details expose expanded accessibility state',
    root.querySelector('.sessionDetailsBtn')?.getAttribute('aria-expanded') === 'true'
    && root.querySelector('.sessionItem')?.getAttribute('aria-expanded') === 'true');
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
  check('session view toggle exposes pressed state',
    viewButtons[0]?.getAttribute('aria-pressed') === 'true'
    && viewButtons[1]?.getAttribute('aria-pressed') === 'false');
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
  const visibleBox = root.querySelector('.sessionSelectBox');
  if (visibleBox) {
    visibleBox.checked = true;
    visibleBox.fire('click');
  }
  search?.fire('input', { target: { value: 'no-such-session-visibility-smoke' } });
  await new Promise((resolve) => setTimeout(resolve, 220));
  check('empty filtered list clears visible bulk selection',
    /0 visible/i.test(root.querySelector('.sessionBulkCount')?.textContent || '')
    && root.querySelector('.sessionBulkPrimary')?.style?.display === 'none');
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
check('session files tab states missing session and retains read-only history control',
  root.querySelector('.content')?.getAttribute('data-content-state') === 'empty'
  && /Open a session/.test(root.querySelector('.fileList')?.textContent || ''));
root.querySelectorAll('.tab')[1].fire('click');
check('workspace tab restores runtime/tool diagnostics',
  root.querySelector('.content')?.getAttribute('data-content-state') === 'workspace'
  && root.querySelectorAll('.runtimeMetric').length >= 4);
check('memory control is disabled when standalone bridge cannot enforce it',
  root.querySelector('.memoryToggleBtn')?.disabled === true
  && root.querySelector('.memoryToggleBtn')?._classes().includes('memoryToggleBtnDisabled')
  && /memoryEnabled/.test(root.querySelector('.memoryToggleBtn')?.title || ''));

const settingsButton = root.querySelector('.sidebar-settings-button');
settingsButton?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('settings button opens provider status panel',
  settingsButton?.getAttribute('aria-expanded') === 'true'
  && root.querySelector('.sidebarSettingsPanel')?.style?.display !== 'none');
check('settings provider panel uses safe provider summary',
  /mock/i.test(root.querySelector('.sidebarSettingsPanel')?.textContent || '')
  && !/api[_ -]?key/i.test(root.querySelector('.sidebarSettingsPanel')?.textContent || ''));
const adapterForSettings = studio.require('lib/hana-adapter');
const originalSettingsHttp = adapterForSettings.http;
let settingsRefreshCalls = 0;
adapterForSettings.http = async (method, path, body) => {
  if (method === 'GET' && path === '/api/providers/summary') settingsRefreshCalls += 1;
  return originalSettingsHttp(method, path, body);
};
root.querySelector('.sidebarSettingsRefresh')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('settings refresh reloads provider summary', settingsRefreshCalls === 1);
adapterForSettings.http = originalSettingsHttp;
const originalStatusForSettings = api.status;
const originalConfigForSettings = api.getLlmConfig;
const originalSetConfigForSettings = api.setLlmConfig;
let defaultProviderPatch = null;
let pendingProviderUpdate = null;
adapterForSettings.http = async (method, path, body) => {
  if (method === 'GET' && path === '/api/providers/summary') {
    return {
      providers: {
        providerA: { display_name: 'Provider A', is_configured: true, models: ['a-model'] },
        providerB: { display_name: 'Provider B', is_configured: true, models: ['b-model', 'b-model-2'] },
      },
    };
  }
  if (method === 'POST' && path === '/api/models/set') {
    pendingProviderUpdate = body;
    return { ok: true };
  }
  return originalSettingsHttp(method, path, body);
};
api.status = async () => ({ provider: 'providerA', model: 'a-model', providers: ['providerA', 'providerB'] });
api.getLlmConfig = async () => ({
  default: 'providerA',
  current: { provider: 'providerA', model: 'a-model' },
  providers: {
    providerA: { model: 'a-model' },
    providerB: { model: 'b-model' },
  },
});
api.setLlmConfig = async (patch) => {
  defaultProviderPatch = patch;
  api.getLlmConfig = async () => ({
    default: patch.default,
    current: patch.current,
    providers: {
      providerA: { model: 'a-model' },
      providerB: { model: 'b-model' },
    },
  });
  return { ok: true };
};
root.querySelector('.sidebarSettingsRefresh')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('settings marks provider used for new chats',
  root.querySelectorAll('.sidebarSettingsDefaultBadge').length === 1
  && /New chats/.test(root.querySelector('.sidebarSettingsDefaultBadge')?.textContent || ''));
check('settings exposes model selector for configured providers',
  root.querySelectorAll('.sidebarSettingsModelSelect').length === 2);
const providerBModelSelect = root.querySelectorAll('.sidebarSettingsModelSelect')[1];
if (providerBModelSelect) providerBModelSelect.value = 'b-model-2';
root.querySelectorAll('.sidebar-action-btn')[0]?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
root.querySelectorAll('.sidebarSettingsSetDefault')
  .find((button) => button.getAttribute('data-provider') === 'providerB')
  ?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
check('settings can update provider and model used for new chats',
  defaultProviderPatch?.default === 'providerB'
  && defaultProviderPatch?.current?.provider === 'providerB'
  && defaultProviderPatch?.current?.model === 'b-model-2'
  && pendingProviderUpdate?.provider === 'providerB'
  && pendingProviderUpdate?.modelId === 'b-model-2'
  && root.querySelectorAll('.sidebarSettingsDefaultBadge').length === 1
  && !/api[_ -]?key/i.test(root.querySelector('.sidebarSettingsPanel')?.textContent || ''));
check('settings updates blank new chat model pill immediately',
  /b-model-2/.test(root.querySelector('.model-pill')?.textContent || ''));
api.status = originalStatusForSettings;
api.getLlmConfig = originalConfigForSettings;
api.setLlmConfig = originalSetConfigForSettings;
adapterForSettings.http = originalSettingsHttp;
settingsButton?.fire('click');

const skillsButton = root.querySelector('.sidebar-skills-button');
skillsButton?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('skills button opens host capabilities panel',
  skillsButton?.getAttribute('aria-expanded') === 'true'
  && root.querySelector('.sidebarSkillsPanel')?.style?.display !== 'none');
check('skills panel lists plugins and tools from host api',
  /openhanako-shell/.test(root.querySelector('.sidebarSkillsPanel')?.textContent || '')
  && /read_file/.test(root.querySelector('.sidebarSkillsPanel')?.textContent || ''));
const originalToolsForSkills = api.tools;
api.tools = async () => [
  ...(await originalToolsForSkills()),
  { name: 'dynamic_tool', description: 'hot reload smoke' },
];
root.querySelector('.sidebarSkillsRefresh')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('skills refresh reloads hot-added tools',
  /dynamic_tool/.test(root.querySelector('.sidebarSkillsPanel')?.textContent || ''));
api.tools = originalToolsForSkills;
skillsButton?.fire('click');
check('skills button closes capabilities panel',
  skillsButton?.getAttribute('aria-expanded') === 'false'
  && root.querySelector('.sidebarSkillsPanel')?.style?.display === 'none');

const activityButton = root.querySelector('.sidebar-activity-button');
activityButton?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('activity button opens runtime panel',
  activityButton?.getAttribute('aria-expanded') === 'true'
  && root.querySelector('.sidebarActivityPanel')?.style?.display !== 'none');
check('activity panel lists runtime sessions',
  /session/.test(root.querySelector('.sidebarActivityPanel')?.textContent || '')
  && /Welcome|Page design sketch/.test(root.querySelector('.sidebarActivityPanel')?.textContent || ''));
check('activity panel exposes direct session open action',
  root.querySelectorAll('.sidebarActivityOpen').length >= 1);
const firstActivityOpen = root.querySelector('.sidebarActivityOpen');
firstActivityOpen?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 10));
check('activity Open closes panel after successful navigation',
  activityButton?.getAttribute('aria-expanded') === 'false'
  && root.querySelector('.sidebarActivityPanel')?.style?.display === 'none');
activityButton?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
const sidebarModuleForFailedActivityOpen = studio.require('panels/sidebar');
const failedActivitySide = sidebarModuleForFailedActivityOpen.render({
  selected: null,
  onNew() {},
  onCollapse() {},
  async onSelect() { return false; },
});
await failedActivitySide.refresh(null);
const failedActivityButton = failedActivitySide.root.querySelector('.sidebar-activity-button');
failedActivityButton?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
failedActivitySide.root.querySelector('.sidebarActivityOpen')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('activity Open stays visible when navigation fails',
  failedActivityButton?.getAttribute('aria-expanded') === 'true'
  && failedActivitySide.root.querySelector('.sidebarActivityPanel')?.style?.display !== 'none');
check('activity Open surfaces navigation failure inline',
  /Unable to open session/.test(failedActivitySide.root.querySelector('.sidebarActivityPanel')?.textContent || ''));
failedActivitySide.destroy?.();

const adapterForActivity = studio.require('lib/hana-adapter');
const originalActivityHttp = adapterForActivity.http;
let activityRefreshCalls = 0;
adapterForActivity.http = async (method, path, body) => {
  if (method === 'GET' && path === '/api/runtime-state') activityRefreshCalls += 1;
  return originalActivityHttp(method, path, body);
};
root.querySelector('.sidebarActivityRefresh')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('activity refresh reloads runtime snapshot', activityRefreshCalls === 1);
adapterForActivity.http = originalActivityHttp;
const originalCancelForActivity = api.cancel;
let activityStopCalls = 0;
adapterForActivity.http = async (method, path, body) => {
  if (method === 'GET' && path === '/api/runtime-state') {
    return {
      mode: 'mock',
      sessions: [{
        sessionId: 'activity-running',
        title: 'Running activity session',
        status: 'running',
        isStreaming: true,
      }],
    };
  }
  return originalActivityHttp(method, path, body);
};
api.cancel = async (id) => {
  activityStopCalls += id === 'activity-running' ? 1 : 0;
};
root.querySelector('.sidebarActivityRefresh')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('activity panel exposes Stop for running sessions',
  root.querySelectorAll('.sidebarActivityStop').length === 1);
root.querySelector('.sidebarActivityStop')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('activity Stop cancels running session', activityStopCalls === 1);
api.cancel = originalCancelForActivity;
adapterForActivity.http = originalActivityHttp;
const runtimeResolvers = [];
adapterForActivity.http = async (method, path, body) => {
  if (method === 'GET' && path === '/api/runtime-state') {
    const index = runtimeResolvers.length;
    return new Promise((resolve) => {
      runtimeResolvers.push(() => resolve({
        mode: 'mock',
        sessions: [{
          sessionId: `race-${index}`,
          title: index === 0 ? 'Old runtime snapshot' : 'New runtime snapshot',
          status: 'idle',
        }],
      }));
    });
  }
  return originalActivityHttp(method, path, body);
};
root.querySelector('.sidebarActivityRefresh')?.fire('click');
activityButton?.fire('click');
activityButton?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
runtimeResolvers[1]?.();
await new Promise((resolve) => setTimeout(resolve, 0));
check('newer activity request wins race',
  /New runtime snapshot/.test(root.querySelector('.sidebarActivityPanel')?.textContent || ''));
runtimeResolvers[0]?.();
await new Promise((resolve) => setTimeout(resolve, 0));
check('stale activity request cannot overwrite newer snapshot',
  /New runtime snapshot/.test(root.querySelector('.sidebarActivityPanel')?.textContent || '')
  && !/Old runtime snapshot/.test(root.querySelector('.sidebarActivityPanel')?.textContent || ''));
adapterForActivity.http = originalActivityHttp;
skillsButton?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('skills and activity panels are mutually exclusive',
  root.querySelector('.sidebarActivityPanel')?.style?.display === 'none'
  && activityButton?.getAttribute('aria-expanded') === 'false'
  && skillsButton?.getAttribute('aria-expanded') === 'true');
skillsButton?.fire('click');

// Sidebar draws use a generation guard so a slower older sessions request
// cannot overwrite a newer refresh.
{
  const sidebarModule = studio.require('panels/sidebar');
  const adapterForSidebarRace = studio.require('lib/hana-adapter');
  const originalSidebarRaceHttp = adapterForSidebarRace.http;
  let sessionRequestCount = 0;
  let releaseOldSessions = null;
  adapterForSidebarRace.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/sessions') {
      sessionRequestCount += 1;
      if (sessionRequestCount === 1) {
        return new Promise((resolve) => {
          releaseOldSessions = () => resolve([
            { sessionId: 'old-sidebar-row', title: 'Old sidebar snapshot', status: 'idle' },
          ]);
        });
      }
      return [{ sessionId: 'new-sidebar-row', title: 'New sidebar snapshot', status: 'idle' }];
    }
    return originalSidebarRaceHttp(method, path, body);
  };

  const raceSide = sidebarModule.render({
    selected: null,
    onNew() {},
    onCollapse() {},
    onSelect() {},
  });
  await raceSide.refresh(null);
  check('newer sidebar draw renders before stale request resolves',
    /New sidebar snapshot/.test(raceSide.root.textContent || ''));
  releaseOldSessions?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('stale sidebar draw cannot overwrite newer refresh',
    /New sidebar snapshot/.test(raceSide.root.textContent || '')
    && !/Old sidebar snapshot/.test(raceSide.root.textContent || ''));

  raceSide.destroy?.();
  adapterForSidebarRace.http = originalSidebarRaceHttp;
}

// Search input changes must invalidate a pending failed search immediately,
// before the next debounced query begins, and teardown must not paint late data.
{
  const sidebarModule = studio.require('panels/sidebar');
  const adapterForSearchRace = studio.require('lib/hana-adapter');
  const originalHttp = adapterForSearchRace.http;
  let rejectOldSearch = null;
  adapterForSearchRace.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/sessions') {
      return [{ sessionId: 'local', title: 'Local title' }];
    }
    if (method === 'GET' && path === '/api/runtime-state') return { mode: 'studio', sessions: [] };
    if (method === 'GET' && path.startsWith('/api/sessions/search?')) {
      if (path.includes('q=older') && path.includes('phase=content')) {
        return new Promise((_resolve, reject) => { rejectOldSearch = reject; });
      }
      if (path.includes('q=older')) return { results: [] };
      if (path.includes('q=latest')) {
        return { results: [{ sessionId: 'latest', title: 'Latest session', matchKind: 'title' }] };
      }
      return { results: [] };
    }
    return originalHttp(method, path, body);
  };
  const side = sidebarModule.render({ selected: null, onNew() {}, onCollapse() {}, onSelect() {} });
  await side.refresh(null);
  const input = side.root.querySelector('.sessionSearchInput');
  const status = side.root.querySelector('.sessionSearchStatus');
  input.value = 'older';
  input.fire('input', { target: input });
  await new Promise((resolve) => setTimeout(resolve, 220));
  check('sidebar search begins remote phases', typeof rejectOldSearch === 'function');
  input.value = 'latest';
  input.fire('input', { target: input });
  rejectOldSearch?.(new Error('delayed old search failed'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('obsolete failed search cannot overwrite pending new search',
    status?.textContent === 'Waiting for typing…');
  await new Promise((resolve) => setTimeout(resolve, 220));
  check('newer query wins after obsolete request rejects',
    /Latest session/.test(side.root.textContent || '')
    && !/Message search unavailable/.test(status?.textContent || ''));
  side.destroy?.();
  adapterForSearchRace.http = originalHttp;
}

// A destructive batch confirmation must be invalidated by checkbox edits.
// Mutations in flight must not overwrite a user's newer selection.
{
  const sidebarModule = studio.require('panels/sidebar');
  const adapterForBatch = studio.require('lib/hana-adapter');
  const originalHttp = adapterForBatch.http;
  const deletedIds = [];
  let finishRestore = null;
  adapterForBatch.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/sessions') return [];
    if (method === 'GET' && path === '/api/sessions/archived') return [
      { sessionId: 'archived-a', title: 'Archived A', archivedAt: '2026-01-01' },
      { sessionId: 'archived-b', title: 'Archived B', archivedAt: '2026-01-02' },
    ];
    if (method === 'GET' && path === '/api/runtime-state') return { mode: 'studio', sessions: [] };
    if (method === 'POST' && path === '/api/sessions/archived/delete') {
      deletedIds.push(body.sessionId);
      return { ok: true, sessionId: body.sessionId };
    }
    if (method === 'POST' && path === '/api/sessions/restore') {
      return new Promise((resolve) => { finishRestore = resolve; });
    }
    return originalHttp(method, path, body);
  };
  const side = sidebarModule.render({ selected: null, onNew() {}, onCollapse() {}, onSelect() {} });
  side.root.querySelectorAll('.sessionViewBtn')[1]?.fire('click');
  await side.refresh(null);
  const selections = side.root.querySelectorAll('.sessionSelectBox');
  check('archived search test exposes two sessions', selections.length === 2);
  for (const checkbox of selections) {
    checkbox.checked = true;
    checkbox.fire('click', { stopPropagation() {} });
  }
  const del = side.root.querySelector('.sessionBulkDelete');
  del?.fire('click');
  check('batch delete arms with current selection', /Confirm delete/.test(del?.textContent || ''));
  selections[0].checked = false;
  selections[0].fire('click', { stopPropagation() {} });
  check('changing checkbox revokes destructive batch confirmation',
    !/Confirm delete/.test(del?.textContent || ''));
  del?.fire('click');
  await Promise.resolve();
  check('first click after selection change never deletes', deletedIds.length === 0);

  const restore = side.root.querySelector('.sessionBulkPrimary');
  restore?.fire('click');
  await Promise.resolve();
  check('selected batch restore is pending', typeof finishRestore === 'function');
  // While restore runs, change selection; the old batch must not rewrite it.
  selections[0].checked = true;
  selections[0].fire('click', { stopPropagation() {} });
  finishRestore?.({ ok: false, error: 'retry later' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('async batch completion preserves newer checkbox selections',
    /2 selected/.test(side.root.querySelector('.sessionBulkCount')?.textContent || ''));
  side.destroy?.();
  adapterForBatch.http = originalHttp;
}

// Keyboard and mouse range selection must operate on real sidebar rows, with
// visible-only commands and no interference with input controls.
{
  const sidebar = studio.require('panels/sidebar');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const active = [
    { sessionId: 'keyboard-a', title: 'Alpha', modified: '2026-10-03' },
    { sessionId: 'keyboard-b', title: 'Beta', modified: '2026-10-02' },
    { sessionId: 'keyboard-c', title: 'Gamma', modified: '2026-10-01' },
  ];
  let openings = 0;
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/sessions') return active;
    if (method === 'GET' && path === '/api/sessions/archived') return active;
    if (method === 'GET' && path === '/api/runtime-state') return { sessions: [], mode: 'studio' };
    return oldHttp(method, path, body);
  };
  const side = sidebar.render({ selected: null, onNew() {}, onCollapse() {}, onSelect() { openings += 1; } });
  await side.refresh(null);
  const rows = () => side.root.querySelectorAll('.sessionItem');
  const count = () => side.root.querySelector('.sessionBulkCount')?.textContent;
  const evt = (target, extra = {}) => ({ target, preventDefault() {}, stopPropagation() {}, ...extra });
  check('sidebar has a single keyboard Tab stop at first visible row',
    rows().filter((el) => el.getAttribute('tabindex') === '0').length === 1
    && rows()[0].getAttribute('tabindex') === '0');
  await side.refresh('keyboard-b');
  check('active chat uses aria-current and supplies the default Tab stop',
    rows()[1]?.getAttribute('aria-current') === 'page'
    && rows()[1]?.getAttribute('tabindex') === '0'
    && rows()[0]?.getAttribute('aria-current') === null);
  await side.refresh(null);

  rows()[0]?.fire('click', evt(rows()[0], { ctrlKey: true }));
  await side.refresh(null);
  check('Ctrl-click toggles a row without opening a session', count() === '1 selected' && openings === 0);
  rows()[2]?.fire('click', evt(rows()[2], { shiftKey: true }));
  await side.refresh(null);
  check('Shift-click selects the visible interval', count() === '3 selected');
  rows()[1]?.fire('keydown', evt(rows()[1], { key: 'Escape' }));
  await side.refresh(null);
  check('Escape clears batch selection', count() === '3 visible');
  rows()[1]?.fire('keydown', evt(rows()[1], { key: 'a', metaKey: true }));
  await side.refresh(null);
  check('Cmd+A selects all visible sessions', count() === '3 selected');
  rows()[2]?.fire('keydown', evt(rows()[2], { key: ' ' }));
  await side.refresh(null);
  check('Space toggles one session checkbox', count() === '2 selected');
  rows()[2]?.fire('keydown', evt(rows()[2], { key: 'Home', shiftKey: true }));
  await side.refresh(null);
  check('Shift+Home extends selection to the first row', count() === '3 selected');
  rows()[0]?.fire('keydown', evt(rows()[0], { key: 'End' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('End moves focus to the last visible row without opening a session',
    rows()[2]?.focused === true && openings === 0);
  check('roving tabindex follows the focused row and exposes shortcuts',
    rows()[2]?.getAttribute('tabindex') === '0'
    && rows()[0]?.getAttribute('tabindex') === '-1'
    && /Home End/.test(rows()[2]?.getAttribute('aria-keyshortcuts') || ''));
  rows()[1]?.fire('keydown', evt(new El('input'), { key: 'Escape' }));
  check('shortcuts ignore nested editable input', count() === '3 selected');
  rows()[1]?.fire('click', evt(new El('button'), { ctrlKey: true }));
  check('row modifier click ignores nested action button', count() === '3 selected');
  rows()[1]?.fire('click', evt(rows()[1]));
  check('unmodified active row click still opens the session', openings === 1);
  await side.refresh(null);
  // Checkbox Shift-click also updates the other checkboxes, not only the count.
  rows()[0]?.querySelector('.sessionSelectBox')?.fire('click', evt(rows()[0], { shiftKey: true }));
  await side.refresh(null);
  check('Shift checkbox range redraws selected interval from last clicked row',
    rows()[0]?.querySelector('.sessionSelectBox')?.checked === true
    && rows()[1]?.querySelector('.sessionSelectBox')?.checked === true
    && rows()[2]?.querySelector('.sessionSelectBox')?.checked === false);

  side.root.querySelectorAll('.sessionViewBtn')[1]?.fire('click');
  await side.refresh(null);
  rows()[0]?.fire('keydown', evt(rows()[0], { key: 'Enter' }));
  await side.refresh(null);
  check('archived row Enter toggles selection without opening', count() === '1 selected' && openings === 1);
  rows()[0]?.fire('keydown', evt(rows()[0], { key: 'Escape' }));
  await side.refresh(null);
  check('archived row Escape clears selection', count() === '3 visible');

  side.destroy?.();
  adapter.http = oldHttp;
}

// Archived cleanup requires an exact backend preview, explicit confirmation,
// and does not retain stale previews across changes to retention or view.
{
  const sidebar = studio.require('panels/sidebar');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  let archiveRows = [{ sessionId: 'old-archive', title: 'Old archive', archivedAt: '2025-01-01' }];
  let deleteCalls = 0;
  let planCalls = 0;
  let makeStale = false;
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/sessions') return [];
    if (method === 'GET' && path === '/api/sessions/archived') return archiveRows;
    if (method === 'GET' && path === '/api/runtime-state') return { sessions: [], mode: 'studio' };
    if (method === 'POST' && path === '/api/sessions/cleanup') {
      if (body.dryRun === true) {
        planCalls += 1;
        return { ok: true, dryRun: true, count: archiveRows.length,
          sessionIds: archiveRows.map((row) => row.sessionId) };
      }
      deleteCalls += 1;
      if (makeStale) return { ok: false, code: 'preview_changed', error: 'Preview stale' };
      if (body.maxAgeDays !== 30 || body.expectedSessionIds?.join(',') !== 'old-archive') {
        return { ok: false, error: 'wrong cleanup snapshot' };
      }
      archiveRows = [];
      return { ok: true, deleted: 1, failed: 0 };
    }
    return oldHttp(method, path, body);
  };
  const side = sidebar.render({ selected: null, onNew() {}, onCollapse() {}, onSelect() {} });
  await side.refresh(null);
  const cleanup = side.root.querySelector('.sessionCleanupButton');
  const age = side.root.querySelector('.sessionCleanupAge');
  const cancel = side.root.querySelector('.sessionCleanupCancel');
  const status = side.root.querySelector('.sessionCleanupStatus');
  check('cleanup is unavailable in the active view',
    side.root.querySelector('.sessionCleanupBar')?.style?.display === 'none');
  side.root.querySelectorAll('.sessionViewBtn')[1]?.fire('click');
  await side.refresh(null);
  check('cleanup controls are shown only for archived sessions',
    side.root.querySelector('.sessionCleanupBar')?.style?.display === '');
  age.value = '0';
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('zero day retention fails before contacting backend', planCalls === 0 && deleteCalls === 0);
  age.value = '30';
  age.fire('input');
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('preview requests candidate list without deleting',
    planCalls === 1 && deleteCalls === 0 && /Confirm delete 1/.test(cleanup.textContent));
  cancel.fire('click');
  check('Cancel revokes archive deletion confirmation',
    /Preview cleanup/.test(cleanup.textContent) && deleteCalls === 0);
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  age.value = '31';
  age.fire('input');
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('changing age forces a new preview instead of submitting prior plan',
    planCalls === 3 && deleteCalls === 0);
  side.root.querySelectorAll('.sessionViewBtn')[0]?.fire('click');
  await side.refresh(null);
  check('view change invalidates destructive confirmation',
    /Preview cleanup/.test(cleanup.textContent));
  side.root.querySelectorAll('.sessionViewBtn')[1]?.fire('click');
  await side.refresh(null);
  age.value = '30';
  age.fire('input');
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  makeStale = true;
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('backend conflict does not report deletion as successful',
    deleteCalls === 1 && /Preview stale/.test(side.root.querySelector('.sessionActionStatus')?.textContent || '')
    && /Preview cleanup/.test(cleanup.textContent) && status.textContent === '');
  makeStale = false;
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanup.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('confirmed exact preview deletes and rehydrates archived list',
    deleteCalls === 2 && archiveRows.length === 0
    && /permanently deleted/.test(side.root.querySelector('.sessionActionStatus')?.textContent || ''));
  side.destroy?.();
  adapter.http = oldHttp;
}

// Rapid session switching must keep the newest transcript when an older
// transcript request resolves later.
{
  const originalTranscript = api.transcript;
  const switchHost = new El('div');
  const disposeSwitchShell = shell.render(switchHost);
  const switchRoot = switchHost.children[0];
  for (let i = 0; i < 20 && switchRoot.querySelectorAll('.sessionItem').length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  let releaseOldTranscript = null;
  api.transcript = async (id) => {
    if (id === 'sess-welcome') {
      return new Promise((resolve) => {
        releaseOldTranscript = () => resolve([
          { role: 'assistant', text: 'stale welcome transcript' },
        ]);
      });
    }
    if (id === 'sess-sketch') {
      return [{ role: 'assistant', text: 'latest sketch transcript' }];
    }
    return originalTranscript(id);
  };
  switchRoot.querySelector('[data-session-id="sess-welcome"]')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  switchRoot.querySelector('[data-session-id="sess-sketch"]')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('newest session transcript renders before stale request resolves',
    switchRoot.querySelectorAll('.md-content').some((el) => /latest sketch transcript/.test(el.textContent)));
  releaseOldTranscript?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('stale session transcript cannot overwrite newer selection',
    switchRoot.querySelectorAll('.md-content').some((el) => /latest sketch transcript/.test(el.textContent))
    && !switchRoot.querySelectorAll('.md-content').some((el) => /stale welcome transcript/.test(el.textContent)));

  if (typeof disposeSwitchShell === 'function') disposeSwitchShell();
  api.transcript = originalTranscript;
}

// IME composition Enter must not submit while the user is confirming a
// composition candidate.
{
  const originalProgress = api.sendWithProgress;
  let imeSends = 0;
  api.sendWithProgress = async () => { imeSends += 1; return true; };

  const imeHost = new El('div');
  const disposeImeShell = shell.render(imeHost);
  const imeRoot = imeHost.children[0];
  const imeInput = imeRoot.querySelector('.input-box');
  imeInput.textContent = '中文输入';
  imeInput.fire('keydown', {
    key: 'Enter',
    isComposing: true,
    preventDefault() { throw new Error('composing Enter should not prevent default'); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('IME composing Enter does not submit', imeSends === 0 && imeInput.textContent === '中文输入');

  if (typeof disposeImeShell === 'function') disposeImeShell();
  api.sendWithProgress = originalProgress;
}

check('unsupported standalone controls are explicitly disabled',
  root.querySelector('.folderSelectBtn')?.disabled === true
  && root.querySelectorAll('.attach-btn').filter((button) => !button.classList.contains('nativeSlashButton')).every((button) => button.disabled === true)
  && root.querySelector('.plan-mode-btn')?.disabled === true);
check('unsupported controls explain why they are disabled',
  /does not expose authorized folder/.test(root.querySelector('.folderSelectBtn')?.title || '')
  && root.querySelectorAll('.attach-btn')[2]?.disabled !== true
  && /enforce/.test(root.querySelector('.plan-mode-btn')?.title || ''));
check('unsupported automation control is explicitly disabled',
  root.querySelector('.automation-count-badge')?.parentNode?.disabled === true
  || root.querySelectorAll('.sidebar-activity-bar').some((button) =>
    button.disabled && /Automations/.test(button.title || '')));

// Main shell chat must use the incremental transport rather than the legacy
// whole-turn send path. The mock backend emits thinking + text in chunks.
const originalPluginsForRefresh = api.plugins;
const originalToolsForRefresh = api.tools;
const originalStatusForRefresh = api.status;
const adapterForShellRefresh = studio.require('lib/hana-adapter');
const originalHttpForRefresh = adapterForShellRefresh.http;
let capabilityRefreshCalls = 0;
let runtimeRefreshCalls = 0;
api.plugins = async () => { capabilityRefreshCalls += 1; return originalPluginsForRefresh(); };
api.tools = async () => { capabilityRefreshCalls += 1; return originalToolsForRefresh(); };
api.status = async () => { capabilityRefreshCalls += 1; return originalStatusForRefresh(); };
adapterForShellRefresh.http = async (method, path, body) => {
  if (method === 'GET' && path === '/api/runtime-state') runtimeRefreshCalls += 1;
  return originalHttpForRefresh(method, path, body);
};
const smokeInput = root.querySelector('.input-box');
smokeInput.textContent = 'stream smoke';
root.querySelector('.send-btn').fire('click');
await new Promise((resolve) => setTimeout(resolve, 120));
check('conversation uses sendWithProgress', streamedSends === 1);
check('streamed assistant response reaches DOM',
  root.querySelectorAll('.md-content').some((el) => /mock fallback/.test(el.textContent)));
check('streamed thinking reaches DOM', root.querySelectorAll('.thinkingBlock').length > 0);
await new Promise((resolve) => setTimeout(resolve, 180));
check('streaming refresh does not reload static capabilities', capabilityRefreshCalls === 0);
check('streaming refresh coalesces runtime work',
  runtimeRefreshCalls >= 1 && runtimeRefreshCalls <= 2);
api.plugins = originalPluginsForRefresh;
api.tools = originalToolsForRefresh;
api.status = originalStatusForRefresh;
adapterForShellRefresh.http = originalHttpForRefresh;

// New live sessions pass only the selected provider so api.create can resolve
// the configured current model instead of treating the provider name as a model.
{
  const originalPickProvider = api.pickProvider;
  const originalCreate = api.create;
  const originalProgress = api.sendWithProgress;
  let createArgs = null;
  api.pickProvider = async () => 'deepseek';
  api.create = async (...args) => {
    createArgs = args;
    return 'provider-model-session';
  };
  api.sendWithProgress = async () => true;

  const providerHost = new El('div');
  const disposeProviderShell = shell.render(providerHost);
  const providerRoot = providerHost.children[0];
  const providerInput = providerRoot.querySelector('.input-box');
  providerInput.textContent = 'provider model smoke';
  providerRoot.querySelector('.send-btn').fire('click');
  for (let i = 0; i < 20 && !createArgs; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check('new session lets api.create resolve configured model',
    createArgs?.[0] === 'deepseek' && createArgs.length === 1);

  if (typeof disposeProviderShell === 'function') disposeProviderShell();
  api.pickProvider = originalPickProvider;
  api.create = originalCreate;
  api.sendWithProgress = originalProgress;
}

// New Chat clears unsent draft state and transient model feedback.
{
  const draftHost = new El('div');
  const disposeDraftShell = shell.render(draftHost);
  const draftRoot = draftHost.children[0];
  const draftInput = draftRoot.querySelector('.input-box');
  draftInput.textContent = 'unsent draft';
  const draftModelStatus = draftRoot.querySelector('.model-switch-status');
  draftModelStatus.textContent = 'temporary model error';
  draftModelStatus.className = 'model-switch-status error';
  draftRoot.querySelectorAll('.sidebar-action-btn')[0]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('new chat clears unsent composer draft',
    !(draftRoot.querySelector('.input-box')?.textContent || '').trim());
  check('new chat clears transient model status',
    !(draftRoot.querySelector('.model-switch-status')?.textContent || '').trim());

  if (typeof disposeDraftShell === 'function') disposeDraftShell();
}

// A create_agent result that arrives after New Chat must be discarded and
// disposed instead of silently attaching the stale session to the fresh chat.
{
  const originalPickProvider = api.pickProvider;
  const originalCreate = api.create;
  const originalDispose = api.dispose;
  let releaseCreate = null;
  const disposedIds = [];
  api.pickProvider = async () => 'deepseek';
  api.create = async () => new Promise((resolve) => {
    releaseCreate = () => resolve('stale-created-session');
  });
  api.dispose = async (id) => { disposedIds.push(id); };

  const staleCreateHost = new El('div');
  const disposeStaleCreateShell = shell.render(staleCreateHost);
  const staleCreateRoot = staleCreateHost.children[0];
  const staleCreateInput = staleCreateRoot.querySelector('.input-box');
  const staleCreateSend = staleCreateRoot.querySelector('.send-btn');
  staleCreateInput.textContent = 'stale create smoke';
  staleCreateSend.fire('click');
  for (let i = 0; i < 20 && !releaseCreate; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  staleCreateRoot.querySelectorAll('.sidebar-action-btn')[0]?.fire('click');
  releaseCreate?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  check('stale create result is disposed after new chat',
    disposedIds.includes('stale-created-session'));
  check('stale create cannot reattach to fresh conversation',
    staleCreateRoot.querySelectorAll('.md-content').length === 0
    && staleCreateSend.getAttribute('data-mode') === 'send');

  if (typeof disposeStaleCreateShell === 'function') disposeStaleCreateShell();
  api.pickProvider = originalPickProvider;
  api.create = originalCreate;
  api.dispose = originalDispose;
}

// Session opening locks composer/model controls until transcript hydration settles.
{
  const originalTranscript = api.transcript;
  const originalProgress = api.sendWithProgress;
  let releaseOpenTranscript = null;
  let sendsWhileOpening = 0;
  api.transcript = async (id) => new Promise((resolve) => {
    releaseOpenTranscript = async () => resolve(await originalTranscript(id));
  });
  api.sendWithProgress = async () => {
    sendsWhileOpening += 1;
    return true;
  };

  const openingHost = new El('div');
  const disposeOpeningShell = shell.render(openingHost);
  const openingRoot = openingHost.children[0];
  for (let i = 0; i < 20 && openingRoot.querySelectorAll('.sessionItem').length < 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  openingRoot.querySelector('.sessionItem')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const openingSend = openingRoot.querySelector('.send-btn');
  const openingInput = openingRoot.querySelector('.input-box');
  check('session open locks send and model controls',
    openingSend.getAttribute('data-mode') === 'opening'
    && openingSend.disabled === true
    && openingRoot.querySelector('.model-pill')?.disabled === true);
  openingInput.textContent = 'must not send during open';
  openingSend.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('composer cannot send while session is opening', sendsWhileOpening === 0);
  await releaseOpenTranscript?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('session open unlocks controls after hydration',
    openingSend.getAttribute('data-mode') === 'send'
    && openingSend.disabled === false
    && openingRoot.querySelector('.model-pill')?.disabled === false);

  if (typeof disposeOpeningShell === 'function') disposeOpeningShell();
  api.transcript = originalTranscript;
  api.sendWithProgress = originalProgress;
}

// Failed session opens roll back to the previous conversation instead of
// leaving a new session id paired with stale message content.
{
  const originalTranscript = api.transcript;
  const openFailureHost = new El('div');
  const disposeOpenFailureShell = shell.render(openFailureHost);
  const openFailureRoot = openFailureHost.children[0];
  for (let i = 0; i < 20 && openFailureRoot.querySelectorAll('.sessionItem').length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const openRows = openFailureRoot.querySelectorAll('.sessionItem');
  openRows[0]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const beforeFailureText = openFailureRoot.querySelector('.message-stream')?.textContent || '';
  const failedId = openRows[1]?.getAttribute('data-session-id');
  api.transcript = async (id) => {
    if (id === failedId) throw new Error('transcript unavailable');
    return originalTranscript(id);
  };
  openRows[1]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('failed session open preserves previous conversation',
    (openFailureRoot.querySelector('.message-stream')?.textContent || '') === beforeFailureText);
  check('failed session open exposes visible error state',
    /could not open session/i.test(openFailureRoot.querySelector('.conversation-status')?.textContent || '')
    && /transcript unavailable/i.test(openFailureRoot.querySelector('.conversation-status')?.textContent || ''));
  const originalProgressAfterOpenFailure = api.sendWithProgress;
  api.sendWithProgress = async () => true;
  const preservedInput = openFailureRoot.querySelector('.input-box');
  preservedInput.textContent = 'continue after open failure';
  openFailureRoot.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('continuing previous conversation clears stale open error',
    !(openFailureRoot.querySelector('.conversation-status')?.textContent || '').trim());
  api.sendWithProgress = originalProgressAfterOpenFailure;

  if (typeof disposeOpenFailureShell === 'function') disposeOpenFailureShell();
  api.transcript = originalTranscript;
}

// Session creation failures must restore the composer instead of leaving
// the conversation stuck in busy/Stop mode.
{
  const originalPickProvider = api.pickProvider;
  const originalCreate = api.create;
  api.pickProvider = async () => 'deepseek';
  api.create = async () => { throw new Error('create failed'); };

  const failureHost = new El('div');
  const disposeFailureShell = shell.render(failureHost);
  const failureRoot = failureHost.children[0];
  const failureInput = failureRoot.querySelector('.input-box');
  const failureSend = failureRoot.querySelector('.send-btn');
  failureInput.textContent = 'creation failure smoke';
  failureSend.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('session creation failure restores send state',
    failureSend.getAttribute('data-mode') === 'send' && failureSend.disabled === false);
  check('session creation failure is visible in conversation',
    failureRoot.querySelectorAll('.md-content').some((el) => /create failed/.test(el.textContent)));
  check('session creation failure exposes retry action',
    failureRoot.querySelectorAll('.messageRetryBtn').length === 1);
  api.create = async () => 'retry-created-session';
  const originalProgress = api.sendWithProgress;
  let retrySendCalls = 0;
  api.sendWithProgress = async () => {
    retrySendCalls += 1;
    return true;
  };
  failureRoot.querySelector('.messageRetryBtn')?.fire('click');
  for (let i = 0; i < 20 && retrySendCalls === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check('retry action resubmits failed user turn without manual re-entry',
    retrySendCalls === 1
    && failureRoot.querySelectorAll('.messageRetryBtn').length === 0
    && failureRoot.querySelectorAll('.messageUser').filter((el) => /creation failure smoke/.test(el.textContent)).length === 1);
  api.sendWithProgress = originalProgress;

  if (typeof disposeFailureShell === 'function') disposeFailureShell();
  api.pickProvider = originalPickProvider;
  api.create = originalCreate;
}

// New Chat during an in-flight turn resets composer state and invalidates
// late progress/finally work from the previous conversation.
{
  const originalProgress = api.sendWithProgress;
  const originalCancel = api.cancel;
  let heldProgress = null;
  let releaseHeld = null;
  let resetCancelCalls = 0;
  api.sendWithProgress = async (_agentId, _text, _msgId, onProgress) => {
    heldProgress = onProgress;
    onProgress({ kind: 'text_delta', delta: 'old-session-output' });
    return new Promise((resolve) => { releaseHeld = () => resolve(true); });
  };
  api.cancel = async () => { resetCancelCalls += 1; };

  const resetHost = new El('div');
  const disposeResetShell = shell.render(resetHost);
  const resetRoot = resetHost.children[0];
  const resetInput = resetRoot.querySelector('.input-box');
  const resetSend = resetRoot.querySelector('.send-btn');
  resetInput.textContent = 'reset during send';
  resetSend.fire('click');
  for (let i = 0; i < 20 && !heldProgress; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  resetRoot.querySelectorAll('.sidebar-action-btn')[0]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('new chat restores send state during in-flight turn',
    resetSend.getAttribute('data-mode') === 'send' && resetSend.disabled === false);
  check('new chat clears previous conversation immediately',
    resetRoot.querySelectorAll('.md-content').length === 0);
  check('new chat best-effort cancels previous live session', resetCancelCalls === 1);

  heldProgress?.({ kind: 'text_delta', delta: 'late-reset-output' });
  releaseHeld?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('late progress after new chat is ignored',
    !resetRoot.querySelectorAll('.md-content').some((el) => /late-reset-output|old-session-output/.test(el.textContent))
    && resetSend.getAttribute('data-mode') === 'send');

  if (typeof disposeResetShell === 'function') disposeResetShell();
  api.sendWithProgress = originalProgress;
  api.cancel = originalCancel;
}

// An empty transport result is retryable when no assistant output arrived.
{
  const originalProgress = api.sendWithProgress;
  const originalTranscript = api.transcript;
  api.sendWithProgress = async () => false;
  api.transcript = async () => [];

  const emptyResponseHost = new El('div');
  const disposeEmptyResponseShell = shell.render(emptyResponseHost);
  const emptyResponseRoot = emptyResponseHost.children[0];
  const emptyResponseInput = emptyResponseRoot.querySelector('.input-box');
  emptyResponseInput.textContent = 'empty response smoke';
  emptyResponseRoot.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('empty response exposes retry action',
    emptyResponseRoot.querySelectorAll('.messageRetryBtn').length === 1
    && emptyResponseRoot.querySelectorAll('[data-message-state="error"]').length === 1);

  if (typeof disposeEmptyResponseShell === 'function') disposeEmptyResponseShell();
  api.sendWithProgress = originalProgress;
  api.transcript = originalTranscript;
}

// A send failure with no partial assistant output is retryable in place.
{
  const originalProgress = api.sendWithProgress;
  let attempts = 0;
  api.sendWithProgress = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('send failed');
    return true;
  };

  const sendFailureHost = new El('div');
  const disposeSendFailureShell = shell.render(sendFailureHost);
  const sendFailureRoot = sendFailureHost.children[0];
  const sendFailureInput = sendFailureRoot.querySelector('.input-box');
  sendFailureInput.textContent = 'send retry smoke';
  sendFailureRoot.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('failed send is marked retryable',
    sendFailureRoot.querySelectorAll('[data-message-state="error"]').length === 1
    && sendFailureRoot.querySelectorAll('.messageRetryBtn').length === 1);

  sendFailureRoot.querySelector('.messageRetryBtn')?.fire('click');
  for (let i = 0; i < 20 && attempts < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check('failed send retry resubmits once without duplicate user message',
    attempts === 2
    && sendFailureRoot.querySelectorAll('.messageUser').filter((el) => /send retry smoke/.test(el.textContent)).length === 1
    && sendFailureRoot.querySelectorAll('.messageRetryBtn').length === 0);

  if (typeof disposeSendFailureShell === 'function') disposeSendFailureShell();
  api.sendWithProgress = originalProgress;
}

// A lagging transcript snapshot must not overwrite the just-streamed local turn.
{
  const originalProgress = api.sendWithProgress;
  const originalTranscript = api.transcript;

  const staleTranscriptHost = new El('div');
  const disposeStaleTranscriptShell = shell.render(staleTranscriptHost);
  const staleTranscriptRoot = staleTranscriptHost.children[0];
  await new Promise((resolve) => setTimeout(resolve, 0));

  api.sendWithProgress = async (_agentId, _text, _msgId, onProgress) => {
    onProgress({ kind: 'text_delta', delta: 'fresh streamed response' });
    return true;
  };
  api.transcript = async () => [
    { role: 'user', text: 'older prompt' },
    { role: 'assistant', text: 'older answer' },
  ];

  const staleTranscriptInput = staleTranscriptRoot.querySelector('.input-box');
  staleTranscriptInput.textContent = 'latest prompt';
  staleTranscriptRoot.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('lagging transcript cannot overwrite latest local turn',
    staleTranscriptRoot.querySelectorAll('.md-content').some((el) => /fresh streamed response/.test(el.textContent))
    && staleTranscriptRoot.querySelectorAll('.md-content').some((el) => /latest prompt/.test(el.textContent))
    && !staleTranscriptRoot.querySelectorAll('.md-content').some((el) => /older answer/.test(el.textContent)));

  if (typeof disposeStaleTranscriptShell === 'function') disposeStaleTranscriptShell();
  api.sendWithProgress = originalProgress;
  api.transcript = originalTranscript;
}

// Repeating the same prompt must not make a shorter stale snapshot look current.
{
  const originalProgress = api.sendWithProgress;
  const originalTranscript = api.transcript;

  const repeatedPromptHost = new El('div');
  const disposeRepeatedPromptShell = shell.render(repeatedPromptHost);
  const repeatedPromptRoot = repeatedPromptHost.children[0];
  for (let i = 0; i < 20 && repeatedPromptRoot.querySelectorAll('.sessionItem').length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  api.transcript = async () => [
    { role: 'user', text: 'repeat me' },
    { role: 'assistant', text: 'old repeated answer' },
  ];
  repeatedPromptRoot.querySelector('[data-session-id="sess-welcome"]')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('repeated-prompt test starts from existing history',
    repeatedPromptRoot.querySelectorAll('.md-content').some((el) => /old repeated answer/.test(el.textContent)));

  api.sendWithProgress = async (_agentId, _text, _msgId, onProgress) => {
    onProgress({ kind: 'text_delta', delta: 'new repeated answer' });
    return true;
  };

  const repeatedPromptInput = repeatedPromptRoot.querySelector('.input-box');
  repeatedPromptInput.textContent = 'repeat me';
  repeatedPromptRoot.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('shorter repeated-prompt snapshot is treated as stale',
    repeatedPromptRoot.querySelectorAll('.md-content').some((el) => /new repeated answer/.test(el.textContent))
    && repeatedPromptRoot.querySelectorAll('.md-content').filter((el) => /old repeated answer/.test(el.textContent)).length === 1);

  if (typeof disposeRepeatedPromptShell === 'function') disposeRepeatedPromptShell();
  api.sendWithProgress = originalProgress;
  api.transcript = originalTranscript;
}

// A final transcript refresh failure must not erase content that already
// arrived through the streaming transport.
{
  const originalProgress = api.sendWithProgress;
  const originalTranscript = api.transcript;

  const transcriptFailureHost = new El('div');
  const disposeTranscriptFailureShell = shell.render(transcriptFailureHost);
  const transcriptFailureRoot = transcriptFailureHost.children[0];
  await new Promise((resolve) => setTimeout(resolve, 0));

  api.sendWithProgress = async (_agentId, _text, _msgId, onProgress) => {
    onProgress({ kind: 'text_delta', delta: 'streamed answer survives' });
    return true;
  };
  api.transcript = async () => { throw new Error('transcript refresh failed'); };

  const transcriptFailureInput = transcriptFailureRoot.querySelector('.input-box');
  transcriptFailureInput.textContent = 'transcript failure smoke';
  transcriptFailureRoot.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('streamed answer survives transcript refresh failure',
    transcriptFailureRoot.querySelectorAll('.md-content').some((el) => /streamed answer survives/.test(el.textContent))
    && !transcriptFailureRoot.querySelectorAll('.md-content').some((el) => /transcript refresh failed/.test(el.textContent)));

  if (typeof disposeTranscriptFailureShell === 'function') disposeTranscriptFailureShell();
  api.sendWithProgress = originalProgress;
  api.transcript = originalTranscript;
}

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

// Cancel failures must restore an actionable Stop state and surface the error.
{
  const originalProgress = api.sendWithProgress;
  const originalCancel = api.cancel;
  let releaseTurn = null;
  let cancelAttempts = 0;
  api.sendWithProgress = async () => new Promise((resolve) => {
    releaseTurn = () => resolve(true);
  });
  api.cancel = async () => {
    cancelAttempts += 1;
    if (cancelAttempts === 1) throw new Error('cancel failed');
    return null;
  };

  const cancelFailureHost = new El('div');
  const disposeCancelFailureShell = shell.render(cancelFailureHost);
  const cancelFailureRoot = cancelFailureHost.children[0];
  const cancelFailureInput = cancelFailureRoot.querySelector('.input-box');
  const cancelFailureButton = cancelFailureRoot.querySelector('.send-btn');
  cancelFailureInput.textContent = 'cancel failure smoke';
  cancelFailureButton.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelFailureButton.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('cancel failure restores Stop button for another attempt',
    cancelAttempts === 1
    && cancelFailureButton.getAttribute('data-mode') === 'stop'
    && cancelFailureButton.disabled === false
    && /cancel failed/.test(cancelFailureRoot.textContent || ''));

  cancelFailureButton.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('cancel can be retried after failure', cancelAttempts === 2);
  releaseTurn?.();
  await new Promise((resolve) => setTimeout(resolve, 20));

  if (typeof disposeCancelFailureShell === 'function') disposeCancelFailureShell();
  api.sendWithProgress = originalProgress;
  api.cancel = originalCancel;
}

// Model pill is a real selector: new sessions update the pending model, while
// opened sessions use the adapter's rebind-aware switch endpoint.
{
  const adapter = studio.require('lib/hana-adapter');
  const originalHttp = adapter.http;
  const modelCalls = [];
  let holdModelSwitch = false;
  let releaseModelSwitch = null;
  let failModelSwitch = false;
  let mismatchedModelAck = false;
  let failModelLoad = false;
  let malformedModelLoad = false;
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/models')) {
      if (failModelLoad) throw new Error('model list unavailable');
      if (malformedModelLoad) return { ok: false, error: 'model discovery denied', models: [] };
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
      if (failModelSwitch) throw new Error('model switch unavailable');
      if (mismatchedModelAck) return { ok: true, model: { id: 'wrong-model', provider: body.provider } };
      if (holdModelSwitch) {
        return new Promise((resolve) => {
          releaseModelSwitch = () => resolve({
            ok: true,
            model: {
              id: body.modelId,
              name: body.modelId === 'model-2' ? 'Model Two' : 'Model One',
              provider: body.provider,
            },
          });
        });
      }
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
  check('model selector exposes expanded accessibility state', modelPill.getAttribute('aria-expanded') === 'true');
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

  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  holdModelSwitch = true;
  const beforeHeldSwitches = modelCalls.length;
  const heldOption = modelRoot.querySelectorAll('.model-option')[0];
  heldOption.fire('click');
  heldOption.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('model switch lock prevents duplicate rebind requests',
    modelCalls.length === beforeHeldSwitches + 1
    && modelRoot.querySelector('.model-selector')?.getAttribute('aria-busy') === 'true'
    && modelPill.disabled === true);
  releaseModelSwitch?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('model switch lock releases controls after completion',
    modelRoot.querySelector('.model-selector')?.getAttribute('aria-busy') === 'false'
    && modelPill.disabled === false);
  holdModelSwitch = false;

  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  failModelSwitch = true;
  modelRoot.querySelectorAll('.model-option')[1]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('model switch failure exposes visible status without replacing current label',
    /model switch failed/i.test(modelRoot.querySelector('.model-switch-status')?.textContent || '')
    && /Model One/.test(modelPill.textContent));
  failModelSwitch = false;
  mismatchedModelAck = true;
  modelRoot.querySelectorAll('.model-option')[1]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('wrong-target model acknowledgement fails closed',
    /not acknowledged/i.test(modelRoot.querySelector('.model-switch-status')?.textContent || '')
    && /Model One/.test(modelPill.textContent));
  mismatchedModelAck = false;

  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  failModelLoad = true;
  modelPill.fire('click');
  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('closing during model refresh keeps closed popup closed',
    modelRoot.querySelector('.model-selector')?.classList.contains('open') === false);
  check('cancelled model load clears pending status and expanded state',
    modelPill.getAttribute('aria-expanded') === 'false'
    && !/Loading models/.test(modelRoot.querySelector('.model-switch-status')?.textContent || ''));
  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('failed model refresh removes stale model options',
    modelRoot.querySelectorAll('.model-option').length === 1
    && modelRoot.querySelector('.model-option')?.getAttribute('data-model-state') === 'unavailable');
  failModelLoad = false;
  malformedModelLoad = true;
  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('model discovery fails closed on HTTP error payload with an empty model list',
    /model discovery denied/.test(modelRoot.querySelector('.model-switch-status')?.textContent || '')
    && modelRoot.querySelectorAll('.model-option').length === 1);
  malformedModelLoad = false;

  failModelLoad = true;
  const modelLoadFailureHost = new El('div');
  const disposeModelLoadFailureShell = shell.render(modelLoadFailureHost);
  const modelLoadFailureRoot = modelLoadFailureHost.children[0];
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('initial model load failure exposes visible status',
    /models unavailable/i.test(modelLoadFailureRoot.querySelector('.model-switch-status')?.textContent || '')
    && /model list unavailable/i.test(modelLoadFailureRoot.querySelector('.model-switch-status')?.textContent || ''));
  if (typeof disposeModelLoadFailureShell === 'function') disposeModelLoadFailureShell();
  failModelLoad = false;

  if (typeof disposeModelShell === 'function') disposeModelShell();
  adapter.http = originalHttp;
}

// Model-list responses from an obsolete conversation must not repaint a newly
// selected session, and an abandoned popup must not reopen after an async load.
{
  const conversation = studio.require('panels/conversation');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const originalTranscript = api.transcript;
  let releaseOldModels;
  let releasePopup;
  let pausePopup = false;
  const oldModels = new Promise((resolve) => { releaseOldModels = resolve; });
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/models') {
      return oldModels;
    }
    if (method === 'GET' && path.startsWith('/api/models?sessionPath=')) {
      if (pausePopup) return new Promise((resolve) => { releasePopup = resolve; });
      return { models: [{ id: 'current', provider: 'p', name: 'Current Session Model', isCurrent: true }],
        activeModel: { id: 'current', provider: 'p' } };
    }
    return oldHttp(method, path, body);
  };
  api.transcript = async () => [];
  const panel = conversation.render({ onChanged() {}, onOpened() {}, onCreated() {} });
  const selected = await panel.open({ id: 'new-session-model', live: true });
  check('new session hydrates its own model before obsolete initial load',
    selected === true && /Current Session Model/.test(panel.root.querySelector('.model-pill')?.textContent || ''));
  releaseOldModels?.({ models: [{ id: 'old', provider: 'p', name: 'Stale Model', isCurrent: true }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('outdated model list cannot overwrite current session',
    /Current Session Model/.test(panel.root.querySelector('.model-pill')?.textContent || '')
    && !/Stale Model/.test(panel.root.querySelector('.model-pill')?.textContent || ''));
  const pill = panel.root.querySelector('.model-pill');
  pausePopup = true;
  pill.fire('click');
  await Promise.resolve();
  check('model popup fetch started before cancel', typeof releasePopup === 'function');
  pill.fire('click');
  releasePopup?.({ models: [{ id: 'late', name: 'Late Model', provider: 'p', isCurrent: true }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('closing model popup invalidates delayed fetch and prevents reopen',
    panel.root.querySelector('.model-selector')?.classList.contains('open') === false
    && /Current Session Model/.test(pill.textContent || ''));
  panel.reset();
  adapter.http = oldHttp;
  api.transcript = originalTranscript;
}

// Native authorized folders are session-scoped, capability gated, and
// require backend acknowledgments before changing the visible projection.
{
  const conversation = studio.require('panels/conversation');
  const adapter = studio.require('lib/hana-adapter');
  const originalHttp = adapter.http;
  const originalCapability = api.sessionFolderScopeAvailable;
  const originalTranscript = api.transcript;
  api.sessionFolderScopeAvailable = () => true;
  api.transcript = async () => [];
  let folders = ['/work/project'];
  let loadCount = 0;
  const patchCalls = [];
  let rejectPatch = false;
  let partialPatch = false;
  let pendingRead = null;
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/models')) return { models: [], activeModel: null };
    if (method === 'GET' && path.startsWith('/api/sessions/authorized-folders?')) {
      loadCount += 1;
      if (pendingRead) return new Promise((resolve) => { pendingRead.resolve = resolve; });
      return { ok: true, authorizedFolders: folders.slice() };
    }
    if (method === 'PATCH' && path === '/api/sessions/authorized-folders') {
      patchCalls.push(body);
      if (rejectPatch) return { ok: false, error: 'Permission denied' };
      if (partialPatch) return { ok: true, authorizedFolders: folders.slice() };
      folders = body.action === 'add'
        ? Array.from(new Set([...folders, body.folder]))
        : folders.filter((folder) => folder !== body.folder);
      return { ok: true, authorizedFolders: folders.slice() };
    }
    return originalHttp(method, path, body);
  };
  const panel = conversation.render({ onChanged() {}, onOpened() {}, onCreated() {} });
  const scopeBtn = panel.root.querySelector('.sessionFolderScopeBtn');
  const scope = panel.root.querySelector('.sessionFolderScopePanel');
  const status = panel.root.querySelector('.sessionFolderScopeStatus');
  const path = panel.root.querySelector('.sessionFolderScopePath');
  const add = panel.root.querySelector('.sessionFolderScopeAdd');
  const refresh = panel.root.querySelector('.sessionFolderScopeRefresh');
  check('authorized-folder editor enabled only with backend capability', scopeBtn?.disabled !== true);
  scopeBtn?.fire('click');
  check('cannot mutate folder scope without an open session',
    scope.style.display === 'none' && patchCalls.length === 0);
  await panel.open({ id: 'folder-session-a', live: true });
  scopeBtn.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('authorized folder editor reads real session scope',
    loadCount === 1 && /work\/project/.test(scope.textContent)
    && scopeBtn.getAttribute('aria-expanded') === 'true');
  path.value = 'relative/unsafe';
  add.fire('click');
  check('relative folder path is rejected before a PATCH',
    patchCalls.length === 0 && /absolute directory path/.test(status.textContent));
  path.value = '/work/extra';
  rejectPatch = true;
  add.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('failed folder PATCH never claims success or mutates visible list',
    patchCalls.length === 1 && /Permission denied/.test(status.textContent)
    && !/work\/extra/.test(scope.textContent));
  rejectPatch = false;
  partialPatch = true;
  add.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('unconfirmed successful response does not claim folder authorization',
    patchCalls.length === 2 && /not confirmed/.test(status.textContent)
    && !/work\/extra/.test(scope.textContent));
  partialPatch = false;
  add.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('successful acknowledged folder addition updates native list',
    patchCalls.length === 3 && /work\/extra/.test(scope.textContent)
    && /Folder authorized/.test(status.textContent));
  const remove = panel.root.querySelectorAll('.sessionFolderScopeRemove')[1];
  remove?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('authorized folder removal issues remove and updates list',
    patchCalls[3]?.action === 'remove' && patchCalls[3]?.folder === '/work/extra'
    && !/work\/extra/.test(scope.textContent));
  pendingRead = {};
  refresh.fire('click');
  await Promise.resolve();
  check('folder refresh waits on backend response', typeof pendingRead.resolve === 'function');
  await panel.open({ id: 'folder-session-b', live: true });
  pendingRead.resolve({ ok: true, authorizedFolders: ['/stale/other-session'] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('stale folder fetch after session switch cannot leak prior session scope',
    scope.style.display === 'none' && !/stale\/other-session/.test(scope.textContent));
  panel.reset();
  adapter.http = originalHttp;
  api.sessionFolderScopeAvailable = originalCapability;
  api.transcript = originalTranscript;
}

// Streamed assistant text and tools must remain in causal order rather than
// moving all text before all tools. A single authoritative reply retains it.
{
  const conversation = studio.require('panels/conversation');
  const originalSend = api.sendWithProgress;
  const originalTranscript = api.transcript;
  let completed = false;
  const earlier = [{ role: 'user', text: 'earlier prompt' }, { role: 'assistant', text: 'Earlier reply' }];
  api.transcript = async () => completed
    ? [...earlier, { role: 'user', text: 'timeline prompt' }, { role: 'assistant', text: 'Before tool After tool',
      tool_calls: [
        { id: 'tool-first', name: 'lookup' },
        { id: 'tool-second', name: 'search' },
      ],
      tool_results: [
        { tool_call_id: 'tool-first', content: 'done' },
        { tool_call_id: 'tool-second', content: 'bad', is_error: true },
      ] }]
    : earlier.map((row) => ({ ...row }));
  api.sendWithProgress = async (_id, _text, _msgId, progress) => {
    progress({ kind: 'text_delta', delta: 'Before tool ' });
    progress({ kind: 'tool_start', id: 'tool-first', name: 'lookup' });
    progress({ kind: 'tool_end', id: 'tool-first', success: true, output: 'done' });
    progress({ kind: 'text_delta', delta: 'After tool' });
    // Some providers emit only tool_end for a tool; it must still be visible.
    progress({ kind: 'tool_end', id: 'tool-second', name: 'search', success: false, error: 'bad' });
    completed = true;
    return true;
  };
  const panel = conversation.render({ onChanged() {}, onOpened() {}, onCreated() {} });
  await panel.open({ id: 'tool-timeline', live: true });
  panel.root.querySelector('.input-box').textContent = 'timeline prompt';
  panel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rendered = panel.root.querySelectorAll('.messageGroupAssistant').at(-1);
  const sequence = (rendered?.children || []).map((node) => {
    if (node._classes?.().includes('message')) return node.textContent.trim();
    if (node._classes?.().includes('toolGroup')) return node.textContent.trim();
    return '';
  }).filter(Boolean).join(' | ');
  check('text and tools render in actual incremental event order after transcript hydration',
    /Before tool.*\|.*lookup.*\|.*After tool.*\|.*search/.test(sequence));
  check('completion-only tool is visible as a failed tool rather than disappearing',
    rendered?.querySelectorAll('.toolGroup').some((item) =>
      item.getAttribute('data-tool-state') === 'failed'
      && /search/.test(item.textContent)));
  check('chronological rendering does not duplicate streamed assistant text',
    (sequence.match(/Before tool/g) || []).length === 1
    && (sequence.match(/After tool/g) || []).length === 1);
  check('stream timeline survives authoritative hydration with prior chat history',
    panel.root.querySelectorAll('.messageGroupAssistant').length === 2
    && panel.root.querySelectorAll('.md-content').some((node) => node.textContent === 'Earlier reply'));
  // A failure after a tool starts must remain readable, not be hidden because
  // the timeline already contains earlier text/tool segments.
  api.transcript = async () => [];
  api.sendWithProgress = async (_id, _text, _msgId, progress) => {
    progress({ kind: 'text_delta', delta: 'Partial before failure' });
    progress({ kind: 'tool_start', id: 'broken-tool', name: 'broken' });
    throw new Error('Transport failed after tool');
  };
  panel.reset();
  await panel.open({ id: 'error-timeline', live: true });
  panel.root.querySelector('.input-box').textContent = 'error prompt';
  panel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('post-tool transport error remains visible after partial text and tool',
    panel.root.querySelectorAll('.md-content').some((node) => /Partial before failure/.test(node.textContent))
    && panel.root.querySelectorAll('.md-content').some((node) => /Transport failed after tool/.test(node.textContent))
    && panel.root.querySelectorAll('.toolGroup').some((node) => /broken/.test(node.textContent)));
  panel.reset();
  api.sendWithProgress = originalSend;
  api.transcript = originalTranscript;
}

// File staging is local until a real Studio upload succeeds. Image bytes are
// forwarded only when the native multimodal command is available.
{
  const conversation = studio.require('panels/conversation');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const oldUploadCapability = api.uploadBlobAvailable;
  const oldImageCapability = api.sendImagesAvailable;
  const oldSend = api.sendWithProgress;
  const oldTranscript = api.transcript;
  const calls = [];
  const sent = [];
  let rejectUpload = false;
  let rejectUploadName = '';
  let malformedUpload = false;
  let delayedUploadResolve = null;
  api.uploadBlobAvailable = () => true;
  api.sendImagesAvailable = () => true;
  api.transcript = async () => [];
  api.sendWithProgress = async (_sessionId, text, _msgId, onProgress, options) => {
    sent.push({ text, options });
    onProgress({ kind: 'text_delta', delta: 'File processed' });
    return true;
  };
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/models')) return { models: [] };
    if (method === 'POST' && path === '/api/upload-blob') {
      calls.push(body);
      if (rejectUpload || body.name === rejectUploadName) return { ok: false, error: 'Native file upload denied' };
      if (malformedUpload) return { ok: true, uploads: [{ fileId: 3, dest: {} }] };
      if (body.name === 'delayed.txt') return new Promise((resolve) => { delayedUploadResolve = resolve; });
      return { ok: true, uploads: [{ fileId: `blob-${calls.length}`, dest: `/native/files/${body.name}` }] };
    }
    return oldHttp(method, path, body);
  };
  const makeFile = (name, data, type = 'text/plain') => ({
    name, type, size: Buffer.byteLength(data),
    async arrayBuffer() {
      const bytes = new TextEncoder().encode(data);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  });
  const panel = conversation.render({ onChanged() {}, onOpened() {}, onCreated() {} });
  const chooser = panel.root.querySelector('.nativeAttachmentChooser');
  const attachBtn = panel.root.querySelectorAll('.attach-btn')[0];
  const chips = () => panel.root.querySelectorAll('.nativeAttachmentChip');
  check('native upload capability enables file attachment picker', attachBtn.disabled === false);
  chooser.files = [makeFile('note.txt', 'hello'), makeFile('photo.png', 'image bytes', 'image/png')];
  chooser.fire('change');
  check('selected file and image appear as removable chips before upload',
    chips().length === 2 && calls.length === 0);
  chips()[0]?.querySelector('.nativeAttachmentRemove')?.fire('click');
  check('user can remove a selected file before upload', chips().length === 1 && calls.length === 0);
  chooser.files = [{ name: 'huge.bin', size: 11 * 1024 * 1024, type: 'application/octet-stream',
    arrayBuffer: async () => new ArrayBuffer(0) }];
  chooser.fire('change');
  check('oversized files are rejected and existing selection preserved',
    chips().length === 1 && /10 MiB/.test(panel.root.querySelector('.nativeAttachmentList')?.textContent || ''));
  chooser.files = [makeFile('note.txt', 'hello')];
  chooser.fire('change');
  await panel.open({ id: 'attachment-session', live: true });
  // Opening another session intentionally resets pending files; reselect.
  chooser.files = [makeFile('note.txt', 'hello'), makeFile('photo.png', 'image bytes', 'image/png')];
  chooser.fire('change');
  panel.root.querySelector('.input-box').textContent = 'Check attachments';
  panel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('native file uploads have owning session and verified destinations',
    calls.length === 2 && calls.every((call) => call.sessionId === 'attachment-session')
    && /\/native\/files\/note.txt/.test(sent[0]?.text || '')
    && /\/native\/files\/photo.png/.test(sent[0]?.text || ''));
  check('image attachments use native multimodal transport when supported',
    sent[0]?.options?.images?.length === 1
    && sent[0].options.images[0].mimeType === 'image/png'
    && sent[0].options.images[0].data === btoa('image bytes'));
  check('staged attachment chips clear after successful message send', chips().length === 0);
  rejectUpload = true;
  chooser.files = [makeFile('denied.txt', 'secret')];
  chooser.fire('change');
  panel.root.querySelector('.input-box').textContent = 'Upload denied';
  panel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('rejected upload never sends message and preserves file for retry',
    calls.length === 3 && sent.length === 1 && chips().length === 1
    && /Native file upload denied/.test(panel.root.querySelector('.nativeAttachmentList')?.textContent || ''));
  rejectUpload = false;
  chips()[0]?.querySelector('.nativeAttachmentRemove')?.fire('click');
  const reusedFile = makeFile('reused.txt', 'one');
  const retriedFile = makeFile('retried.txt', 'two');
  chooser.files = [reusedFile, retriedFile];
  chooser.fire('change');
  rejectUploadName = 'retried.txt';
  panel.root.querySelector('.input-box').textContent = 'First attempt';
  panel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('partial upload failure retains both chips and blocks sending',
    calls.length === 5 && sent.length === 1 && chips().length === 2);
  rejectUploadName = '';
  panel.root.querySelector('.input-box').textContent = 'Retry attempt';
  panel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('retry reuses acknowledged local file instead of uploading it twice',
    calls.length === 6 && calls.filter((call) => call.name === 'reused.txt').length === 1
    && calls.filter((call) => call.name === 'retried.txt').length === 2
    && sent.length === 2 && chips().length === 0);
  malformedUpload = true;
  chooser.files = [makeFile('bad-ack.txt', 'text')];
  chooser.fire('change');
  panel.root.querySelector('.input-box').textContent = 'Invalid acknowledgement';
  panel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('malformed success cannot turn non-path upload metadata into a message',
    calls.length === 7 && sent.length === 2 && chips().length === 1);
  malformedUpload = false;
  panel.reset();
  const oldProvider = api.pickProvider;
  const oldCreate = api.create;
  api.pickProvider = async () => 'mock';
  api.create = async () => 'created-file-session';
  const newPanel = conversation.render({ onChanged() {}, onOpened() {}, onCreated() {} });
  const newChooser = newPanel.root.querySelector('.nativeAttachmentChooser');
  newChooser.files = [makeFile('created.txt', 'fresh')];
  newChooser.fire('change');
  newPanel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('first message creates a real session before sending file to native host',
    calls.length === 8 && calls.at(-1)?.sessionId === 'created-file-session'
    && sent.length === 3 && /created.txt/.test(sent.at(-1).text));
  newPanel.reset();
  await newPanel.open({ id: 'delayed-file-session', live: true });
  newChooser.files = [makeFile('delayed.txt', 'pending')];
  newChooser.fire('change');
  newPanel.root.querySelector('.input-box').textContent = 'Old session attachment';
  newPanel.root.querySelector('.send-btn').fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('file send can be paused during native upload', typeof delayedUploadResolve === 'function');
  newPanel.reset();
  delayedUploadResolve?.({ ok: true, uploads: [{ fileId: 'late-file', dest: '/native/files/delayed.txt' }] });
  await new Promise((resolve) => setTimeout(resolve, 15));
  check('reset while upload is pending ignores late upload and never sends stale turn',
    sent.length === 3 && newPanel.root.querySelectorAll('.nativeAttachmentChip').length === 0);
  const oldCancel = api.cancel;
  let stoppedUploads = 0;
  api.cancel = async () => { stoppedUploads += 1; };
  await newPanel.open({ id: 'cancel-file-session', live: true });
  newChooser.files = [makeFile('delayed.txt', 'pending again')];
  newChooser.fire('change');
  newPanel.root.querySelector('.input-box').textContent = 'Cancel during upload';
  const sendControl = newPanel.root.querySelector('.send-btn');
  sendControl.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  sendControl.fire('click');
  delayedUploadResolve?.({ ok: true, uploads: [{ fileId: 'stop-file', dest: '/native/files/delayed.txt' }] });
  await new Promise((resolve) => setTimeout(resolve, 15));
  check('Stop during upload prevents subsequent message send and retains retryable file',
    stoppedUploads === 1 && sent.length === 3
    && newPanel.root.querySelectorAll('.nativeAttachmentChip').length === 1);
  api.cancel = oldCancel;
  newPanel.reset();

  api.pickProvider = oldProvider;
  api.create = oldCreate;
  check('reset clears staged files from previous conversation', chips().length === 0);
  adapter.http = oldHttp;
  api.uploadBlobAvailable = oldUploadCapability;
  api.sendImagesAvailable = oldImageCapability;
  api.sendWithProgress = oldSend;
  api.transcript = oldTranscript;
}

// Studio-backed summary, compaction and TODO actions are confirmed, single-
// flight, capability-gated operations scoped to the currently selected session.
{
  const conversation = studio.require('panels/conversation');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const oldTranscript = api.transcript;
  const capabilities = {
    freshCompactSessionAvailable: api.freshCompactSessionAvailable,
    completeSessionTodosAvailable: api.completeSessionTodosAvailable,
    sessionSummaryAvailable: api.sessionSummaryAvailable,
  };
  api.freshCompactSessionAvailable = () => true;
  api.completeSessionTodosAvailable = () => true;
  api.sessionSummaryAvailable = () => true;
  api.transcript = async () => [];
  let compactions = 0;
  let completions = 0;
  let denyCompact = false;
  let holdCompact = false;
  let releaseHeldCompact;
  let malformedTodos = false;
  let holdSummary = false;
  let resolveSummary;
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/models')) return { models: [] };
    if (method === 'GET' && path.startsWith('/api/sessions/summary?')) {
      if (holdSummary) return new Promise((resolve) => { resolveSummary = resolve; });
      return { hasSummary: true, summary: 'Persisted compact summary' };
    }
    if (method === 'POST' && path === '/api/sessions/fresh-compact') {
      compactions += 1;
      if (holdCompact) return new Promise((resolve) => { releaseHeldCompact = resolve; });
      if (denyCompact) return { ok: false, error: 'Context compact denied' };
      return { ok: true, fresh: true };
    }
    if (method === 'POST' && path === '/api/sessions/todos/complete') {
      completions += 1;
      if (malformedTodos) return { ok: true, todos: [{ status: 'pending' }], completed: [] };
      return { ok: true, todos: [], completed: [{ content: 'draft', status: 'completed' }] };
    }
    return oldHttp(method, path, body);
  };
  const panel = conversation.render({ onChanged() {}, onOpened() {}, onCreated() {} });
  const toggle = panel.root.querySelector('.sessionToolsButton');
  const tools = panel.root.querySelector('.sessionToolsPanel');
  const summary = panel.root.querySelector('.sessionToolsSummary');
  const compact = panel.root.querySelector('.sessionToolsCompact');
  const todos = panel.root.querySelector('.sessionToolsTodos');
  const status = panel.root.querySelector('.sessionToolsStatus');
  check('native session actions are available only when host advertises capabilities', toggle.disabled === false);
  toggle.fire('click');
  check('session actions require an opened session and do not fake success',
    tools.style.display === 'none' && compactions === 0 && completions === 0);
  await panel.open({ id: 'native-action-session', live: true });
  toggle.fire('click');
  check('session actions open with accessible expanded state',
    tools.style.display === '' && toggle.getAttribute('aria-expanded') === 'true');
  summary.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('summary is read from backend and shown without mutation',
    /Persisted compact summary/.test(tools.textContent) && compactions === 0);
  compact.fire('click');
  check('first compact click only arms explicit confirmation',
    /Confirm compact/.test(compact.textContent) && compactions === 0);
  denyCompact = true;
  compact.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('failed compaction leaves a real backend error instead of success',
    compactions === 1 && /Context compact denied/.test(status.textContent));
  denyCompact = false;
  compact.fire('click');
  compact.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('second confirmed compact calls native route and reports success',
    compactions === 2 && /context compacted/i.test(status.textContent));
  todos.fire('click');
  check('TODO completion requires confirmation before mutation',
    completions === 0 && /Confirm complete/.test(todos.textContent));
  malformedTodos = true;
  todos.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('malformed native TODO acknowledgement cannot fake completion',
    completions === 1 && /did not confirm TODO/.test(status.textContent));
  malformedTodos = false;
  todos.fire('click');
  todos.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('confirmed TODO mutation updates status only after acknowledged snapshot',
    completions === 2 && /1 TODOs marked completed/.test(status.textContent));
  holdCompact = true;
  compact.fire('click');
  compact.fire('click');
  await Promise.resolve();
  check('native compaction runs single-flight',
    compactions === 3 && typeof releaseHeldCompact === 'function');
  panel.root.querySelector('.sessionToolsClose').fire('click');
  toggle.fire('click');
  compact.fire('click');
  todos.fire('click');
  await Promise.resolve();
  check('closing and reopening a pending native action cannot start another mutation',
    compactions === 3 && completions === 2 && compact.disabled === true);
  releaseHeldCompact?.({ ok: true, fresh: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('native operation lock releases after request settles', compact.disabled === false);
  holdCompact = false;
  holdSummary = true;
  summary.fire('click');
  await Promise.resolve();
  check('summary read is in flight', typeof resolveSummary === 'function');
  await panel.open({ id: 'second-action-session', live: true });
  resolveSummary?.({ hasSummary: true, summary: 'Stale private summary' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('late old-session summary never paints new conversation',
    tools.style.display === 'none' && !/Stale private summary/.test(tools.textContent));
  panel.reset();
  api.freshCompactSessionAvailable = capabilities.freshCompactSessionAvailable;
  api.completeSessionTodosAvailable = capabilities.completeSessionTodosAvailable;
  api.sessionSummaryAvailable = capabilities.sessionSummaryAvailable;
  api.transcript = oldTranscript;
  adapter.http = oldHttp;
}

// Slash commands reuse local native controls; never send command text to the LLM.
{
  const conversation = studio.require('panels/conversation');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const oldTranscript = api.transcript;
  const oldSummary = api.sessionSummaryAvailable;
  const oldCompact = api.freshCompactSessionAvailable;
  const oldTodos = api.completeSessionTodosAvailable;
  const oldScope = api.sessionFolderScopeAvailable;
  const oldSend = api.sendWithProgress;
  let sends = 0;
  let compacts = 0;
  let reads = 0;
  api.sessionSummaryAvailable = () => true;
  api.freshCompactSessionAvailable = () => true;
  api.completeSessionTodosAvailable = () => true;
  api.sessionFolderScopeAvailable = () => true;
  api.transcript = async () => [];
  api.sendWithProgress = async () => { sends += 1; return true; };
  adapter.http = async (method, path, body) => {
    if (path.startsWith('/api/models')) return { models: [] };
    if (path.startsWith('/api/sessions/summary')) {
      reads += 1;
      return { hasSummary: true, summary: 'Native saved summary' };
    }
    if (path.startsWith('/api/sessions/authorized-folders')) {
      return { ok: true, sessionId: 'slash-session', authorizedFolders: ['/workspace'] };
    }
    if (path === '/api/sessions/fresh-compact') {
      compacts += 1;
      return { ok: true, fresh: true };
    }
    return oldHttp(method, path, body);
  };
  const panel = conversation.render({ onChanged() {}, onOpened() {}, onCreated() {} });
  const input = panel.root.querySelector('.input-box');
  const slashBtn = panel.root.querySelector('.nativeSlashButton');
  const cmdStatus = panel.root.querySelector('.nativeSlashStatus');
  const cmdMenu = panel.root.querySelector('.nativeSlashMenu');
  const send = panel.root.querySelector('.send-btn');
  const issue = async (text) => {
    input.textContent = text;
    send.fire('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await issue('/help');
  check('slash help opens local menu without sending a chat turn',
    sends === 0 && input.textContent === '' && cmdMenu.style.display === ''
    && cmdMenu.querySelectorAll('.nativeSlashOption').length === 6);
  check('command capability gates are visible before opening a session',
    cmdMenu.querySelectorAll('.nativeSlashOption').filter((option) => option.disabled).length === 4);
  input.fire('keydown', { key: 'Escape', preventDefault() {} });
  check('Escape dismisses slash popup', cmdMenu.style.display === 'none' && slashBtn.getAttribute('aria-expanded') === 'false');
  await issue('/summary');
  check('slash commands without an active session fail closed',
    sends === 0 && input.textContent === '/summary' && /unavailable/.test(cmdStatus.textContent));
  await panel.open({ id: 'slash-session', live: true });
  await issue('/summary');
  check('summary shortcut calls the native session summary read',
    reads === 1 && /Native saved summary/.test(panel.root.querySelector('.sessionSummaryContent')?.textContent || '')
    && sends === 0);
  await issue('/compact');
  check('compact command only arms explicit confirmation',
    compacts === 0 && /Confirm compact/.test(panel.root.querySelector('.sessionToolsCompact')?.textContent || ''));
  panel.root.querySelector('.sessionToolsCompact')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('confirmed compact calls existing real session mutation', compacts === 1 && sends === 0);
  await issue('/folders');
  check('folders shortcut opens native folder editor',
    panel.root.querySelector('.sessionFolderScopePanel')?.style.display === '');
  await issue('/unknown');
  check('unknown slash name remains editable and is not dispatched',
    sends === 0 && input.textContent === '/unknown' && /Unknown/.test(cmdStatus.textContent));
  await issue('/compact extra');
  check('slash commands refuse unexpected arguments without sending',
    sends === 0 && /does not accept arguments/.test(cmdStatus.textContent));
  slashBtn.fire('click');
  panel.reset();
  check('reset closes local commands and clears previous status',
    cmdMenu.style.display === 'none' && cmdStatus.textContent === '');
  adapter.http = oldHttp;
  api.transcript = oldTranscript;
  api.sessionSummaryAvailable = oldSummary;
  api.freshCompactSessionAvailable = oldCompact;
  api.completeSessionTodosAvailable = oldTodos;
  api.sessionFolderScopeAvailable = oldScope;
  api.sendWithProgress = oldSend;
}

// The rail's read-only file-history UI uses native session-scoped responses,
// version/snapshot drilldown, and discards cross-session stale responses.
{
  const railModule = studio.require('panels/rail');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const oldList = api.fileHistoryListFilesAvailable;
  const oldVersions = api.fileHistoryListVersionsAvailable;
  const oldSnapshot = api.fileHistoryGetSnapshotAvailable;
  api.fileHistoryListFilesAvailable = () => true;
  api.fileHistoryListVersionsAvailable = () => true;
  api.fileHistoryGetSnapshotAvailable = () => true;
  let holdFirstList = false;
  let releaseFirstList = null;
  let failHistory = false;
  let incorrectSnapshot = false;
  const paths = [];
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/file-history/')) {
      paths.push(path);
      if (path.startsWith('/api/file-history/files')) {
        if (failHistory) return { ok: false, error: 'history denied' };
        if (holdFirstList && path.includes('agentId=history-one')) {
          return new Promise((resolve) => { releaseFirstList = resolve; });
        }
        return { files: [{ relPath: path.includes('history-two') ? 'second.md' : 'first.md', snapshotCount: 1 }] };
      }
      if (path.startsWith('/api/file-history/versions')) {
        return { versions: [{ id: 42, capturedAt: 100, origin: 'save' }] };
      }
      if (path.startsWith('/api/file-history/snapshot')) {
        return { relPath: incorrectSnapshot ? 'other.md' : 'first.md', content: 'Historical content from Studio' };
      }
    }
    return oldHttp(method, path, body);
  };
  const rail = railModule.render();
  rail.setSession('history-one');
  rail.root.querySelectorAll('.tab')[0]?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('right rail fetches actual file history for selected session',
    rail.root.querySelectorAll('.railHistoryFile').length === 1
    && /first.md/.test(rail.root.querySelector('.railHistoryFile')?.textContent || '')
    && paths.some((path) => path.includes('agentId=history-one')));
  rail.root.querySelector('.railHistoryFile')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('file history lists authoritative versions',
    /Snapshot 42/.test(rail.root.querySelector('.railHistoryVersion')?.textContent || ''));
  rail.root.querySelector('.railHistoryVersion')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('file history snapshot is read only text',
    /Historical content from Studio/.test(rail.root.querySelector('.railHistorySnapshot')?.textContent || ''));
  rail.root.querySelector('.railHistoryBack')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  holdFirstList = true;
  rail.root.querySelector('.railHistoryRefresh')?.fire('click');
  await Promise.resolve();
  check('stale session file fetch begins asynchronously', typeof releaseFirstList === 'function');
  rail.setSession('history-two');
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirstList?.({ files: [{ relPath: 'stale-secret.md', snapshotCount: 1 }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('old session file history cannot repaint new session',
    /second.md/.test(rail.root.querySelector('.railHistoryFile')?.textContent || '')
    && !/stale-secret/.test(rail.root.textContent || ''));
  // Validate snapshot ownership; never show a different file's contents.
  holdFirstList = false;
  rail.setSession('history-one');
  await new Promise((resolve) => setTimeout(resolve, 0));
  rail.root.querySelector('.railHistoryFile')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  incorrectSnapshot = true;
  rail.root.querySelector('.railHistoryVersion')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('snapshot path mismatch never exposes another file content',
    rail.root.querySelector('.railHistorySnapshot') == null
    && /mismatched snapshot/.test(rail.root.textContent || ''));
  incorrectSnapshot = false;
  failHistory = true;
  rail.root.querySelector('.railHistoryRefresh')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('backend error payload cannot masquerade as empty file list',
    rail.root.querySelector('.content')?.getAttribute('data-content-state') === 'error'
    && /history denied/.test(rail.root.textContent || ''));
  api.fileHistoryListFilesAvailable = () => false;
  rail.setSession('history-two');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('file history fails closed when Studio lacks native capability',
    rail.root.querySelector('.content')?.getAttribute('data-content-state') === 'unavailable');
  check('session file history never calls mutation APIs', paths.every((path) => path.startsWith('/api/file-history/')));
  rail.dispose();
  adapter.http = oldHttp;
  api.fileHistoryListFilesAvailable = oldList;
  api.fileHistoryListVersionsAvailable = oldVersions;
  api.fileHistoryGetSnapshotAvailable = oldSnapshot;
}

// Native workspace browser remains read-only, scopes coordinates to the
// default root, rejects unsafe rows, and isolates out-of-order navigation.
{
  const railModule = studio.require('panels/rail');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const oldList = api.workbenchListFilesAvailable;
  const oldRead = api.workbenchReadFileAvailable;
  const oldSearch = api.workbenchSearchFilesAvailable;
  api.workbenchSearchFilesAvailable = () => true;
  api.workbenchListFilesAvailable = () => true;
  api.workbenchReadFileAvailable = () => true;
  let holdDirectory = false;
  let releaseDirectory;
  let invalidRoot = false;
  let invalidName = false;
  let binaryFile = false;
  let holdSearch = false;
  let releaseSearch;
  let unsafeSearch = false;
  const paths = [];
  adapter.http = async (method, path, body) => {
    if (path.startsWith('/api/workbench/')) {
      paths.push([method, path]);
      if (path.startsWith('/api/workbench/search')) {
        if (holdSearch) return new Promise((resolve) => { releaseSearch = resolve; });
        return { rootId: 'default', query: 'guide', results: unsafeSearch
          ? [{ name: 'secret.md', relativePath: '../secret.md', isDir: false }]
          : [{ name: 'guide.txt', relativePath: 'docs/guide.txt', isDir: false }] };
      }
      if (path.startsWith('/api/workbench/files')) {
        if (holdDirectory && path.includes('subdir=docs')) {
          return new Promise((resolve) => { releaseDirectory = resolve; });
        }
        const subdir = decodeURIComponent(path.match(/[?&]subdir=([^&]*)/)?.[1] || '');
        return {
          rootId: invalidRoot ? 'untrusted' : 'default', subdir,
          files: invalidName ? [{ name: '../secret', isDir: false }]
            : subdir === 'docs' ? [{ name: 'guide.txt', isDir: false, size: 5 }]
              : [{ name: 'docs', isDir: true }, { name: 'README.md', isDir: false, size: 3 }],
        };
      }
      if (path.startsWith('/api/workbench/content')) {
        return { __httpStatus: 200,
          __httpHeaders: { 'Content-Type': binaryFile ? 'image/png' : 'text/plain; charset=utf-8' },
          __httpBody: 'Read-only workspace text' };
      }
    }
    return oldHttp(method, path, body);
  };
  const rail = railModule.render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace native browser fetches scoped default directory',
    rail.root.querySelectorAll('.railWorkspaceDir').length === 1
    && rail.root.querySelectorAll('.railWorkspaceFile').length === 1
    && paths.some(([, path]) => path.includes('rootId=default')));
  rail.root.querySelector('.railWorkspaceDir')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace navigation opens nested directory by relative coordinate',
    /Workspace \/docs/.test(rail.root.querySelector('.railWorkspaceHeader')?.textContent || '')
    && /guide.txt/.test(rail.root.querySelector('.railWorkspaceFile')?.textContent || ''));
  rail.root.querySelector('.railWorkspaceFile')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('text preview reads the native content endpoint without writes',
    /Read-only workspace text/.test(rail.root.querySelector('.railWorkspacePreview')?.textContent || '')
    && paths.some(([, path]) => path.includes('name=guide.txt')));
  rail.root.querySelector('.railWorkspaceBack')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('Up navigation returns to workspace root',
    rail.root.querySelectorAll('.railWorkspaceDir').length === 1
    && rail.root.querySelector('.railWorkspaceBack')?.disabled === true);
  const searchInput = rail.root.querySelector('.railWorkspaceSearchInput');
  searchInput.value = 'guide';
  searchInput.fire('input');
  rail.root.querySelector('.railWorkspaceSearchButton')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace search displays native scoped matching files',
    /docs\/guide.txt/.test(rail.root.querySelector('.railWorkspaceSearchResult')?.textContent || '')
    && paths.some(([, path]) => path.includes('/api/workbench/search?rootId=default')));
  rail.root.querySelector('.railWorkspaceSearchResult')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('search result opens the correct relative file for text preview',
    /Read-only workspace text/.test(rail.root.querySelector('.railWorkspacePreview')?.textContent || '')
    && /subdir=docs&name=guide.txt/.test(paths[paths.length - 1]?.[1] || ''));
  // A mismatched search path must not become a read or navigation command.
  unsafeSearch = true;
  const unsafeInput = rail.root.querySelector('.railWorkspaceSearchInput');
  unsafeInput.value = 'guide';
  unsafeInput.fire('input');
  rail.root.querySelector('.railWorkspaceSearchButton')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace search rejects path traversal in backend results',
    /Invalid workspace search response/.test(rail.root.textContent || '')
    && rail.root.querySelectorAll('.railWorkspaceSearchResult').length === 0);
  unsafeSearch = false;
  holdSearch = true;
  const delayedInput = rail.root.querySelector('.railWorkspaceSearchInput');
  delayedInput.value = 'guide';
  delayedInput.fire('input');
  rail.root.querySelector('.railWorkspaceSearchButton')?.fire('click');
  await Promise.resolve();
  check('async workspace search began', typeof releaseSearch === 'function');
  rail.root.querySelectorAll('.tab')[0]?.fire('click');
  releaseSearch?.({ rootId: 'default', results: [
    { name: 'leaked.md', relativePath: 'leaked.md', isDir: false },
  ] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('stale workspace search cannot leak onto file history tab',
    !/leaked.md/.test(rail.root.textContent || ''));
  rail.root.querySelectorAll('.tab')[1]?.fire('click');
  holdSearch = false;
  rail.root.querySelector('.railWorkspaceBack')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  invalidName = true;
  rail.root.querySelector('.railWorkspaceRefresh')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('unsafe backend file names fail closed',
    rail.root.querySelector('.content')?.getAttribute('data-content-state') === 'workspace'
    && /Invalid workspace directory response/.test(rail.root.textContent || '')
    && rail.root.querySelectorAll('.railWorkspaceFile').length === 0);
  invalidName = false;
  invalidRoot = true;
  rail.root.querySelector('.railWorkspaceRefresh')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace mismatched root cannot display files',
    /Invalid workspace directory response/.test(rail.root.textContent || ''));
  invalidRoot = false;
  rail.root.querySelector('.railWorkspaceRefresh')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  binaryFile = true;
  rail.root.querySelector('.railWorkspaceFile')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('binary content cannot masquerade as a text preview',
    /cannot be previewed as text/.test(rail.root.textContent || '')
    && rail.root.querySelector('.railWorkspacePreview') == null);
  binaryFile = false;
  holdDirectory = true;
  rail.root.querySelector('.railWorkspaceRefresh')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  rail.root.querySelector('.railWorkspaceDir')?.fire('click');
  await Promise.resolve();
  check('directory request held for late response test', typeof releaseDirectory === 'function');
  rail.root.querySelectorAll('.tab')[0]?.fire('click');
  releaseDirectory?.({ rootId: 'default', subdir: 'docs', files: [{ name: 'stale-private.txt', isDir: false }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace response cannot overwrite session-history tab',
    !/stale-private/.test(rail.root.textContent || '')
    && rail.root.querySelector('.railWorkspaceBrowser')?.style.display === 'none');
  rail.root.querySelectorAll('.tab')[1]?.fire('click');
  api.workbenchListFilesAvailable = () => false;
  rail.root.querySelector('.railWorkspaceRefresh')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace browser distinguishes absent native capability',
    /unavailable in this Studio host/.test(rail.root.textContent || ''));
  check('workspace file browser never issues mutations', paths.every(([method]) => method === 'GET'));
  rail.dispose();
  adapter.http = oldHttp;
  api.workbenchListFilesAvailable = oldList;
  api.workbenchReadFileAvailable = oldRead;
  api.workbenchSearchFilesAvailable = oldSearch;
}

// Versioned native text edits and create-only writes preserve drafts on conflicts.
{
  const railModule = studio.require('panels/rail');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const oldList = api.workbenchListFilesAvailable;
  const oldRead = api.workbenchReadFileAvailable;
  const oldWrite = api.workbenchWriteFileAvailable;
  api.workbenchListFilesAvailable = () => true;
  api.workbenchReadFileAvailable = () => true;
  api.workbenchWriteFileAvailable = () => true;
  const writes = [];
  let conflict = false;
  let deferSave = false;
  let releaseSave = null;
  adapter.http = async (method, path, body) => {
    if (path.startsWith('/api/workbench/files'))
      return { rootId: 'default', subdir: '', files: [{ name: 'notes.txt', isDir: false }] };
    if (path.startsWith('/api/workbench/content'))
      return { __httpStatus: 200, __httpHeaders: { 'Content-Type': 'text/plain', 'X-Hana-File-Version': 'v1' }, __httpBody: 'Original' };
    if (path === '/api/workbench/actions') {
      writes.push(body);
      if (deferSave) return new Promise((resolve) => { releaseSave = resolve; });
      return conflict ? { ok: false, error: 'Version conflict' }
        : { ok: true, action: body.action, version: 'v2' };
    }
    return oldHttp(method, path, body);
  };
  const rail = railModule.render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  rail.root.querySelector('.railWorkspaceFile')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('versioned file exposes native edit action', !!rail.root.querySelector('.railWorkspaceEditButton'));
  rail.root.querySelector('.railWorkspaceEditButton')?.fire('click');
  const editor = rail.root.querySelector('.railWorkspaceEditor');
  editor.value = 'Modified';
  editor.fire('input');
  rail.root.querySelectorAll('.tab')[0]?.fire('click');
  check('unsaved text prevents tab navigation', /Unsaved changes/.test(rail.root.textContent || ''));
  conflict = true;
  rail.root.querySelector('.railWorkspaceSave')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('conflicting versioned save keeps draft and original revision',
    writes.length === 1 && writes[0].expectedVersion === 'v1'
    && writes[0].content === 'Modified'
    && /Version conflict/.test(rail.root.textContent || '')
    && rail.root.querySelector('.railWorkspaceEditor')?.value === 'Modified');
  conflict = false;
  deferSave = true;
  rail.root.querySelector('.railWorkspaceSave')?.fire('click');
  await Promise.resolve();
  rail.root.querySelector('.railWorkspaceSave')?.fire('click');
  check('save is single-flight and prevents discard while pending',
    writes.length === 2 && rail.root.querySelector('.railWorkspaceDiscard')?.disabled === true);
  releaseSave?.({ ok: true, action: 'writeText', version: 'v2' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  deferSave = false;
  check('acknowledged native save produces persisted preview',
    /Modified/.test(rail.root.querySelector('.railWorkspacePreview')?.textContent || '')
    && /File saved to Studio/.test(rail.root.textContent || ''));
  rail.root.querySelector('.railWorkspaceList')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const filename = rail.root.querySelector('.railWorkspaceNewName');
  filename.value = '../invalid';
  rail.root.querySelector('.railWorkspaceCreate')?.fire('click');
  check('unsafe new filename cannot dispatch any native write', writes.length === 2
    && /valid single filename/.test(rail.root.textContent || ''));
  const validFilename = rail.root.querySelector('.railWorkspaceNewName');
  validFilename.value = 'new.md';
  rail.root.querySelector('.railWorkspaceCreate')?.fire('click');
  check('new file waits for explicit native create', writes.length === 2
    && rail.root.querySelector('.railWorkspaceSave')?.textContent === 'Create file');
  const createEditor = rail.root.querySelector('.railWorkspaceEditor');
  createEditor.value = 'New content';
  createEditor.fire('input');
  rail.root.querySelector('.railWorkspaceSave')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('new file commits via create-only action', writes.length === 3
    && writes[2].action === 'create' && writes[2].name === 'new.md'
    && writes[2].content === 'New content' && writes[2].expectedVersion == null);
  rail.dispose();
  adapter.http = oldHttp;
  api.workbenchListFilesAvailable = oldList;
  api.workbenchReadFileAvailable = oldRead;
  api.workbenchWriteFileAvailable = oldWrite;
}

// Native workspace rename, scoped move and native safe trash require
// expected versions and do not apply optimistic updates on backend errors.
{
  const railModule = studio.require('panels/rail');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const flags = ['workbenchListFilesAvailable', 'workbenchReadFileAvailable',
    'workbenchRenameFileAvailable', 'workbenchMoveFileAvailable', 'workbenchDeleteFileAvailable'];
  const originals = flags.map((name) => api[name]);
  flags.forEach((name) => { api[name] = () => true; });
  const calls = [];
  let failMutation = false;
  let holdMutation = false;
  let finishNative = null;
  adapter.http = async (method, path, body) => {
    if (path.startsWith('/api/workbench/files'))
      return { rootId: 'default', subdir: '', files: [{ name: 'sample.txt', isDir: false }] };
    if (path.startsWith('/api/workbench/content'))
      return { __httpStatus: 200, __httpHeaders: { 'Content-Type': 'text/plain', 'X-Hana-File-Version': 'r1' }, __httpBody: 'Text' };
    if (path === '/api/workbench/actions') {
      calls.push(body);
      if (holdMutation) return new Promise((resolve) => { finishNative = resolve; });
      return failMutation ? { ok: false, error: 'native conflict' }
        : { ok: true, action: body.action, version: 'r2', trashId: 'trash-42' };
    }
    return oldHttp(method, path, body);
  };
  const rail = railModule.render();
  const browse = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    rail.root.querySelector('.railWorkspaceFile')?.fire('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await browse();
  const action = (label) => rail.root.querySelectorAll('.railWorkspaceMutationStart')
    .find((button) => button.textContent === label)?.fire('click');
  action('Rename');
  const renameInput = rail.root.querySelector('.railWorkspaceMutationInput');
  renameInput.value = 'renamed.txt';
  renameInput.fire('input');
  failMutation = true;
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('native rename conflict retains form and original revision',
    calls.length === 1 && calls[0].action === 'rename'
    && calls[0].oldName === 'sample.txt' && calls[0].newName === 'renamed.txt'
    && calls[0].expectedVersion === 'r1'
    && /native conflict/.test(rail.root.textContent || ''));
  failMutation = false;
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('acknowledged rename returns to file listing', calls.length === 2
    && /Renamed to renamed.txt/.test(rail.root.textContent || ''));
  await browse();
  action('Move');
  const moveInput = rail.root.querySelector('.railWorkspaceMutationInput');
  moveInput.value = '../other';
  moveInput.fire('input');
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  check('workspace move refuses traversal before native call',
    calls.length === 2 && /safe workspace-relative/.test(rail.root.textContent || ''));
  const safeMove = rail.root.querySelector('.railWorkspaceMutationInput');
  safeMove.value = 'docs/archive';
  safeMove.fire('input');
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('workspace move delegates relative path and version',
    calls.length === 3 && calls[2].action === 'move' && calls[2].destSubdir === 'docs/archive'
    && calls[2].expectedVersion === 'r1');
  await browse();
  action('Safe delete');
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  check('safe delete first click does not contact backend',
    calls.length === 3 && /Confirm safe delete/.test(rail.root.textContent || ''));
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('safe delete goes through acknowledged native trash',
    calls.length === 4 && calls[3].action === 'safeDelete'
    && calls[3].expectedVersion === 'r1'
    && /native safe-delete trash/.test(rail.root.textContent || ''));
  await browse();
  action('Safe delete');
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  holdMutation = true;
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  await Promise.resolve();
  rail.root.querySelector('.railWorkspaceMutationApply')?.fire('click');
  rail.root.querySelectorAll('.tab')[0]?.fire('click');
  check('pending native trash prevents duplicate call and tab navigation',
    calls.length === 5 && rail.root.querySelector('.railWorkspaceMutationCancel')?.disabled === true
    && rail.root.querySelector('.railWorkspaceBrowser')?.style.display !== 'none');
  finishNative?.({ ok: true, action: 'safeDelete', version: 'r2', trashId: 'trash-43' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  holdMutation = false;
  check('pending native trash resumes after confirmed acknowledgement',
    /native safe-delete trash/.test(rail.root.textContent || ''));
  rail.dispose();
  adapter.http = oldHttp;
  flags.forEach((name, index) => { api[name] = originals[index]; });
}

// Native workspace file chooser stages locally, retries actual upload errors,
// blocks duplicate submits and requires exact authenticated host ACKs.
{
  const railModule = studio.require('panels/rail');
  const adapter = studio.require('lib/hana-adapter');
  const oldHttp = adapter.http;
  const oldList = api.workbenchListFilesAvailable;
  const oldUpload = api.workbenchUploadFileAvailable;
  api.workbenchListFilesAvailable = () => true;
  api.workbenchUploadFileAvailable = () => true;
  const calls = [];
  let failUpload = false;
  let deferUpload = false;
  let releaseUpload;
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/workbench/files')) return {
      rootId: 'default', subdir: '', files: [{ name: 'exists.txt', isDir: false }],
    };
    if (method === 'POST' && path === '/api/workbench/upload') {
      calls.push(body);
      if (deferUpload) return new Promise((resolve) => { releaseUpload = resolve; });
      return failUpload ? { ok: false, error: 'upload rejected' }
        : { ok: true, rootId: 'default', subdir: '', results: [
          { ok: true, name: body.files[0].name, version: 'v2' },
        ] };
    }
    return oldHttp(method, path, body);
  };
  const rail = railModule.render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stage = (name, size = 2) => {
    const chooser = rail.root.querySelector('.railWorkspaceUploadChooser');
    chooser.files = [{ name, size, type: 'text/plain',
      async arrayBuffer() { return new Uint8Array([104, 105]).buffer; } }];
    chooser.fire('change');
  };
  stage('exists.txt');
  check('existing filename rejected before upload', calls.length === 0
    && /already exists/.test(rail.root.textContent || ''));
  stage('huge.txt', 6 * 1024 * 1024);
  check('oversized file cannot be staged', calls.length === 0
    && /at most 5 MiB/.test(rail.root.textContent || ''));
  stage('new.txt');
  check('valid file is staged without native side effects', calls.length === 0
    && /Staged: new.txt/.test(rail.root.textContent || ''));
  failUpload = true;
  rail.root.querySelector('.railWorkspaceUploadSubmit')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('failed upload stays staged for manual retry', calls.length === 1
    && calls[0].files?.[0]?.contentBase64 === 'aGk='
    && /upload rejected/.test(rail.root.textContent || '')
    && !!rail.root.querySelector('.railWorkspaceUploadSubmit'));
  failUpload = false;
  deferUpload = true;
  rail.root.querySelector('.railWorkspaceUploadSubmit')?.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  rail.root.querySelector('.railWorkspaceUploadSubmit')?.fire('click');
  rail.root.querySelectorAll('.tab')[0]?.fire('click');
  check('pending upload locks duplicate requests and navigation', calls.length === 2
    && rail.root.querySelector('.railWorkspaceUploadCancel')?.disabled === true
    && rail.root.querySelector('.railWorkspaceBrowser')?.style.display !== 'none');
  releaseUpload?.({ ok: true, rootId: 'default', subdir: '', results: [
    { ok: true, name: 'new.txt', version: 'v2' },
  ] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('acknowledged upload refreshes listing without phantom success',
    /Uploaded new.txt to Studio workspace/.test(rail.root.textContent || '')
    && rail.root.querySelector('.railWorkspaceUploadSubmit') == null);
  rail.dispose();
  adapter.http = oldHttp;
  api.workbenchListFilesAvailable = oldList;
  api.workbenchUploadFileAvailable = oldUpload;
}

console.log(`DOM smoke: ${nodes} nodes, ${svgs.length} svg, ${count('.hana-slot')} slots`);
if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('DOM smoke: ok');
