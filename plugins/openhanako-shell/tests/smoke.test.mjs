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
check('session files tab explains standalone limitation',
  root.querySelector('.content')?.getAttribute('data-content-state') === 'unavailable'
  && /not available in the standalone Studio bridge/i.test(root.querySelector('.fileList')?.textContent || ''));
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
adapterForSettings.http = async (method, path, body) => {
  if (method === 'GET' && path === '/api/providers/summary') {
    return {
      providers: {
        providerA: { display_name: 'Provider A', is_configured: true, models: ['a-model'] },
        providerB: { display_name: 'Provider B', is_configured: true, models: ['b-model'] },
      },
    };
  }
  return originalSettingsHttp(method, path, body);
};
api.status = async () => ({ provider: 'providerA', model: 'a-model', providers: ['providerA', 'providerB'] });
api.getLlmConfig = async () => ({ default: 'providerA' });
api.setLlmConfig = async (patch) => {
  defaultProviderPatch = patch;
  api.getLlmConfig = async () => ({ default: patch.default });
  return { ok: true };
};
root.querySelector('.sidebarSettingsRefresh')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
check('settings marks current default provider',
  root.querySelectorAll('.sidebarSettingsDefaultBadge').length === 1);
root.querySelector('.sidebarSettingsSetDefault')?.fire('click');
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
check('settings can update default provider without exposing credentials',
  defaultProviderPatch?.default === 'providerB'
  && root.querySelectorAll('.sidebarSettingsDefaultBadge').length === 1
  && !/api[_ -]?key/i.test(root.querySelector('.sidebarSettingsPanel')?.textContent || ''));
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
  && root.querySelectorAll('.attach-btn').every((button) => button.disabled === true)
  && root.querySelector('.plan-mode-btn')?.disabled === true);
check('unsupported controls explain why they are disabled',
  /standalone Studio bridge/.test(root.querySelector('.folderSelectBtn')?.title || '')
  && /server command dispatcher/.test(root.querySelectorAll('.attach-btn')[1]?.title || '')
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
  let failModelLoad = false;
  adapter.http = async (method, path, body) => {
    if (method === 'GET' && path === '/api/models') {
      if (failModelLoad) throw new Error('model list unavailable');
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

  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  failModelLoad = true;
  modelPill.fire('click');
  modelPill.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('failed model refresh removes stale model options',
    modelRoot.querySelectorAll('.model-option').length === 1
    && modelRoot.querySelector('.model-option')?.getAttribute('data-model-state') === 'unavailable');
  modelPill.fire('click');

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

console.log(`DOM smoke: ${nodes} nodes, ${svgs.length} svg, ${count('.hana-slot')} slots`);
if (failures.length) {
  console.error('FAIL:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('DOM smoke: ok');
