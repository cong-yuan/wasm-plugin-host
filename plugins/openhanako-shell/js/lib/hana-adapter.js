// Map the slice of Hana's HTTP + WS chat protocol onto `lib/api`.
//
// Studio `AgentRow.id` is openhanako `sessionId`. Paths are synthetic
// (`studio://<id>`) because the iframe keys transcripts by `sessionPath`.
// The Hana assistant id stays a constant (`studio`) so agent switch UI does
// not treat every session as a different assistant.
//
// For prompts, progress is pushed through an optional `emit` callback as soon
// as Studio emits `studio://chat-partial` (live assistant/chunk assembly) or
// transcript growth is observed as a fallback.
return (function () {
  const api = studio.require('lib/api');
  const sessionSearch = studio.require('lib/session-search');

  const ASSISTANT_ID = 'studio';
  const ASSISTANT_NAME = 'Hanako';
  const PATH_PREFIX = 'studio://';

  const pathFor = (id) => PATH_PREFIX + encodeURIComponent(String(id));

  // Studio progress callbacks can outlive cancel_agent. Keep a per-session
  // turn token so Stop can synchronously invalidate every late callback before
  // awaiting the backend cancellation request.
  const activeTurns = new Map();
  const runtimeTranscriptCache = new Map();
  const runtimeTranscriptKey = (row, base) => [
    base?.messageCount ?? '',
    row?.updated_at ?? row?.updatedAt ?? '',
    row?.status ?? '',
    row?.error ?? row?.last_error ?? row?.lastError ?? '',
  ].join('|');
  let streamSequence = 0;
  const newStreamId = () => 'studio-stream-' + Date.now().toString(36) + '-' + (++streamSequence).toString(36);
  const deactivateTurn = (turn) => {
    if (!turn || !turn.active) return;
    turn.active = false;
    turn.keys.forEach((key) => {
      if (activeTurns.get(key) === turn) activeTurns.delete(key);
    });
  };
  const activateTurn = (...ids) => {
    const keys = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
    keys.forEach((key) => deactivateTurn(activeTurns.get(key)));
    const turn = { streamId: newStreamId(), keys, primaryKey: keys[0] || '', active: true };
    keys.forEach((key) => activeTurns.set(key, turn));
    return turn;
  };
  const isActiveTurn = (turn) => !!(
    turn
    && turn.active
    && turn.primaryKey
    && activeTurns.get(turn.primaryKey) === turn
  );

  const idFrom = (value) => {
    if (value == null) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    if (raw.startsWith(PATH_PREFIX)) {
      try { return decodeURIComponent(raw.slice(PATH_PREFIX.length)); } catch (_) { return raw.slice(PATH_PREFIX.length); }
    }
    return raw;
  };

  const splitPath = (path) => {
    const raw = String(path || '/');
    const q = raw.indexOf('?');
    if (q < 0) return { pathname: raw, search: '' };
    return { pathname: raw.slice(0, q), search: raw.slice(q + 1) };
  };

  const queryOf = (search) => {
    const params = {};
    const src = String(search || '').replace(/^\?/, '');
    if (!src) return params;
    src.split('&').forEach((part) => {
      if (!part) return;
      const i = part.indexOf('=');
      const key = decodeURIComponent(i < 0 ? part : part.slice(0, i));
      const val = decodeURIComponent(i < 0 ? '' : part.slice(i + 1));
      params[key] = val;
    });
    return params;
  };


  // ── Session project catalog (local; Studio has no Hana /api/session-projects) ──
  const CATALOG_KEY = 'openhanako.sessionProjectCatalog.v1';
  const ASSIGN_KEY = 'openhanako.sessionProjectAssignments.v1';
  const PIN_KEY = 'openhanako.sessionPins.v1';
  const TITLE_KEY = 'openhanako.sessionTitles.v1';
  const ARCHIVE_KEY = 'openhanako.archivedSessions.v1';
  const USER_PREFS_KEY = 'openhanako.userPreferences.v1';
  const APPEARANCE_KEY = 'openhanako.appearancePreferences.v1';
  const SIDEBAR_UI_KEY = 'openhanako.sidebarUiPreferences.v1';
  const QUICK_CHAT_KEY = 'openhanako.quickChatPreferences.v1';
  const NOTIFICATION_PREFS_KEY = 'openhanako.notificationPreferences.v1';
  const AUTOMATION_DRAFTS_KEY = 'openhanako.automationDrafts.v1';
  const PIN_ORDER_STEP = 1024;
  const UNCATEGORIZED_PROJECT_ID = 'cwd:';

  const trimName = (value) => {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, 80);
  };

  const normalizeWorkspacePath = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const slashed = trimmed.replace(/\\/g, '/');
    if (slashed === '/') return '/';
    if (/^[A-Za-z]:\/?$/.test(slashed)) return slashed.endsWith('/') ? slashed : slashed + '/';
    return slashed.replace(/\/+$/g, '');
  };

  const nextId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // Prefer localStorage when it works; keep an in-memory mirror so pin /
  // project catalog still function in Node harnesses or private mode where
  // Storage exists but setItem/getItem no-ops or throws.
  const memoryStore = new Map();
  const studioUploadedFiles = new Map();
  const readJson = (key, fallback) => {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            memoryStore.set(key, parsed);
            return parsed;
          }
        }
      }
    } catch (_) { /* fall through to memory */ }
    if (memoryStore.has(key)) return memoryStore.get(key);
    return fallback;
  };

  const writeJson = (key, value) => {
    memoryStore.set(key, value);
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* quota / private mode / broken Storage */ }
  };

  const normalizeUserPrefs = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      name: trimName(src.name) || 'User',
      profile: typeof src.profile === 'string' ? src.profile : '',
    };
  };
  const loadUserPrefs = () => normalizeUserPrefs(readJson(USER_PREFS_KEY, {}));
  const saveUserPrefs = (value) => writeJson(USER_PREFS_KEY, normalizeUserPrefs(value));

  const automationDrafts = () => {
    const raw = readJson(AUTOMATION_DRAFTS_KEY, []);
    return Array.isArray(raw) ? raw.filter((job) => job && typeof job === 'object' && job.id) : [];
  };
  const saveAutomationDrafts = (jobs) => writeJson(AUTOMATION_DRAFTS_KEY, Array.isArray(jobs) ? jobs : []);
  const normalizeAutomationJob = (raw, existing = null) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const base = existing && typeof existing === 'object' ? existing : {};
    const type = src.type === 'at' || src.type === 'every' || src.type === 'cron'
      ? src.type
      : (base.type === 'at' || base.type === 'every' || base.type === 'cron' ? base.type : 'cron');
    const schedule = Object.prototype.hasOwnProperty.call(src, 'schedule') ? src.schedule : base.schedule;
    return {
      ...base,
      ...src,
      id: String(src.id || base.id || nextId('automation')),
      type,
      schedule: typeof schedule === 'number' || typeof schedule === 'string' ? schedule : '0 9 * * *',
      enabled: false,
      label: typeof src.label === 'string' ? src.label.slice(0, 160) : (base.label || ''),
      prompt: typeof src.prompt === 'string' ? src.prompt.slice(0, 65536) : (base.prompt || ''),
      createdAt: base.createdAt || new Date().toISOString(),
      nextRunAt: null,
    };
  };
  const handleAutomationHttp = (verb, body) => {
    if (verb === 'GET') {
      return {
        jobs: automationDrafts(),
        schedulerAvailable: false,
        editableDrafts: true,
      };
    }
    if (verb !== 'POST') return null;
    const request = body && typeof body === 'object' ? body : {};
    const action = request.action;
    const jobs = automationDrafts();
    if (action === 'add') {
      if (request.enabled === true) {
        return { ok: false, error: 'studio scheduler unavailable', code: 'scheduler_unavailable' };
      }
      const job = normalizeAutomationJob(request);
      jobs.push(job);
      saveAutomationDrafts(jobs);
      return { ok: true, job, schedulerAvailable: false };
    }
    if (action === 'apply_suggestion') {
      return {
        ok: false,
        error: 'studio scheduler unavailable',
        code: 'scheduler_unavailable',
      };
    }
    const id = request.id == null ? '' : String(request.id);
    const index = jobs.findIndex((job) => String(job.id) === id);
    if (!id || index < 0) return { ok: false, error: 'automation not found' };
    if (action === 'remove') {
      const [removed] = jobs.splice(index, 1);
      saveAutomationDrafts(jobs);
      return { ok: true, removed };
    }
    if (action === 'toggle') {
      if (jobs[index].enabled) {
        jobs[index] = { ...jobs[index], enabled: false, nextRunAt: null };
        saveAutomationDrafts(jobs);
        return { ok: true, job: jobs[index] };
      }
      return { ok: false, error: 'studio scheduler unavailable', code: 'scheduler_unavailable', job: jobs[index] };
    }
    if (action === 'update') {
      if (request.enabled === true) {
        return { ok: false, error: 'studio scheduler unavailable', code: 'scheduler_unavailable', job: jobs[index] };
      }
      const next = { ...request };
      delete next.action;
      jobs[index] = normalizeAutomationJob(next, jobs[index]);
      saveAutomationDrafts(jobs);
      return { ok: true, job: jobs[index] };
    }
    return { ok: false, error: 'unsupported automation action' };
  };

  const APPEARANCE_THEMES = new Set([
    'auto',
    'warm-paper',
    'midnight',
    'high-contrast',
    'grass-aroma',
    'contemplation',
    'absolutely',
    'delve',
    'deep-think',
    'new-warm-paper',
    'midnight-contrast',
    'coral',
  ]);
  const normalizeAppearance = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const rawTheme = src.theme === 'claude-design' ? 'new-warm-paper' : src.theme;
    return {
      theme: APPEARANCE_THEMES.has(rawTheme) ? rawTheme : 'warm-paper',
      serif: typeof src.serif === 'boolean' ? src.serif : true,
      paperTexture: typeof src.paperTexture === 'boolean' ? src.paperTexture : false,
      leavesOverlay: typeof src.leavesOverlay === 'boolean' ? src.leavesOverlay : false,
    };
  };
  const loadAppearance = () => normalizeAppearance(readJson(APPEARANCE_KEY, {}));
  const saveAppearance = (value) => writeJson(APPEARANCE_KEY, normalizeAppearance(value));
  const applyAppearancePatch = (patch) => {
    const src = patch && typeof patch === 'object' ? patch : null;
    if (!src) return { ok: false, error: 'appearance object required' };
    const current = loadAppearance();
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(src, 'theme')) {
      const rawTheme = src.theme === 'claude-design' ? 'new-warm-paper' : src.theme;
      if (!APPEARANCE_THEMES.has(rawTheme)) return { ok: false, error: 'invalid appearance theme' };
      next.theme = rawTheme;
    }
    for (const key of ['serif', 'paperTexture', 'leavesOverlay']) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
      if (typeof src[key] !== 'boolean') return { ok: false, error: 'invalid appearance ' + key };
      next[key] = src[key];
    }
    saveAppearance(next);
    return { ok: true, appearance: loadAppearance() };
  };

  const cleanSidebarId = (value) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 240 ? trimmed : '';
  };
  const uniqueSidebarIds = (values) => {
    const out = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const id = cleanSidebarId(value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= 256) break;
    }
    return out;
  };
  const normalizeSidebarWidth = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 120 && numeric <= 1200 ? Math.round(numeric) : null;
  };
  const normalizeSidebarUi = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const projectView = src.projectView && typeof src.projectView === 'object' && !Array.isArray(src.projectView)
      ? src.projectView
      : {};
    const sessionList = src.sessionList && typeof src.sessionList === 'object' && !Array.isArray(src.sessionList)
      ? src.sessionList
      : {};
    const layout = src.layout && typeof src.layout === 'object' && !Array.isArray(src.layout)
      ? src.layout
      : {};
    return {
      projectView: {
        collapsedProjectIds: uniqueSidebarIds(projectView.collapsedProjectIds),
        collapsedFolderIds: uniqueSidebarIds(projectView.collapsedFolderIds),
        showAllProjectIds: uniqueSidebarIds(projectView.showAllProjectIds),
      },
      sessionList: {
        rowMode: sessionList.rowMode === 'single-line' ? 'single-line' : 'two-line',
      },
      layout: {
        sidebarWidth: normalizeSidebarWidth(layout.sidebarWidth),
        jianWidth: normalizeSidebarWidth(layout.jianWidth),
        channelInspectorWidth: normalizeSidebarWidth(layout.channelInspectorWidth),
        previewWidth: normalizeSidebarWidth(layout.previewWidth),
      },
    };
  };
  const loadSidebarUi = () => normalizeSidebarUi(readJson(SIDEBAR_UI_KEY, {}));
  const saveSidebarUi = (value) => writeJson(SIDEBAR_UI_KEY, normalizeSidebarUi(value));
  const applySidebarUiPatch = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!src) return { ok: false, error: 'sidebar UI object required' };
    const current = loadSidebarUi();
    const next = {
      projectView: { ...current.projectView },
      sessionList: { ...current.sessionList },
      layout: { ...current.layout },
    };
    if (src.projectView && typeof src.projectView === 'object' && !Array.isArray(src.projectView)) {
      for (const key of ['collapsedProjectIds', 'collapsedFolderIds', 'showAllProjectIds']) {
        if (Object.prototype.hasOwnProperty.call(src.projectView, key)) {
          next.projectView[key] = uniqueSidebarIds(src.projectView[key]);
        }
      }
    }
    if (src.sessionList && typeof src.sessionList === 'object' && !Array.isArray(src.sessionList)
      && Object.prototype.hasOwnProperty.call(src.sessionList, 'rowMode')) {
      const rowMode = src.sessionList.rowMode;
      if (rowMode === 'single-line' || rowMode === 'two-line') {
        next.sessionList.rowMode = rowMode;
      }
    }
    if (src.layout && typeof src.layout === 'object' && !Array.isArray(src.layout)) {
      for (const key of ['sidebarWidth', 'jianWidth', 'channelInspectorWidth', 'previewWidth']) {
        if (!Object.prototype.hasOwnProperty.call(src.layout, key)) continue;
        const width = normalizeSidebarWidth(src.layout[key]);
        if (width !== null) next.layout[key] = width;
      }
    }
    saveSidebarUi(next);
    return { ok: true, sidebarUi: loadSidebarUi() };
  };

  const normalizeQuickChatShortcutPart = (value) => {
    const raw = String(value == null ? '' : value);
    if (raw === ' ' || raw === '\u00A0' || raw === 'Spacebar' || (raw && !raw.trim())) return 'Space';
    const trimmed = raw.trim();
    if (trimmed === 'CmdOrCtrl' || trimmed === 'CommandOrCtrl' || trimmed === 'CtrlOrCommand') {
      return 'CommandOrControl';
    }
    if (trimmed === 'Esc') return 'Escape';
    if (trimmed === 'Spacebar') return 'Space';
    return trimmed;
  };
  const normalizeQuickChatShortcut = (value) => {
    if (typeof value !== 'string') return 'Alt+Space';
    const raw = value.trim();
    if (!raw) return 'Alt+Space';
    const parts = raw.split('+').map(normalizeQuickChatShortcutPart);
    return parts.some((part) => !part) ? 'Alt+Space' : parts.join('+');
  };
  const normalizeQuickChatTimeout = (value) => {
    if (value === null || value === undefined || value === '') return 10;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 10;
    return Math.max(0, Math.min(120, Math.round(numeric)));
  };
  const normalizeQuickChat = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      shortcut: normalizeQuickChatShortcut(src.shortcut),
      reuseTimeoutMinutes: normalizeQuickChatTimeout(
        Object.prototype.hasOwnProperty.call(src, 'reuseTimeoutMinutes')
          ? src.reuseTimeoutMinutes
          : src.reuse_timeout_minutes,
      ),
    };
  };
  const loadQuickChat = () => normalizeQuickChat(readJson(QUICK_CHAT_KEY, {}));
  const saveQuickChat = (value) => writeJson(QUICK_CHAT_KEY, normalizeQuickChat(value));
  const applyQuickChatPatch = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!src) return { ok: false, error: 'quick chat object required' };
    const current = loadQuickChat();
    const merged = { ...current };
    if (Object.prototype.hasOwnProperty.call(src, 'shortcut')) merged.shortcut = src.shortcut;
    if (Object.prototype.hasOwnProperty.call(src, 'reuseTimeoutMinutes')) {
      merged.reuseTimeoutMinutes = src.reuseTimeoutMinutes;
    } else if (Object.prototype.hasOwnProperty.call(src, 'reuse_timeout_minutes')) {
      merged.reuseTimeoutMinutes = src.reuse_timeout_minutes;
    }
    saveQuickChat(merged);
    return { ok: true, quickChat: loadQuickChat() };
  };

  const normalizeChatNotificationMode = (value) => (
    value === 'when_unfocused' || value === 'when_session_unfocused' ? value : 'never'
  );
  const normalizeBackgroundNotificationMode = (value) => (
    value === 'when_unfocused' || value === 'always' ? value : 'never'
  );
  const normalizeNotificationPrefs = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const chatCompletion = Object.prototype.hasOwnProperty.call(src, 'chatCompletion')
      ? src.chatCompletion
      : src.turnCompletion;
    return {
      chatCompletion: normalizeChatNotificationMode(chatCompletion),
      scheduledTaskCompletion: normalizeBackgroundNotificationMode(src.scheduledTaskCompletion),
      patrolCompletion: normalizeBackgroundNotificationMode(src.patrolCompletion),
    };
  };
  const loadNotificationPrefs = () => normalizeNotificationPrefs(readJson(NOTIFICATION_PREFS_KEY, {}));
  const saveNotificationPrefs = (value) => writeJson(NOTIFICATION_PREFS_KEY, normalizeNotificationPrefs(value));
  const applyNotificationPatch = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!src) return { ok: false, error: 'notification preferences object required' };
    const current = loadNotificationPrefs();
    const merged = { ...current };
    if (Object.prototype.hasOwnProperty.call(src, 'chatCompletion')) {
      merged.chatCompletion = src.chatCompletion;
    } else if (Object.prototype.hasOwnProperty.call(src, 'turnCompletion')) {
      merged.chatCompletion = src.turnCompletion;
    }
    if (Object.prototype.hasOwnProperty.call(src, 'scheduledTaskCompletion')) {
      merged.scheduledTaskCompletion = src.scheduledTaskCompletion;
    }
    if (Object.prototype.hasOwnProperty.call(src, 'patrolCompletion')) {
      merged.patrolCompletion = src.patrolCompletion;
    }
    saveNotificationPrefs(merged);
    return { ok: true, notifications: loadNotificationPrefs() };
  };

  const loadTitles = () => readJson(TITLE_KEY, {}) || {};
  const saveTitles = (value) => writeJson(TITLE_KEY, value || {});
  const loadArchived = () => readJson(ARCHIVE_KEY, {}) || {};
  const saveArchived = (value) => writeJson(ARCHIVE_KEY, value || {});
  const archivedRecord = (sessionId) => loadArchived()[pathFor(sessionId)] || null;


  // ── Per-session model assignment (local; Studio agents bind model at create) ──
  const SESSION_MODEL_KEY = 'openhanako.sessionModels.v1';
  const PENDING_MODEL_KEY = 'openhanako.pendingModel.v1';
  const GLOBAL_MODEL_PREFS_KEY = 'openhanako.globalModelPreferences.v1';

  const normalizeModelRef = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = typeof value.id === 'string' ? value.id.trim() : '';
      if (!id) return null;
      const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
      return { id, provider };
    }
    if (typeof value === 'string' && value.trim()) return { id: value.trim(), provider: '' };
    return null;
  };

  const normalizeGlobalModelPrefs = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const models = src.models && typeof src.models === 'object' && !Array.isArray(src.models) ? src.models : src;
    return {
      models: {
        utility: normalizeModelRef(models.utility),
        utility_large: normalizeModelRef(models.utility_large),
        vision: normalizeModelRef(models.vision),
        vision_enabled: models.vision_enabled === true,
      },
      search: {
        provider: typeof src.search?.provider === 'string' && src.search.provider.trim()
          ? src.search.provider.trim()
          : 'auto',
      },
    };
  };
  const loadGlobalModelPrefs = () => normalizeGlobalModelPrefs(readJson(GLOBAL_MODEL_PREFS_KEY, {}));
  const saveGlobalModelPrefs = (value) => writeJson(GLOBAL_MODEL_PREFS_KEY, normalizeGlobalModelPrefs(value));
  const applyGlobalModelPrefsPatch = async (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'model preferences object required' };
    const current = loadGlobalModelPrefs();
    const next = { models: { ...current.models }, search: { ...current.search } };
    if (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
      for (const key of ['utility', 'utility_large', 'vision']) {
        if (Object.prototype.hasOwnProperty.call(raw.models, key)) {
          const ref = normalizeModelRef(raw.models[key]);
          if (raw.models[key] !== null && !ref) return { ok: false, error: `invalid models.${key}` };
          next.models[key] = ref;
        }
      }
      if (Object.prototype.hasOwnProperty.call(raw.models, 'vision_enabled')) {
        if (typeof raw.models.vision_enabled !== 'boolean') return { ok: false, error: 'invalid models.vision_enabled' };
        next.models.vision_enabled = raw.models.vision_enabled;
      }
    }
    if (raw.search && typeof raw.search === 'object' && !Array.isArray(raw.search)
      && Object.prototype.hasOwnProperty.call(raw.search, 'provider')) {
      if (typeof raw.search.provider !== 'string' || !raw.search.provider.trim()) {
        return { ok: false, error: 'invalid search.provider' };
      }
      next.search.provider = raw.search.provider.trim();
    }
    if (Object.prototype.hasOwnProperty.call(raw.models || {}, 'utility') && next.models.utility) {
      if (!next.models.utility.provider) return { ok: false, error: 'models.utility.provider required' };
      if (api.mode() === 'tauri') {
        const result = await api.setLlmConfig({
          current: { provider: next.models.utility.provider, model: next.models.utility.id },
        });
        if (result?.ok === false) return { ok: false, error: result.error || 'failed to persist utility model' };
      }
    }
    saveGlobalModelPrefs(next);
    return { ok: true, ...loadGlobalModelPrefs() };
  };

  const loadSessionModels = () => {
    const raw = readJson(SESSION_MODEL_KEY, {});
    return raw && typeof raw === 'object' ? raw : {};
  };
  const saveSessionModels = (map) => writeJson(SESSION_MODEL_KEY, map || {});
  const rememberSessionModel = (sessionPath, modelId, provider) => {
    if (!sessionPath || !modelId || !provider) return;
    const map = loadSessionModels();
    map[String(sessionPath)] = { modelId: String(modelId), provider: String(provider) };
    saveSessionModels(map);
  };
  const storedModelForPath = (sessionPathOrId) => {
    const path = sessionPathOrId && String(sessionPathOrId).startsWith(PATH_PREFIX)
      ? String(sessionPathOrId)
      : pathFor(sessionPathOrId || '');
    const map = loadSessionModels();
    const hit = map[path] || map[String(sessionPathOrId || '')];
    if (hit && hit.modelId && hit.provider) {
      return { modelId: String(hit.modelId), provider: String(hit.provider) };
    }
    return null;
  };
  const modelForPath = (sessionPathOrId) => {
    const stored = storedModelForPath(sessionPathOrId);
    if (stored) return stored;
    const pending = readJson(PENDING_MODEL_KEY, null);
    if (pending && pending.modelId && pending.provider) {
      return { modelId: String(pending.modelId), provider: String(pending.provider) };
    }
    return { modelId: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER };
  };
  const setPendingModel = (modelId, provider) => {
    writeJson(PENDING_MODEL_KEY, { modelId: String(modelId), provider: String(provider) });
  };
  const serializeModel = (modelId, provider, name) => ({
    id: String(modelId),
    name: String(name || modelId),
    provider: String(provider),
  });

  const normalizeCatalog = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const folders = [];
    const folderIds = new Set();
    (Array.isArray(src.folders) ? src.folders : []).forEach((item, index) => {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return;
      const id = item.id.trim();
      const name = trimName(item.name);
      if (!id || !name || folderIds.has(id)) return;
      folderIds.add(id);
      folders.push({
        id,
        name,
        order: Number.isFinite(item.order) ? item.order : index,
      });
    });
    const projects = [];
    const projectIds = new Set();
    (Array.isArray(src.projects) ? src.projects : []).forEach((item, index) => {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return;
      const id = item.id.trim();
      const name = trimName(item.name);
      if (!id || !name || projectIds.has(id)) return;
      projectIds.add(id);
      const folderId = typeof item.folderId === 'string' && item.folderId.trim() && folderIds.has(item.folderId.trim())
        ? item.folderId.trim()
        : null;
      projects.push({
        id,
        name,
        folderId,
        workspacePath: normalizeWorkspacePath(item.workspacePath),
        order: Number.isFinite(item.order) ? item.order : index,
      });
    });
    folders.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    projects.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { folders, projects };
  };

  const loadCatalog = () => normalizeCatalog(readJson(CATALOG_KEY, { folders: [], projects: [] }));
  const saveCatalog = (catalog) => writeJson(CATALOG_KEY, normalizeCatalog(catalog));

  const loadAssignments = () => {
    const raw = readJson(ASSIGN_KEY, {});
    const out = {};
    Object.keys(raw || {}).forEach((path) => {
      const id = raw[path];
      if (typeof path === 'string' && path && typeof id === 'string' && id) out[path] = id;
    });
    return out;
  };
  const saveAssignments = (map) => writeJson(ASSIGN_KEY, map || {});

  const loadPins = () => {
    const raw = readJson(PIN_KEY, {});
    const out = {};
    Object.keys(raw || {}).forEach((path) => {
      const row = raw[path];
      if (typeof path !== 'string' || !path || !row || typeof row !== 'object') return;
      const pinnedAt = typeof row.pinnedAt === 'string' && row.pinnedAt ? row.pinnedAt : null;
      if (!pinnedAt) return;
      const pinOrder = Number.isFinite(row.pinOrder) ? row.pinOrder : null;
      out[path] = { pinnedAt, pinOrder };
    });
    return out;
  };
  const savePins = (map) => writeJson(PIN_KEY, map || {});
  const topPinOrder = (pins) => {
    let min = Infinity;
    Object.keys(pins || {}).forEach((path) => {
      const order = pins[path] && pins[path].pinOrder;
      if (Number.isFinite(order) && order < min) min = order;
    });
    return (Number.isFinite(min) ? min : 0) - PIN_ORDER_STEP;
  };
  const clearPinForSession = (sessionId) => {
    if (!sessionId) return;
    const path = pathFor(sessionId);
    const pins = loadPins();
    if (!pins[path] && !pins[String(sessionId)]) return;
    delete pins[path];
    delete pins[String(sessionId)];
    savePins(pins);
  };

  const nextOrder = (items) => items.reduce((max, item) => Math.max(max, Number(item.order) || 0), -1) + 1;

  const handleSessionProjects = (pathname, verb, body, query = {}) => {
    if (pathname !== '/api/session-projects' && !pathname.startsWith('/api/session-projects/')) {
      return null;
    }

    if (pathname === '/api/session-projects' && verb === 'GET') {
      return { catalog: loadCatalog() };
    }

    if (pathname === '/api/session-projects/session-assignment' && verb === 'GET') {
      const sessionPath = typeof query.sessionPath === 'string' ? query.sessionPath : '';
      if (!sessionPath) return { error: 'sessionPath is required' };
      const assignments = loadAssignments();
      const projectId = assignments[sessionPath] || UNCATEGORIZED_PROJECT_ID;
      const catalog = loadCatalog();
      const project = catalog.projects.find((item) => item.id === projectId) || null;
      return { assignment: { sessionPath, projectId, project } };
    }

    if (pathname === '/api/session-projects/projects' && verb === 'POST') {
      const catalog = loadCatalog();
      const name = trimName(body && body.name);
      if (!name) return { error: 'project name is required' };
      let folderId = body && typeof body.folderId === 'string' && body.folderId.trim() ? body.folderId.trim() : null;
      if (folderId && !catalog.folders.some((f) => f.id === folderId)) {
        return { error: 'folder not found' };
      }
      const project = {
        id: nextId('project'),
        name,
        folderId,
        workspacePath: normalizeWorkspacePath(body?.workspacePath),
        order: nextOrder(catalog.projects.filter((p) => p.folderId === folderId)),
      };
      catalog.projects.push(project);
      saveCatalog(catalog);
      return { ok: true, project };
    }

    if (pathname === '/api/session-projects/folders' && verb === 'POST') {
      const catalog = loadCatalog();
      const name = trimName(body && body.name);
      if (!name) return { error: 'folder name is required' };
      const folder = {
        id: nextId('folder'),
        name,
        order: nextOrder(catalog.folders),
      };
      catalog.folders.push(folder);
      saveCatalog(catalog);
      return { ok: true, folder };
    }

    const projectMatch = pathname.match(/^\/api\/session-projects\/projects\/([^/]+)$/);
    if (projectMatch && verb === 'PATCH') {
      const catalog = loadCatalog();
      const projectId = decodeURIComponent(projectMatch[1]);
      const index = catalog.projects.findIndex((p) => p.id === projectId);
      if (index < 0) return { error: 'project not found' };
      const current = catalog.projects[index];
      const next = { ...current };
      if (body && Object.prototype.hasOwnProperty.call(body, 'name')) {
        const name = trimName(body.name);
        if (!name) return { error: 'project name is required' };
        next.name = name;
      }
      if (body && Object.prototype.hasOwnProperty.call(body, 'folderId')) {
        const folderId = typeof body.folderId === 'string' && body.folderId.trim() ? body.folderId.trim() : null;
        if (folderId && !catalog.folders.some((f) => f.id === folderId)) {
          return { error: 'folder not found' };
        }
        if (folderId !== current.folderId) {
          next.folderId = folderId;
          next.order = nextOrder(catalog.projects.filter((p) => p.id !== current.id && p.folderId === folderId));
        }
      }
      if (body && Object.prototype.hasOwnProperty.call(body, 'workspacePath')) {
        next.workspacePath = normalizeWorkspacePath(body.workspacePath);
      }
      catalog.projects[index] = next;
      saveCatalog(catalog);
      return { ok: true, project: next };
    }

    if (projectMatch && verb === 'DELETE') {
      const catalog = loadCatalog();
      const projectId = decodeURIComponent(projectMatch[1]);
      catalog.projects = catalog.projects.filter((p) => p.id !== projectId);
      saveCatalog(catalog);
      const assignments = loadAssignments();
      const sessionPaths = [];
      Object.keys(assignments).forEach((path) => {
        if (assignments[path] === projectId) {
          sessionPaths.push(path);
          delete assignments[path];
        }
      });
      saveAssignments(assignments);
      return {
        ok: true,
        catalog,
        assignment: { sessionPaths, projectId: UNCATEGORIZED_PROJECT_ID },
      };
    }

    const folderMatch = pathname.match(/^\/api\/session-projects\/folders\/([^/]+)$/);
    if (folderMatch && verb === 'PATCH') {
      const catalog = loadCatalog();
      const folderId = decodeURIComponent(folderMatch[1]);
      const index = catalog.folders.findIndex((f) => f.id === folderId);
      if (index < 0) return { error: 'folder not found' };
      const next = { ...catalog.folders[index] };
      if (body && Object.prototype.hasOwnProperty.call(body, 'name')) {
        const name = trimName(body.name);
        if (!name) return { error: 'folder name is required' };
        next.name = name;
      }
      catalog.folders[index] = next;
      saveCatalog(catalog);
      return { ok: true, folder: next };
    }

    if (folderMatch && verb === 'DELETE') {
      const catalog = loadCatalog();
      const folderId = decodeURIComponent(folderMatch[1]);
      if (!catalog.folders.some((f) => f.id === folderId)) return { error: 'folder not found' };
      const moving = catalog.projects.filter((p) => p.folderId === folderId);
      let order = nextOrder(catalog.projects.filter((p) => p.folderId === null));
      const moved = new Map(moving.map((p) => [p.id, { ...p, folderId: null, order: order++ }]));
      catalog.folders = catalog.folders.filter((f) => f.id !== folderId);
      catalog.projects = catalog.projects.map((p) => moved.get(p.id) || p);
      saveCatalog(catalog);
      return { ok: true, catalog };
    }

    if (pathname === '/api/session-projects/projects/reorder' && verb === 'POST') {
      const catalog = loadCatalog();
      const folderId = body && typeof body.folderId === 'string' && body.folderId.trim() ? body.folderId.trim() : null;
      const ids = Array.isArray(body && body.projectIds) ? body.projectIds.filter((id) => typeof id === 'string') : [];
      const order = new Map(ids.map((id, index) => [id, index]));
      catalog.projects = catalog.projects.map((project) => {
        if (project.folderId !== folderId) return project;
        if (!order.has(project.id)) return project;
        return { ...project, order: order.get(project.id) };
      });
      saveCatalog(catalog);
      return { ok: true, catalog: loadCatalog() };
    }

    if (pathname === '/api/session-projects/folders/reorder' && verb === 'POST') {
      const catalog = loadCatalog();
      const ids = Array.isArray(body && body.folderIds) ? body.folderIds.filter((id) => typeof id === 'string') : [];
      const order = new Map(ids.map((id, index) => [id, index]));
      catalog.folders = catalog.folders.map((folder) => (
        order.has(folder.id) ? { ...folder, order: order.get(folder.id) } : folder
      ));
      saveCatalog(catalog);
      return { ok: true, catalog: loadCatalog() };
    }

    if (pathname === '/api/session-projects/session-assignment' && verb === 'POST') {
      const sessionPath = body && typeof body.sessionPath === 'string' ? body.sessionPath : '';
      if (!sessionPath) return { error: 'sessionPath is required' };
      const projectId = body && typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim()
        : null;
      if (projectId && projectId !== UNCATEGORIZED_PROJECT_ID) {
        const catalog = loadCatalog();
        if (!catalog.projects.some((project) => project.id === projectId)) return { error: 'project not found' };
      }
      const assignments = loadAssignments();
      if (!projectId || projectId === UNCATEGORIZED_PROJECT_ID) delete assignments[sessionPath];
      else assignments[sessionPath] = projectId;
      saveAssignments(assignments);
      return { ok: true, assignment: { sessionPath, projectId: projectId || UNCATEGORIZED_PROJECT_ID } };
    }

    return { error: 'studio bridge: unhandled ' + verb + ' ' + pathname };
  };



  // ── Hana settings ↔ Studio extra.llm ────────────────────────────────
  // Hana UI talks to /api/config + /api/providers/*. Studio persists LLM
  // under extra.llm. Overlay keeps Hana-only fields (api, headers) locally.
  const PROVIDER_OVERLAY_KEY = 'openhanako.providerOverlay.v1';

  const maskSecret = (value) => {
    if (typeof value !== 'string' || !value) return '';
    if (value.length <= 8) return '****';
    return value.slice(0, 3) + '****' + value.slice(-2);
  };

  const readOverlay = () => {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = JSON.parse(localStorage.getItem(PROVIDER_OVERLAY_KEY) || '{}');
        if (raw && typeof raw === 'object') {
          memoryStore.set(PROVIDER_OVERLAY_KEY, raw);
          return raw;
        }
      }
    } catch (_) { /* fall through to memory */ }
    const cached = memoryStore.get(PROVIDER_OVERLAY_KEY);
    return cached && typeof cached === 'object' ? cached : {};
  };

  const writeOverlay = (overlay) => {
    const value = overlay && typeof overlay === 'object' ? overlay : {};
    memoryStore.set(PROVIDER_OVERLAY_KEY, value);
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(PROVIDER_OVERLAY_KEY, JSON.stringify(value));
    } catch (_) {}
  };

  const modelIdOf = (entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof entry.id === 'string') return entry.id;
    return '';
  };

  const sanitizeModelMetadata = (raw) => {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const key of ['name', 'type', 'defaultThinkingLevel']) {
      if (typeof src[key] === 'string' && src[key].trim()) out[key] = src[key].trim().slice(0, 200);
    }
    for (const key of ['context', 'maxOutput']) {
      if (typeof src[key] === 'number' && Number.isFinite(src[key]) && src[key] > 0) out[key] = Math.floor(src[key]);
    }
    for (const key of ['image', 'video', 'audio', 'reasoning', 'xhigh']) {
      if (typeof src[key] === 'boolean') out[key] = src[key];
    }
    if (Array.isArray(src.input)) out.input = src.input.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 16);
    if (Array.isArray(src.thinkingLevels)) out.thinkingLevels = src.thinkingLevels.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 16);
    for (const key of ['compat', 'toolUse', 'visionCapabilities']) {
      if (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key])) out[key] = src[key];
    }
    return out;
  };
  const modelMetadataFor = (providerOverlay, modelId) => {
    const models = providerOverlay && providerOverlay.models && typeof providerOverlay.models === 'object' ? providerOverlay.models : {};
    const metadata = models[modelId];
    return metadata && typeof metadata === 'object' ? metadata : null;
  };
  const mergeModelEntry = (modelId, providerOverlay) => {
    const id = modelIdOf(modelId);
    if (!id) return null;
    const metadata = modelMetadataFor(providerOverlay, id);
    return metadata ? { id, ...metadata } : id;
  };
  const providerModelEntries = (providerOverlay, list, entry) => {
    const ids = list.length ? list.map(modelIdOf).filter(Boolean) : (entry.model ? [entry.model] : []);
    return ids.map((id) => mergeModelEntry(id, providerOverlay)).filter(Boolean);
  };

  const summarizeBaseUrl = (value) => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    const withoutTail = raw.replace(/[?#].*$/, '');
    const schemeAt = withoutTail.indexOf('://');
    if (schemeAt < 0) return withoutTail;
    const authorityStart = schemeAt + 3;
    const pathAt = withoutTail.indexOf('/', authorityStart);
    const authorityEnd = pathAt < 0 ? withoutTail.length : pathAt;
    const authority = withoutTail.slice(authorityStart, authorityEnd);
    const at = authority.lastIndexOf('@');
    if (at < 0) return withoutTail;
    return withoutTail.slice(0, authorityStart)
      + authority.slice(at + 1)
      + withoutTail.slice(authorityEnd);
  };

  const studioProvidersToHana = (llm) => {
    const root = llm && typeof llm === 'object' ? llm : {};
    const providersIn = root.providers && typeof root.providers === 'object' ? root.providers : {};
    const lists = root.model_lists && typeof root.model_lists === 'object' ? root.model_lists : {};
    const overlay = readOverlay();
    const out = {};
    Object.keys(providersIn).forEach((name) => {
      const entry = providersIn[name] && typeof providersIn[name] === 'object' ? providersIn[name] : {};
      const over = overlay[name] && typeof overlay[name] === 'object' ? overlay[name] : {};
      const list = Array.isArray(lists[name]) ? lists[name] : [];
      const models = providerModelEntries(over, list, entry);
      out[name] = {
        base_url: typeof entry.base_url === 'string' ? entry.base_url : (over.base_url || ''),
        api: typeof over.api === 'string' && over.api ? over.api : 'openai-completions',
        api_key: maskSecret(typeof entry.api_key === 'string' ? entry.api_key : ''),
        headers: over.headers && typeof over.headers === 'object' ? over.headers : {},
        models,
        model_count: models.length,
      };
    });
    return out;
  };

  const buildProvidersSummary = (llm) => {
    const root = llm && typeof llm === 'object' ? llm : {};
    const providersIn = root.providers && typeof root.providers === 'object' ? root.providers : {};
    const lists = root.model_lists && typeof root.model_lists === 'object' ? root.model_lists : {};
    const overlay = readOverlay();
    const summary = {};
    Object.keys(providersIn).forEach((name) => {
      const entry = providersIn[name] && typeof providersIn[name] === 'object' ? providersIn[name] : {};
      const over = overlay[name] && typeof overlay[name] === 'object' ? overlay[name] : {};
      const list = Array.isArray(lists[name]) ? lists[name] : [];
      const models = providerModelEntries(over, list, entry);
      const hasKey = !!(typeof entry.api_key === 'string' && entry.api_key.trim());
      const hasUrl = !!(typeof entry.base_url === 'string' && entry.base_url.trim());
      summary[name] = {
        display_name: name,
        has_credentials: hasKey || hasUrl,
        is_builtin: name === 'mock',
        is_configured: hasUrl,
        supports_oauth: false,
        is_coding_plan: false,
        models,
        base_url: summarizeBaseUrl(entry.base_url),
        api: typeof over.api === 'string' && over.api ? over.api : 'openai-completions',
      };
    });
    return summary;
  };

  const applyProvidersPatchToStudio = async (providersPatch) => {
    if (!providersPatch || typeof providersPatch !== 'object') {
      return api.getLlmConfig();
    }
    const overlay = readOverlay();
    const studioPatch = { providers: {}, model_lists: {} };
    let touchedLists = false;

    Object.keys(providersPatch).forEach((name) => {
      const patch = providersPatch[name];
      if (patch === null) {
        studioPatch.providers[name] = null;
        studioPatch.model_lists[name] = null;
        touchedLists = true;
        delete overlay[name];
        return;
      }
      if (!patch || typeof patch !== 'object') return;
      const entry = {};
      if (typeof patch.base_url === 'string') entry.base_url = patch.base_url.trim();
      if (typeof patch.api_key === 'string') entry.api_key = patch.api_key;
      if (typeof patch.model === 'string' && patch.model.trim()) entry.model = patch.model.trim();
      if (Array.isArray(patch.models)) {
        const ids = patch.models.map(modelIdOf).filter(Boolean);
        studioPatch.model_lists[name] = ids;
        touchedLists = true;
        if (!entry.model && ids[0]) entry.model = ids[0];
      }
      if (Object.keys(entry).length) studioPatch.providers[name] = entry;

      const over = overlay[name] && typeof overlay[name] === 'object' ? { ...overlay[name] } : {};
      if (typeof patch.api === 'string') over.api = patch.api;
      if (patch.headers && typeof patch.headers === 'object') over.headers = patch.headers;
      if (typeof patch.base_url === 'string') over.base_url = patch.base_url.trim();
      if (Object.keys(over).length) overlay[name] = over;
    });

    writeOverlay(overlay);
    if (!touchedLists) delete studioPatch.model_lists;
    const out = await api.setLlmConfig(studioPatch);
    try { await api.syncLlmAdapters(); } catch (_) { /* adapters may need restart */ }
    return out;
  };

  const handleProviderHttp = async (pathname, verb, body) => {
    // Returns null when this request is not a settings/provider route.
    if (pathname === '/api/config' && verb === 'GET') {
      const llm = await api.getLlmConfig();
      const userPrefs = loadUserPrefs();
      return {
        locale: 'zh-CN',
        editor: null,
        user: { name: userPrefs.name },
        studioBridge: api.mode(),
        providers: studioProvidersToHana(llm),
        llm,
      };
    }

    if (pathname === '/api/config' && (verb === 'PUT' || verb === 'PATCH' || verb === 'POST')) {
      const patch = body && typeof body === 'object' ? body : {};
      if (patch.user && typeof patch.user.name === 'string') {
        const name = trimName(patch.user.name);
        if (!name) return { ok: false, error: 'user name required' };
        saveUserPrefs({ ...loadUserPrefs(), name });
      }
      if (patch.providers && typeof patch.providers === 'object') {
        await applyProvidersPatchToStudio(patch.providers);
      }
      const llm = await api.getLlmConfig();
      const userPrefs = loadUserPrefs();
      return {
        ok: true,
        locale: 'zh-CN',
        user: { name: userPrefs.name },
        studioBridge: api.mode(),
        providers: studioProvidersToHana(llm),
      };
    }

    if (pathname === '/api/user-profile' && verb === 'GET') {
      const userPrefs = loadUserPrefs();
      return { content: userPrefs.profile, name: userPrefs.name, avatar: null };
    }

    if (pathname === '/api/user-profile' && (verb === 'PUT' || verb === 'PATCH' || verb === 'POST')) {
      if (!body || typeof body.content !== 'string') {
        return { ok: false, error: 'profile content required' };
      }
      const profile = body.content.slice(0, 65536);
      saveUserPrefs({ ...loadUserPrefs(), profile });
      return { ok: true, content: profile };
    }

    if (pathname === '/api/preferences/appearance' && verb === 'GET') {
      return { appearance: loadAppearance() };
    }

    if (pathname === '/api/preferences/appearance'
      && (verb === 'PUT' || verb === 'PATCH' || verb === 'POST')) {
      const patch = body && body.appearance && typeof body.appearance === 'object'
        ? body.appearance
        : body;
      return applyAppearancePatch(patch);
    }

    if (pathname === '/api/preferences/sidebar-ui' && verb === 'GET') {
      return { sidebarUi: loadSidebarUi() };
    }

    if (pathname === '/api/preferences/sidebar-ui'
      && (verb === 'PUT' || verb === 'PATCH' || verb === 'POST')) {
      const patch = body && body.sidebarUi && typeof body.sidebarUi === 'object'
        ? body.sidebarUi
        : body;
      return applySidebarUiPatch(patch);
    }

    if (pathname === '/api/preferences/quick-chat' && verb === 'GET') {
      return { quickChat: loadQuickChat() };
    }

    if (pathname === '/api/preferences/quick-chat'
      && (verb === 'PUT' || verb === 'PATCH' || verb === 'POST')) {
      const patch = body && body.quickChat && typeof body.quickChat === 'object'
        ? body.quickChat
        : body;
      return applyQuickChatPatch(patch);
    }

    if (pathname === '/api/preferences/notifications' && verb === 'GET') {
      return { notifications: loadNotificationPrefs() };
    }

    if (pathname === '/api/preferences/notifications'
      && (verb === 'PUT' || verb === 'PATCH' || verb === 'POST')) {
      const patch = body && body.notifications && typeof body.notifications === 'object'
        ? body.notifications
        : body;
      return applyNotificationPatch(patch);
    }

    if (pathname === '/api/providers/summary' && verb === 'GET') {
      const llm = await api.getLlmConfig();
      return { providers: buildProvidersSummary(llm) };
    }

    if (pathname === '/api/providers/fetch-models' && verb === 'POST') {
      const name = body && typeof body.name === 'string' ? body.name : (body && body.provider) || '';
      const baseUrl = body && (body.base_url || body.baseUrl) || '';
      const apiKey = body && (body.api_key || body.apiKey) || '';
      try {
        const result = await api.fetchLlmModels({
          provider: name || null,
          baseUrl: baseUrl || null,
          apiKey: apiKey || null,
        });
        const models = Array.isArray(result && result.models)
          ? result.models
          : (Array.isArray(result) ? result : []);
        // Normalize to { id } objects when Studio returns strings.
        const normalized = models.map((m) => (
          typeof m === 'string' ? { id: m } : (m && typeof m === 'object' ? m : null)
        )).filter(Boolean);
        return { models: normalized, ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err && err.message ? err.message : String(err),
          models: [],
        };
      }
    }

    if (pathname === '/api/providers/test' && verb === 'POST') {
      const name = body && typeof body.name === 'string' ? body.name : '';
      const baseUrl = body && (body.base_url || body.baseUrl) || '';
      const apiKey = body && (body.api_key || body.apiKey) || '';
      try {
        const result = await api.fetchLlmModels({
          provider: name || null,
          baseUrl: baseUrl || null,
          apiKey: apiKey || null,
        });
        const models = Array.isArray(result && result.models) ? result.models : [];
        return { ok: true, models };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }

    const apiKeyMatch = pathname.match(/^\/api\/providers\/([^/]+)\/api-key$/);
    if (apiKeyMatch && verb === 'GET') {
      const name = decodeURIComponent(apiKeyMatch[1]);
      const llm = await api.getLlmConfig();
      const entry = llm && llm.providers && llm.providers[name];
      const key = entry && typeof entry.api_key === 'string' ? entry.api_key : '';
      return { api_key: key, masked: maskSecret(key) };
    }

    const discoveredMatch = pathname.match(/^\/api\/providers\/([^/]+)\/discovered-models$/);
    if (discoveredMatch && verb === 'GET') {
      const name = decodeURIComponent(discoveredMatch[1]);
      const llm = await api.getLlmConfig();
      const lists = llm && llm.model_lists && llm.model_lists[name];
      const discovered = llm && llm.discovered && llm.discovered[name];
      const providerOverlay = readOverlay()[name] && typeof readOverlay()[name] === 'object' ? readOverlay()[name] : {};
      const rawModels = Array.isArray(discovered) ? discovered
        : (Array.isArray(lists) ? lists.map((id) => ({ id })) : []);
      const models = rawModels.map((model) => {
        const id = modelIdOf(model);
        const metadata = modelMetadataFor(providerOverlay, id);
        return metadata && model && typeof model === 'object' ? { ...model, ...metadata, id } : (metadata ? { id, ...metadata } : model);
      });
      return { models };
    }

    const modelMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models\/([^/]+)$/);
    if (modelMatch && (verb === 'PATCH' || verb === 'PUT' || verb === 'DELETE')) {
      const provider = decodeURIComponent(modelMatch[1]);
      const modelId = decodeURIComponent(modelMatch[2]);
      const llm = await api.getLlmConfig();
      const list = Array.isArray(llm?.model_lists?.[provider]) ? llm.model_lists[provider] : [];
      if (!list.some((entry) => modelIdOf(entry) === modelId)) return { ok: false, error: 'model not configured for provider' };
      const overlay = readOverlay();
      const over = overlay[provider] && typeof overlay[provider] === 'object' ? { ...overlay[provider] } : {};
      const models = over.models && typeof over.models === 'object' ? { ...over.models } : {};
      if (verb === 'DELETE') {
        delete models[modelId];
      } else {
        const metadata = sanitizeModelMetadata(body);
        if (!Object.keys(metadata).length) return { ok: false, error: 'model metadata required' };
        models[modelId] = metadata;
      }
      if (Object.keys(models).length) over.models = models;
      else delete over.models;
      if (Object.keys(over).length) overlay[provider] = over;
      else delete overlay[provider];
      writeOverlay(overlay);
      const metadata = modelMetadataFor(over, modelId);
      return { ok: true, model: { id: modelId, ...(metadata || {}) } };
    }

    if (pathname === '/api/preferences/models' && verb === 'GET') {
      const llm = await api.getLlmConfig();
      const current = llm && llm.current && typeof llm.current === 'object' ? llm.current : {};
      const saved = loadGlobalModelPrefs();
      const utility = saved.models.utility || (current.provider && current.model
        ? { provider: current.provider, id: current.model }
        : null);
      return {
        models: {
          utility,
          utility_large: saved.models.utility_large,
          vision: saved.models.vision,
          vision_enabled: saved.models.vision_enabled,
        },
        search: { provider: saved.search.provider, api_key: '', api_keys: {} },
        utility_api: { provider: '', base_url: '', api_key: '' },
        thinking_level: 'medium',
        capabilitySource: 'studio+local-overlay',
      };
    }

    if (pathname === '/api/preferences/models' && (verb === 'PUT' || verb === 'POST' || verb === 'PATCH')) {
      return await applyGlobalModelPrefsPatch(body);
    }

    return null;
  };


  const configuredModelFallback = async () => {
    try {
      const llm = await api.getLlmConfig();
      const current = llm && llm.current && typeof llm.current === 'object' ? llm.current : {};
      const provider = (typeof current.provider === 'string' && current.provider)
        || (typeof llm?.default === 'string' && llm.default)
        || api.DEFAULT_PROVIDER;
      const currentMatchesProvider = current.provider === provider;
      const providerModel = llm?.providers?.[provider]?.model;
      const listed = Array.isArray(llm?.model_lists?.[provider]) ? llm.model_lists[provider] : [];
      const firstListed = listed
        .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
        .find(Boolean);
      return {
        provider,
        modelId: (currentMatchesProvider && typeof current.model === 'string' && current.model)
          || providerModel
          || firstListed
          || (provider === api.DEFAULT_PROVIDER ? api.DEFAULT_MODEL : provider),
      };
    } catch (_) {
      return { provider: api.DEFAULT_PROVIDER, modelId: api.DEFAULT_MODEL };
    }
  };

  const projection = (row, fallbackModel = null) => {
    const path = pathFor(row.id);
    const pin = loadPins()[path] || null;
    const localTitle = loadTitles()[path] || null;
    const activeTurn = activeTurns.get(String(row.id || ''));
    const isStreaming = !!(activeTurn && isActiveTurn(activeTurn));
    const storedModel = storedModelForPath(path);
    const rowProvider = typeof row.provider === 'string' && row.provider ? row.provider : '';
    const rowModel = typeof row.model === 'string' && row.model ? row.model : '';
    const sessionModel = rowProvider && rowModel
      ? { provider: rowProvider, modelId: rowModel }
      : storedModel || fallbackModel || { provider: api.DEFAULT_PROVIDER, modelId: api.DEFAULT_MODEL };
    const status = row.busy || isStreaming
      ? 'running'
      : (row.status || (row.error ? 'error' : 'idle'));
    const updatedAt = row.updated_at ?? row.updatedAt ?? null;
    const timestamp = updatedAt == null ? null : new Date(updatedAt);
    const isoTimestamp = timestamp && !Number.isNaN(timestamp.getTime())
      ? timestamp.toISOString()
      : null;
    return {
      path,
      sessionId: row.id,
      title: localTitle || row.title || null,
      firstMessage: localTitle || row.title || '',
      ...(isoTimestamp ? { modified: isoTimestamp, created: isoTimestamp } : {}),
      messageCount: row.messages || 0,
      cwd: typeof row.cwd === 'string' && row.cwd ? row.cwd : null,
      ...(row.workspaceMountId ? { workspaceMountId: row.workspaceMountId } : {}),
      ...(row.workspaceLabel ? { workspaceLabel: row.workspaceLabel } : {}),
      agentId: ASSISTANT_ID,
      agentName: ASSISTANT_NAME,
      modelId: sessionModel.modelId,
      modelProvider: sessionModel.provider,
      pinnedAt: pin ? pin.pinnedAt : null,
      pinOrder: pin && Number.isFinite(pin.pinOrder) ? pin.pinOrder : null,
      live: row.live !== false,
      busy: !!row.busy,
      status,
      isStreaming,
      error: row.error || null,
      projectId: loadAssignments()[path] || null,
    };
  };

  const runtimeToolState = (rows) => {
    const results = toolResultsFromTranscript(rows || []);
    const active = [];
    const failed = [];
    for (const message of (rows || [])) {
      if (!message || !Array.isArray(message.tool_calls)) continue;
      for (const call of message.tool_calls) {
        const id = toolCallId(call);
        if (!id) continue;
        const result = results.get(id);
        if (!result) {
          active.push({
            id,
            name: call.name || 'tool',
            args: parseToolArgs(call.arguments),
            startedAt: toolTimestamp(call, 'started_at', 'startedAt'),
          });
          continue;
        }
        if (result.is_error === true || result.isError === true || result.success === false || result.status === 'failed') {
          failed.push({
            id,
            name: call.name || 'tool',
            error: toolResultText(result.content ?? result.output) || 'tool failed',
          });
        }
      }
    }
    return { active, failed };
  };

  const cachedTranscriptForRow = async (row, base = projection(row)) => {
    const cacheKey = runtimeTranscriptKey(row, base);
    const cached = runtimeTranscriptCache.get(row.id) || null;
    if (!base.busy && !base.isStreaming && cached?.key === cacheKey) {
      if (cached.pending) return cached.pending;
      if (Array.isArray(cached.transcript)) return cached.transcript;
    }

    const previousTranscript = Array.isArray(cached?.transcript) ? cached.transcript : [];
    const pending = Promise.resolve(api.transcript(row.id))
      .then((transcript) => {
        const normalized = Array.isArray(transcript) ? transcript : [];
        if (!base.busy && !base.isStreaming) {
          runtimeTranscriptCache.set(row.id, { key: cacheKey, transcript: normalized, pending: null });
        }
        return normalized;
      })
      .catch(() => previousTranscript);

    if (!base.busy && !base.isStreaming) {
      runtimeTranscriptCache.set(row.id, {
        key: cacheKey,
        transcript: previousTranscript,
        pending,
      });
    }
    return pending;
  };

  const runtimeProjection = async (row) => {
    const base = projection(row);
    const transcript = await cachedTranscriptForRow(row, base);
    const tools = runtimeToolState(transcript);
    const failure = base.error || (tools.failed.length ? tools.failed[tools.failed.length - 1].error : null);
    return {
      sessionId: row.id,
      path: base.path,
      title: base.title,
      status: failure ? 'error' : base.status,
      busy: base.busy,
      isStreaming: base.isStreaming,
      live: base.live,
      activeToolCount: tools.active.length,
      activeTools: tools.active,
      failedTools: tools.failed,
      error: failure,
      messageCount: base.messageCount,
    };
  };

  const runtimeSignature = (sessions) => (Array.isArray(sessions) ? sessions : [])
    .map((state) => [
      state?.sessionId || '',
      state?.status || '',
      state?.isStreaming ? 1 : 0,
      Number(state?.activeToolCount) || 0,
      state?.error || '',
    ].join(':'))
    .sort()
    .join('|');

  const sessionIdOf = (body, query) => {
    // Prefer path/sessionPath from the clicked row — sessionId alone has been
    // observed to point at the *current* session while path points at another,
    // which made archive/delete dispose the wrong agent mid-reply.
    const fromBody = body && (body.path || body.sessionPath || body.sessionId);
    const fromQuery = query && (query.path || query.sessionId);
    const pathId = idFrom(body && (body.path || body.sessionPath));
    const sid = idFrom(body && body.sessionId);
    if (pathId && sid && pathId !== sid) {
      try { console.warn('[openhanako] dispose id mismatch; preferring path', { pathId, sid }); } catch (_) {}
      return pathId;
    }
    return idFrom(fromBody || fromQuery);
  };

  // Studio stores tool arguments as the model's raw JSON string; the renderer
  // wants an object. Bad JSON degrades to `undefined` rather than throwing.
  const parseToolArgs = (raw) => {
    if (raw == null) return undefined;
    if (typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch (_) {
      return undefined;
    }
  };

  const toolCallId = (value) => {
    if (!value || typeof value !== 'object') return '';
    const id = value.id ?? value.call_id ?? value.tool_call_id ?? value.toolCallId;
    return id == null ? '' : String(id);
  };

  const toolTimestamp = (value, snakeKey, camelKey) => {
    if (!value || typeof value !== 'object') return undefined;
    const timestamp = value[snakeKey] ?? value[camelKey];
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
  };

  const toolResultText = (content) => {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        try { return JSON.stringify(part); } catch (_) { return String(part); }
      }).filter(Boolean).join('\n');
    }
    try { return JSON.stringify(content, null, 2); } catch (_) { return String(content); }
  };

  const parseToolDetails = (content) => {
    if (content == null) return undefined;
    if (typeof content === 'object' && !Array.isArray(content)) return content;
    const trimmed = toolResultText(content).trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch (_) {
      return undefined;
    }
  };

  // Echo the fields the client attached to an optimistic user message back on
  // `session_user_message`. Only non-null values are included, so a missing
  // field never overwrites the optimistic one (the client confirms with a
  // shallow spread, where an explicit `undefined` would clobber).
  const displayFields = (displayMessage) => {
    if (!displayMessage || typeof displayMessage !== 'object') return {};
    const out = {};
    const copyAs = [
      ['quotedText', 'quotedText'],
      ['attachments', 'attachments'],
      ['skills', 'skills'],
      ['sessionRefs', 'sessionRefs'],
      ['agentMentions', 'agentMentions'],
    ];
    for (const [from, to] of copyAs) {
      const value = displayMessage[from];
      if (value == null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      out[to] = value;
    }
    return out;
  };

  // Todo tools carry the authoritative list in their CALL ARGUMENTS. `activeForm`
  // is required by the frontend's todo gate, so fall back to `content` when the
  // model (or dsh's minimal schema) omits it.
  const TODO_TOOL_NAMES = new Set(['todo', 'todo_write']);
  const todoDetailsFromArgs = (name, args) => {
    if (!TODO_TOOL_NAMES.has(name)) return undefined;
    const list = args && Array.isArray(args.todos) ? args.todos : null;
    if (!list) return undefined;
    const todos = list.map((entry) => {
      const content = entry && typeof entry.content === 'string' ? entry.content : '';
      const activeForm = entry && typeof entry.activeForm === 'string' && entry.activeForm
        ? entry.activeForm
        : content;
      const status = entry && (entry.status === 'in_progress' || entry.status === 'completed')
        ? entry.status
        : 'pending';
      return { content, activeForm, status };
    }).filter((t) => t.content);
    return { todos };
  };

  const toolResultsFromTranscript = (rows) => {
    const results = new Map();
    for (const message of (rows || [])) {
      for (const result of (message && Array.isArray(message.tool_results) ? message.tool_results : [])) {
        const id = toolCallId(result);
        if (id) results.set(id, result);
      }
    }
    return results;
  };

  // Latest successful todo snapshot from the transcript. Studio projects tool
  // calls and results into separate assistant/user rows, so pair globally by id.
  const todosFromTranscript = (rows, results = toolResultsFromTranscript(rows)) => {
    let latest = null;
    for (const m of (rows || [])) {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        if (!tc || !TODO_TOOL_NAMES.has(tc.name)) continue;
        const id = toolCallId(tc);
        const result = id ? results.get(id) : null;
        if (!result) continue;
        if (result.is_error === true || result.isError === true || result.success === false || result.status === 'failed') continue;
        const details = todoDetailsFromArgs(tc.name, parseToolArgs(tc.arguments));
        if (details) latest = details.todos;
      }
    }
    return latest || [];
  };

  const transcriptEntryId = (index, role) => `studio-entry:${index}:${role}`;

  const historyMessage = (m, index, transcriptResults, turnInputEntryId = null) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = m.text || '';
    const entryId = transcriptEntryId(index, role);
    const row = {
      id: String(index),
      entryId,
      role,
      content: text,
      timestamp: Date.now(),
      ...(role === 'assistant' && turnInputEntryId ? { turnInputEntryId } : {}),
    };
    if (role === 'assistant' && m.reasoning) row.thinking = m.reasoning;
    // Tools must survive history hydration or they vanish on reload / switch:
    // the process UI and todo list are rebuilt from these, not from the live
    // event buffer. `arguments` is a raw JSON string in Studio; parse it back to
    // the object the renderer expects, and merge the matching tool_result so
    // done/success/error/details are populated.
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const results = transcriptResults || toolResultsFromTranscript([m]);
      row.toolCalls = m.tool_calls
        .filter((tc) => tc && tc.name)
        .map((tc) => {
          const id = toolCallId(tc) || undefined;
          const res = id ? results.get(id) : null;
          const isError = !!(res && (res.is_error === true || res.isError === true));
          const resultContent = res ? (res.content ?? res.output) : undefined;
          const output = res ? toolResultText(resultContent) : '';
          const resultDetails = res
            ? ((res.details && typeof res.details === 'object' ? res.details : undefined)
              || parseToolDetails(resultContent))
            : undefined;
          const todoDetails = res && !isError
            ? todoDetailsFromArgs(tc.name, parseToolArgs(tc.arguments))
            : undefined;
          const parsedDetails = todoDetails
            ? {
                ...(resultDetails && !Array.isArray(resultDetails) ? resultDetails : {}),
                ...todoDetails,
              }
            : resultDetails;
          const startedAt = toolTimestamp(tc, 'started_at', 'startedAt');
          const finishedAt = res ? toolTimestamp(res, 'finished_at', 'finishedAt') : undefined;
          return {
            ...(id ? { id } : {}),
            name: String(tc.name),
            args: parseToolArgs(tc.arguments),
            status: res ? (isError ? 'failed' : 'succeeded') : 'unknown',
            success: res ? !isError : false,
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(finishedAt !== undefined ? { finishedAt } : {}),
            ...(output ? { output } : {}),
            ...(parsedDetails ? { details: parsedDetails } : {}),
            ...(isError && output ? { error: output } : {}),
          };
        });
    }
    return row;
  };

  const historyMessages = (rows, transcriptResults) => {
    const out = [];
    let lastUserEntryId = null;
    for (let index = 0; index < (rows || []).length; index += 1) {
      const message = rows[index];
      const transportOnly = message?.role === 'user'
        && !message.text
        && !message.reasoning
        && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
        && Array.isArray(message.tool_results)
        && message.tool_results.length > 0;
      if (transportOnly) continue;
      const row = historyMessage(message, index, transcriptResults, lastUserEntryId);
      out.push(row);
      if (row.role === 'user') lastUserEntryId = row.entryId;
    }
    return out;
  };

  // Soft stubs for openhanako surfaces that are not part of the Studio agent
  // vertical slice. Returning empty/ok stops noisy 404s in the harness and
  // iframe console without pretending the feature exists.
  const stubHttp = async (pathname, verb, body) => {
    const fileSurfaceCapabilityUnavailable = (surface) => ({
      ok: false,
      code: 'capability_unavailable',
      error: `studio backend does not expose ${surface} commands yet`,
      __httpStatus: 501,
    });
    if (
      pathname === '/api/desk/files'
      || pathname === '/api/desk/search-files'
      || pathname === '/api/desk/jian'
      || pathname === '/api/file-history'
      || pathname.startsWith('/api/file-history/')
      || pathname === '/api/resource-io'
      || pathname.startsWith('/api/resource-io/')
      || pathname === '/api/resources'
      || pathname.startsWith('/api/resources/')
      || pathname === '/api/workbench'
      || pathname.startsWith('/api/workbench/')
      || pathname === '/api/mobile/workbench'
      || pathname.startsWith('/api/mobile/workbench/')
    ) {
      return fileSurfaceCapabilityUnavailable('file/workbench/preview');
    }
    if (pathname === '/api/preferences/models' && verb === 'GET') {
      return {
        models: [{ id: api.DEFAULT_MODEL, name: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER }],
        current: api.DEFAULT_MODEL,
      };
    }
    if (pathname === '/api/session-thinking-level' && verb === 'GET') {
      return {
        thinkingLevel: 'medium',
        level: 'medium',
        locked: true,
        supportedLevels: ['medium'],
        code: 'capability_unavailable',
        error: 'studio backend does not expose a session thinking-level control yet',
      };
    }
    if (pathname === '/api/session-thinking-level' && verb === 'POST') {
      return {
        ok: false,
        thinkingLevel: 'medium',
        level: 'medium',
        locked: true,
        supportedLevels: ['medium'],
        code: 'capability_unavailable',
        error: 'studio backend does not expose a session thinking-level control yet',
      };
    }
    if (pathname === '/api/desk/cron') {
      return handleAutomationHttp(verb, body);
    }
    if (pathname === '/api/agents/primary' && verb === 'GET') {
      return { id: ASSISTANT_ID, name: ASSISTANT_NAME };
    }
    if (pathname === '/api/agents/switch' && verb === 'POST') {
      return {
        ok: false,
        agentId: ASSISTANT_ID,
        code: 'capability_unavailable',
        error: 'studio backend does not expose primary-agent switching yet',
      };
    }
    if (pathname === '/api/models/auxiliary-vision' && verb === 'GET') {
      const llm = await api.getLlmConfig();
      const lists = llm && llm.model_lists && typeof llm.model_lists === 'object' ? llm.model_lists : {};
      const visionModels = [];
      Object.keys(lists).forEach((provider) => {
        const providerOverlay = readOverlay()[provider] && typeof readOverlay()[provider] === 'object' ? readOverlay()[provider] : {};
        const ids = Array.isArray(lists[provider]) ? lists[provider] : [];
        ids.forEach((entry) => {
          const id = modelIdOf(entry);
          const metadata = modelMetadataFor(providerOverlay, id) || {};
          const input = Array.isArray(metadata.input) ? metadata.input : [];
          if (metadata.image === true || input.includes('image')) {
            visionModels.push({ id, provider, name: metadata.name || id, ...metadata });
          }
        });
      });
      return visionModels.length
        ? { available: true, models: visionModels, source: 'local-model-metadata' }
        : { available: false, models: [], code: 'capability_unavailable', error: 'no model is marked as image-capable' };
    }
    if (pathname === '/api/capabilities' && verb === 'GET') {
      let visionAvailable = false;
      try {
        const llm = await api.getLlmConfig();
        const lists = llm && llm.model_lists && typeof llm.model_lists === 'object' ? llm.model_lists : {};
        const overlay = readOverlay();
        for (const provider of Object.keys(lists)) {
          const providerOverlay = overlay[provider] && typeof overlay[provider] === 'object' ? overlay[provider] : {};
          for (const entry of (Array.isArray(lists[provider]) ? lists[provider] : [])) {
            const id = modelIdOf(entry);
            const metadata = modelMetadataFor(providerOverlay, id) || {};
            const input = Array.isArray(metadata.input) ? metadata.input : [];
            if (metadata.image === true || input.includes('image')) {
              visionAvailable = true;
              break;
            }
          }
          if (visionAvailable) break;
        }
      } catch (_) {
        visionAvailable = false;
      }
      return {
        ok: true,
        source: 'studio',
        capabilities: {
          modelSwitch: true,
          modelMetadata: true,
          vision: visionAvailable,
          uploadBlob: typeof api.uploadBlobAvailable === 'function' && api.uploadBlobAvailable(),
          thinkingLevel: false,
          permissionMode: false,
          primaryAgentSwitch: false,
          sessionSearch: true,
          sessionProjects: true,
          runtimeIncremental: true,
          sessionCompaction: typeof api.freshCompactSessionAvailable === 'function' && api.freshCompactSessionAvailable(),
          deletedAgentContinuation: typeof api.continueDeletedAgentSessionAvailable === 'function' && api.continueDeletedAgentSessionAvailable(),
          sessionSummary: typeof api.sessionSummaryAvailable === 'function' && api.sessionSummaryAvailable(),
          authorizedFolders: typeof api.sessionFolderScopeAvailable === 'function' && api.sessionFolderScopeAvailable(),
          sessionTodoMutation: typeof api.completeSessionTodosAvailable === 'function' && api.completeSessionTodosAvailable(),
          fileWorkbench: typeof api.workbenchListFilesAvailable === 'function'
            && typeof api.workbenchReadFileAvailable === 'function'
            && typeof api.workbenchWriteFileAvailable === 'function'
            && typeof api.workbenchSearchFilesAvailable === 'function'
            && api.workbenchListFilesAvailable()
            && api.workbenchReadFileAvailable()
            && api.workbenchWriteFileAvailable()
            && api.workbenchSearchFilesAvailable(),
          fileWorkbenchList: typeof api.workbenchListFilesAvailable === 'function' && api.workbenchListFilesAvailable(),
          fileWorkbenchRead: typeof api.workbenchReadFileAvailable === 'function' && api.workbenchReadFileAvailable(),
          fileWorkbenchWrite: typeof api.workbenchWriteFileAvailable === 'function' && api.workbenchWriteFileAvailable(),
          fileWorkbenchSearch: typeof api.workbenchSearchFilesAvailable === 'function' && api.workbenchSearchFilesAvailable(),
          fileWorkbenchRename: typeof api.workbenchRenameFileAvailable === 'function' && api.workbenchRenameFileAvailable(),
          fileWorkbenchMove: typeof api.workbenchMoveFileAvailable === 'function' && api.workbenchMoveFileAvailable(),
          fileWorkbenchDelete: typeof api.workbenchDeleteFileAvailable === 'function' && api.workbenchDeleteFileAvailable(),
          fileWorkbenchUpload: typeof api.workbenchUploadFileAvailable === 'function' && api.workbenchUploadFileAvailable(),
          fileHistory: typeof api.fileHistoryListFilesAvailable === 'function'
            && typeof api.fileHistoryListVersionsAvailable === 'function'
            && typeof api.fileHistoryGetSnapshotAvailable === 'function'
            && typeof api.fileHistoryRestoreAvailable === 'function'
            && api.fileHistoryListFilesAvailable()
            && api.fileHistoryListVersionsAvailable()
            && api.fileHistoryGetSnapshotAvailable()
            && api.fileHistoryRestoreAvailable(),
          fileHistoryList: typeof api.fileHistoryListFilesAvailable === 'function' && api.fileHistoryListFilesAvailable(),
          fileHistoryVersions: typeof api.fileHistoryListVersionsAvailable === 'function' && api.fileHistoryListVersionsAvailable(),
          fileHistorySnapshot: typeof api.fileHistoryGetSnapshotAvailable === 'function' && api.fileHistoryGetSnapshotAvailable(),
          fileHistoryRestore: typeof api.fileHistoryRestoreAvailable === 'function' && api.fileHistoryRestoreAvailable(),
          checkpointList: typeof api.checkpointListAvailable === 'function' && api.checkpointListAvailable(),
          checkpointCreateUserEdit: typeof api.checkpointCreateUserEditAvailable === 'function' && api.checkpointCreateUserEditAvailable(),
          checkpointRestore: typeof api.checkpointRestoreAvailable === 'function' && api.checkpointRestoreAvailable(),
          checkpointRemove: typeof api.checkpointRemoveAvailable === 'function' && api.checkpointRemoveAvailable(),
          checkpoints: typeof api.checkpointListAvailable === 'function'
            && typeof api.checkpointCreateUserEditAvailable === 'function'
            && typeof api.checkpointRestoreAvailable === 'function'
            && typeof api.checkpointRemoveAvailable === 'function'
            && api.checkpointListAvailable()
            && api.checkpointCreateUserEditAvailable()
            && api.checkpointRestoreAvailable()
            && api.checkpointRemoveAvailable(),
          resourceIO: typeof api.resourceIOStatAvailable === 'function'
            && typeof api.resourceIOReadAvailable === 'function'
            && typeof api.resourceIOListAvailable === 'function'
            && typeof api.resourceIOSearchAvailable === 'function'
            && typeof api.resourceIOWriteAvailable === 'function'
            && typeof api.resourceIOWriteExpectedVersionAvailable === 'function'
            && typeof api.resourceIORenameAvailable === 'function'
            && typeof api.resourceIOMoveAvailable === 'function'
            && typeof api.resourceIOTrashAvailable === 'function'
            && api.resourceIOStatAvailable()
            && api.resourceIOReadAvailable()
            && api.resourceIOListAvailable()
            && api.resourceIOSearchAvailable()
            && api.resourceIOWriteAvailable()
            && api.resourceIOWriteExpectedVersionAvailable()
            && api.resourceIORenameAvailable()
            && api.resourceIOMoveAvailable()
            && api.resourceIOTrashAvailable(),
          resourceIOStat: typeof api.resourceIOStatAvailable === 'function' && api.resourceIOStatAvailable(),
          resourceIORead: typeof api.resourceIOReadAvailable === 'function' && api.resourceIOReadAvailable(),
          resourceIOList: typeof api.resourceIOListAvailable === 'function' && api.resourceIOListAvailable(),
          resourceIOSearch: typeof api.resourceIOSearchAvailable === 'function' && api.resourceIOSearchAvailable(),
          resourceIOWrite: typeof api.resourceIOWriteAvailable === 'function' && api.resourceIOWriteAvailable(),
          resourceIOWriteExpectedVersion: typeof api.resourceIOWriteExpectedVersionAvailable === 'function' && api.resourceIOWriteExpectedVersionAvailable(),
          resourceIORename: typeof api.resourceIORenameAvailable === 'function' && api.resourceIORenameAvailable(),
          resourceIOMove: typeof api.resourceIOMoveAvailable === 'function' && api.resourceIOMoveAvailable(),
          resourceIOTrash: typeof api.resourceIOTrashAvailable === 'function' && api.resourceIOTrashAvailable(),
          generatedResourcePreview: typeof api.resourceGetMetadataAvailable === 'function'
            && typeof api.resourceReadContentAvailable === 'function'
            && api.resourceGetMetadataAvailable()
            && api.resourceReadContentAvailable(),
          resourceMetadata: typeof api.resourceGetMetadataAvailable === 'function' && api.resourceGetMetadataAvailable(),
          resourceContent: typeof api.resourceReadContentAvailable === 'function' && api.resourceReadContentAvailable(),
        },
      };
    }
    if (pathname === '/api/upload-blob' && verb === 'POST') {
      if (typeof api.uploadBlob !== 'function' || typeof api.uploadBlobAvailable !== 'function' || !api.uploadBlobAvailable()) {
        return {
          ok: false,
          code: 'capability_unavailable',
          error: 'studio backend does not expose a file/blob ingest command yet',
        };
      }
      const payload = body && typeof body === 'object' ? body : {};
      const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'upload.bin';
      const base64Data = typeof payload.base64Data === 'string' ? payload.base64Data : '';
      const mimeType = typeof payload.mimeType === 'string' && payload.mimeType.trim()
        ? payload.mimeType.trim()
        : 'application/octet-stream';
      const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : (typeof payload.sessionPath === 'string' && payload.sessionPath.startsWith('studio://')
          ? payload.sessionPath.slice('studio://'.length)
          : null);
      try {
        const upload = await api.uploadBlob({ sessionId, name, base64Data, mimeType });
        if (!upload?.ok || !upload?.fileId || !upload?.dest) {
          return {
            ok: false,
            code: upload?.code || 'upload_failed',
            error: upload?.error || 'studio upload failed',
          };
        }
        studioUploadedFiles.set(String(upload.fileId), String(upload.dest));
        return {
          ok: true,
          uploads: [{
            fileId: String(upload.fileId),
            dest: String(upload.dest),
            path: String(upload.dest),
            name: upload.name || name,
            mimeType: upload.mimeType || mimeType,
            size: upload.size,
            kind: upload.kind,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          code: error?.code === 'capability_unavailable' ? 'capability_unavailable' : 'upload_failed',
          error: message,
        };
      }
    }
    if (pathname.startsWith('/api/bridge')) {
      return { ok: true, studioBridge: api.mode() };
    }
    if (pathname === '/api/sessions/continue-deleted-agent' && verb === 'POST') {
      if (typeof api.continueDeletedAgentSession !== 'function' || typeof api.continueDeletedAgentSessionAvailable !== 'function' || !api.continueDeletedAgentSessionAvailable()) {
        return {
          ok: false,
          code: 'capability_unavailable',
          error: 'studio backend does not expose deleted-agent continuation yet',
        };
      }
      const sessionId = sessionIdFromBody(body, null);
      if (!sessionId) {
        return { ok: false, code: 'invalid_session', error: 'missing session id' };
      }
      try {
        const result = await api.continueDeletedAgentSession(sessionId);
        if (!result || result.ok !== true || !result.path) {
          return {
            ok: false,
            code: result?.code || 'continuation_failed',
            error: result?.error || 'studio deleted-agent continuation failed',
          };
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error?.code === 'capability_unavailable'
          ? 'capability_unavailable'
          : message === 'agent_not_deleted'
            ? 'agent_not_deleted'
            : message === 'session_not_found'
              ? 'session_not_found'
              : message === 'session_transcript_empty'
                ? 'session_transcript_empty'
                : 'continuation_failed';
        return { ok: false, code, error: message };
      }
    }
    if (pathname === '/api/sessions/fresh-compact' && verb === 'POST') {
      if (typeof api.freshCompactSession !== 'function' || typeof api.freshCompactSessionAvailable !== 'function' || !api.freshCompactSessionAvailable()) {
        return {
          ok: false,
          code: 'capability_unavailable',
          error: 'studio backend does not expose persisted session compaction yet',
        };
      }
      const sessionId = sessionIdFromBody(body, null);
      if (!sessionId) {
        return { ok: false, code: 'invalid_session', error: 'missing session id' };
      }
      try {
        const result = await api.freshCompactSession(sessionId);
        if (!result || result.fresh !== true) {
          return {
            ok: false,
            code: result?.code || 'compaction_failed',
            error: result?.error || 'studio fresh compact failed',
          };
        }
        return { ok: true, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error?.code === 'capability_unavailable'
          ? 'capability_unavailable'
          : message === 'session is busy'
            ? 'session_busy'
            : 'compaction_failed';
        return { ok: false, code, error: message };
      }
    }
    if (pathname === '/api/sessions/todos/complete' && verb === 'POST') {
      if (typeof api.completeSessionTodos !== 'function' || typeof api.completeSessionTodosAvailable !== 'function' || !api.completeSessionTodosAvailable()) {
        return {
          ok: false,
          code: 'capability_unavailable',
          error: 'studio backend does not expose persisted session todo mutation yet',
        };
      }
      const sessionId = sessionIdFromBody(body, null);
      if (!sessionId) {
        return { ok: false, code: 'invalid_session', error: 'missing session id' };
      }
      try {
        const completed = await api.completeSessionTodos(sessionId);
        if (!Array.isArray(completed)) {
          return {
            ok: false,
            code: 'todo_mutation_failed',
            error: 'studio did not acknowledge completed TODO snapshot',
          };
        }
        return { ok: true, todos: [], completed };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error?.code === 'capability_unavailable'
          ? 'capability_unavailable'
          : message === 'session is busy'
            ? 'session_busy'
            : 'todo_mutation_failed';
        return { ok: false, code, error: message };
      }
    }
    return null;
  };

  // Ids we successfully disposed this process — refuse silent resume so a
  // deleted/archived session cannot sticky-reattach via ensureLive.
  const disposedIds = new Set();

  const ensureLive = async (sessionId) => {
    if (!sessionId) throw new Error('missing session');
    if (archivedRecord(sessionId)) throw new Error('session is archived');
    if (disposedIds.has(sessionId)) {
      throw new Error('session was archived/deleted');
    }
    const rows = await api.sessions();
    const row = rows.find((s) => s.id === sessionId);
    // Missing from the list: may still be on disk (stale UI id) — try resume
    // so switch/send do not silently keep a dead sticky sessionId.
    if (!row) {
      try {
        const resumed = await api.resume(sessionId);
        if (!resumed) throw new Error('session not found');
        return resumed;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        throw new Error(msg || 'session not found');
      }
    }
    if (row.live === false) {
      const resumed = await api.resume(sessionId);
      if (!resumed) throw new Error('session resume failed');
      return resumed;
    }
    return sessionId;
  };

  const sessionIdFromBody = (body, query) => sessionIdOf(body, query);

  const purgeSessionMetadata = (sessionId) => {
    if (!sessionId) return;
    const path = pathFor(sessionId);
    runtimeTranscriptCache.delete(sessionId);
    clearPinForSession(sessionId);

    const titles = loadTitles();
    if (titles[path] || titles[String(sessionId)]) {
      delete titles[path];
      delete titles[String(sessionId)];
      saveTitles(titles);
    }

    const archived = loadArchived();
    if (archived[path] || archived[String(sessionId)]) {
      delete archived[path];
      delete archived[String(sessionId)];
      saveArchived(archived);
    }

    const models = loadSessionModels();
    if (models[path] || models[String(sessionId)]) {
      delete models[path];
      delete models[String(sessionId)];
      saveSessionModels(models);
    }

    const assignments = loadAssignments();
    if (assignments[path] || assignments[String(sessionId)]) {
      delete assignments[path];
      delete assignments[String(sessionId)];
      saveAssignments(assignments);
    }
  };

  /** Archive/delete must dispose the driver AND purge the JSONL (Studio side). */
  const disposeSession = async (sessionId) => {
    if (!sessionId) return { ok: false, error: 'missing session' };
    // Seal callbacks before disposal. `send_message` may still be awaiting the
    // driver, but no late progress may repopulate a deleted session in Hana.
    deactivateTurn(activeTurns.get(sessionId));
    try {
      await api.dispose(sessionId);
      disposedIds.add(sessionId);
      purgeSessionMetadata(sessionId);
      return { ok: true, sessionId, removed: true };
    } catch (err) {
      return {
        ok: false,
        sessionId,
        error: err && err.message ? err.message : String(err),
      };
    }
  };

  const http = async (method, path, body) => {
    const parts = splitPath(path);
    const pathname = parts.pathname;
    const query = queryOf(parts.search);
    const verb = String(method || 'GET').toUpperCase();
    const workbenchCapabilityUnavailable = (command) => ({
      ok: false,
      code: 'capability_unavailable',
      command,
      error: 'studio backend does not expose ' + command + ' yet',
      __httpStatus: 501,
    });

    const nativeWorkbenchError = (error, fallbackCode) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: error?.code === 'capability_unavailable' ? 'capability_unavailable' : fallbackCode,
        ...(error?.command ? { command: error.command } : {}),
        error: message,
        __httpStatus: error?.code === 'capability_unavailable' ? 501 : 500,
      };
    };
    const nativeCommandError = (error, fallbackCode) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: error?.code === 'capability_unavailable' ? 'capability_unavailable' : fallbackCode,
        ...(error?.command ? { command: error.command } : {}),
        error: message,
        __httpStatus: error?.code === 'capability_unavailable'
          ? 501
          : (Number.isInteger(error?.status) ? error.status : 500),
      };
    };

    const nativeResourceResult = (result) => {
      if (result?.ok === false && result?.conflict === true) {
        return {
          ...result,
          safeMessage: result.safeMessage || 'Resource write conflict',
          __httpStatus: 409,
        };
      }
      return result;
    };



    const isAbsolutePath = (value) => {
      if (typeof value !== 'string' || !value.trim()) return false;
      return value.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(value);
    };
    const isSafeCheckpointId = (value) => (
      typeof value === 'string'
      && /^[A-Za-z0-9_-]{1,200}$/.test(value)
    );

    const resourceOperationContextForBridge = (payload) => ({
      reason: typeof payload?.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : 'resource_io_route',
      sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : null,
      sessionPath: typeof payload?.sessionPath === 'string' ? payload.sessionPath : null,
      requestId: typeof payload?.requestId === 'string' ? payload.requestId : null,
    });

    if (pathname === '/api/health' && verb === 'GET') {
      const configured = await configuredModelFallback();
      return {
        status: 'ok',
        version: 'studio-bridge',
        agentId: ASSISTANT_ID,
        agent: ASSISTANT_NAME,
        agentYuan: 'hanako',
        user: loadUserPrefs().name,
        model: configured.modelId,
        modelProvider: configured.provider,
        avatars: { agent: false, user: false },
        sessionStore: null,
        studioBridge: api.mode(),
      };
    }

    // Studio-native workbench bridge. These routes intentionally use only
    // rootId/subdir/name coordinates; the host owns root resolution and must
    // enforce the authorized workspace scope. Legacy write actions continue to
    // use Hana until their corresponding native command is added.
    if (
      (pathname === '/api/workbench/files' || pathname === '/api/mobile/workbench/files')
      && verb === 'GET'
    ) {
      if (typeof api.workbenchListFiles !== 'function' || typeof api.workbenchListFilesAvailable !== 'function' || !api.workbenchListFilesAvailable()) {
        return workbenchCapabilityUnavailable('workbench_list_files');
      }
      try {
        const rootId = typeof query.mountId === 'string' && query.mountId.trim()
          ? query.mountId.trim()
          : (typeof query.rootId === 'string' && query.rootId.trim() ? query.rootId.trim() : 'default');
        return await api.workbenchListFiles({ rootId, subdir: query.subdir || '' });
      } catch (error) {
        return nativeWorkbenchError(error, 'workbench_list_failed');
      }
    }

    if (
      (pathname === '/api/workbench/search' || pathname === '/api/mobile/workbench/search')
      && verb === 'GET'
    ) {
      if (typeof api.workbenchSearchFiles !== 'function' || typeof api.workbenchSearchFilesAvailable !== 'function' || !api.workbenchSearchFilesAvailable()) {
        return workbenchCapabilityUnavailable('workbench_search_files');
      }
      try {
        const rootId = typeof query.mountId === 'string' && query.mountId.trim()
          ? query.mountId.trim()
          : (typeof query.rootId === 'string' && query.rootId.trim() ? query.rootId.trim() : 'default');
        return await api.workbenchSearchFiles({ rootId, query: query.q || '' });
      } catch (error) {
        return nativeWorkbenchError(error, 'workbench_search_failed');
      }
    }

    if (
      (pathname === '/api/workbench/content' || pathname === '/api/mobile/workbench/content')
      && (verb === 'GET' || verb === 'HEAD')
    ) {
      if (typeof api.workbenchReadFile !== 'function' || typeof api.workbenchReadFileAvailable !== 'function' || !api.workbenchReadFileAvailable()) {
        return workbenchCapabilityUnavailable('workbench_read_file');
      }
      try {
        const rootId = typeof query.mountId === 'string' && query.mountId.trim()
          ? query.mountId.trim()
          : (typeof query.rootId === 'string' && query.rootId.trim() ? query.rootId.trim() : 'default');
        const result = await api.workbenchReadFile({
          rootId,
          subdir: query.subdir || '',
          name: query.name || '',
        });
        if (!result || result.exists === false) {
          return {
            ok: false,
            code: 'file_not_found',
            error: 'file not found',
            __httpStatus: 404,
            __httpHeaders: { 'Cache-Control': 'no-store' },
          };
        }
        const headers = {
          'Content-Type': result.mimeType || result.mime || 'text/plain; charset=utf-8',
          'Content-Length': String(Number.isFinite(result.size) ? result.size : Buffer.byteLength(String(result.content || ''), 'utf8')),
          'Cache-Control': 'private, max-age=0, must-revalidate',
          ...(result.etag ? { ETag: String(result.etag) } : {}),
          ...(typeof result.version === 'string' && result.version.trim() ? { 'X-Hana-File-Version': result.version } : {}),
          ...(Number.isFinite(result.mtimeMs) ? { 'X-Hana-File-MtimeMs': String(result.mtimeMs) } : {}),
          ...(Number.isFinite(result.size) ? { 'X-Hana-File-Size': String(result.size) } : {}),
          ...(result.filename ? { 'Content-Disposition': 'inline; filename="' + String(result.filename).replace(/["\\\\\\r\\n]/g, '_') + '"' } : {}),
        };
        return {
          __httpStatus: 200,
          __httpHeaders: headers,
          __httpBody: verb === 'HEAD' ? '' : String(result.content || ''),
          __httpBodyEncoding: 'utf8',
          __httpHeadOnly: verb === 'HEAD',
        };
      } catch (error) {
        return nativeWorkbenchError(error, 'workbench_read_failed');
      }
    }

    if (
      (pathname === '/api/workbench/actions' || pathname === '/api/mobile/workbench/actions')
      && verb === 'POST'
    ) {
      const payload = body && typeof body === 'object' ? body : {};
      const action = typeof payload.action === 'string' ? payload.action.trim() : '';
      const actionCommands = {
        create: 'workbench_write_file',
        writeText: 'workbench_write_file',
        rename: 'workbench_rename_file',
        move: 'workbench_move_file',
        safeDelete: 'workbench_safe_delete',
      };
      const command = actionCommands[action];
      if (!command) return null;
      const available = {
        workbench_write_file: api.workbenchWriteFileAvailable,
        workbench_rename_file: api.workbenchRenameFileAvailable,
        workbench_move_file: api.workbenchMoveFileAvailable,
        workbench_safe_delete: api.workbenchDeleteFileAvailable,
      }[command];
      if (typeof available !== 'function' || !available()) {
        return workbenchCapabilityUnavailable(command);
      }
      try {
        const rootId = typeof payload.mountId === 'string' && payload.mountId.trim()
          ? payload.mountId.trim()
          : (typeof payload.rootId === 'string' && payload.rootId.trim() ? payload.rootId.trim() : 'default');
        let result;
        if (action === 'create' || action === 'writeText') {
          result = await api.workbenchWriteFile({
            rootId,
            subdir: typeof payload.subdir === 'string' ? payload.subdir : '',
            name: typeof payload.name === 'string' ? payload.name : '',
            content: payload.content == null ? '' : String(payload.content),
            expectedVersion: payload.expectedVersion,
            mustNotExist: action === 'create',
          });
        } else if (action === 'rename') {
          result = await api.workbenchRenameFile({
            rootId,
            subdir: typeof payload.subdir === 'string' ? payload.subdir : '',
            oldName: typeof payload.oldName === 'string' ? payload.oldName : '',
            newName: typeof payload.newName === 'string' ? payload.newName : '',
            expectedVersion: payload.expectedVersion,
          });
        } else if (action === 'move') {
          result = await api.workbenchMoveFile({
            rootId,
            subdir: typeof payload.subdir === 'string' ? payload.subdir : '',
            name: typeof payload.name === 'string' ? payload.name : '',
            destSubdir: typeof payload.destSubdir === 'string' ? payload.destSubdir : '',
            expectedVersion: payload.expectedVersion,
          });
        } else {
          result = await api.workbenchDeleteFile({
            rootId,
            subdir: typeof payload.subdir === 'string' ? payload.subdir : '',
            name: typeof payload.name === 'string' ? payload.name : '',
            expectedVersion: payload.expectedVersion,
          });
        }
        return {
          ...(result && typeof result === 'object' ? result : {}),
          action,
          ok: result?.ok === true,
        };
      } catch (error) {
        return nativeWorkbenchError(error, command + '_failed');
      }
    }

    if (
      (pathname === '/api/workbench/upload' || pathname === '/api/mobile/workbench/upload')
      && verb === 'POST'
    ) {
      if (typeof api.workbenchUploadFile !== 'function' || typeof api.workbenchUploadFileAvailable !== 'function' || !api.workbenchUploadFileAvailable()) {
        return workbenchCapabilityUnavailable('workbench_upload_file');
      }
      try {
        const payload = body && typeof body === 'object' ? body : {};
        const rootId = typeof payload.mountId === 'string' && payload.mountId.trim()
          ? payload.mountId.trim()
          : (typeof payload.rootId === 'string' && payload.rootId.trim() ? payload.rootId.trim() : 'default');
        const subdir = typeof payload.subdir === 'string' ? payload.subdir : '';
        const files = Array.isArray(payload.files) ? payload.files : [payload];
        if (!files.length) {
          return {
            ok: false,
            code: 'invalid_upload',
            error: 'files required',
            __httpStatus: 400,
          };
        }
        const results = [];
        for (const file of files) {
          const name = typeof file?.name === 'string' ? file.name : '';
          const base64Data = typeof file?.contentBase64 === 'string' ? file.contentBase64 : '';
          if (!name || !base64Data) {
            results.push({ name: name || null, ok: false, error: 'invalid_upload' });
            continue;
          }
          try {
            const result = await api.workbenchUploadFile({
              rootId,
              subdir,
              name,
              base64Data,
              mimeType: typeof file.mimeType === 'string' ? file.mimeType : null,
              expectedVersion: file.expectedVersion,
            });
            results.push({
              ...(result && typeof result === 'object' ? result : {}),
              name: result?.name || name,
              ok: result?.ok === true,
            });
          } catch (error) {
            results.push({
              name,
              ok: false,
              error: error?.code || error?.message || 'upload_failed',
            });
          }
        }
        return {
          ok: results.every((item) => item.ok),
          rootId,
          mountId: rootId,
          subdir,
          results,
        };
      } catch (error) {
        return nativeWorkbenchError(error, 'workbench_upload_failed');
      }
    }

    // Checkpoints are capability-gated like file history. The host owns the
    // checkpoint directory and must validate the path against its authenticated
    // workspace/session scope.
    if (pathname === '/api/checkpoints' && verb === 'GET') {
      const command = 'checkpoint_list';
      if (typeof api.checkpointListAvailable !== 'function' || !api.checkpointListAvailable()) {
        return workbenchCapabilityUnavailable(command);
      }
      try {
        const result = await api.checkpointList();
        return Array.isArray(result) ? { checkpoints: result } : (result || { checkpoints: [] });
      } catch (error) {
        return nativeCommandError(error, 'checkpoint_list_failed');
      }
    }
    if (pathname === '/api/checkpoints/user-edit' && verb === 'POST') {
      const command = 'checkpoint_create_user_edit';
      if (typeof api.checkpointCreateUserEditAvailable !== 'function' || !api.checkpointCreateUserEditAvailable()) {
        return workbenchCapabilityUnavailable(command);
      }
      const filePath = typeof body?.filePath === 'string' ? body.filePath : '';
      const reason = typeof body?.reason === 'string' ? body.reason : '';
      if (!filePath || !isAbsolutePath(filePath)) {
        return {
          ok: false,
          code: 'invalid_checkpoint_path',
          error: 'absolute filePath required',
          __httpStatus: 400,
        };
      }
      if (reason !== 'edit-start' && reason !== 'autosave-interval') {
        return {
          ok: false,
          code: 'invalid_checkpoint_reason',
          error: 'invalid reason',
          __httpStatus: 400,
        };
      }
      try {
        const result = await api.checkpointCreateUserEdit({ filePath, reason });
        return {
          ...(result && typeof result === 'object' ? result : {}),
          ok: result?.ok === true,
        };
      } catch (error) {
        return nativeCommandError(error, 'checkpoint_create_failed');
      }
    }
    const checkpointRestoreMatch = /^\/api\/checkpoints\/([^/]+)\/restore$/.exec(pathname);
    if (checkpointRestoreMatch && verb === 'POST') {
      const command = 'checkpoint_restore';
      if (typeof api.checkpointRestoreAvailable !== 'function' || !api.checkpointRestoreAvailable()) {
        return workbenchCapabilityUnavailable(command);
      }
      const id = decodeURIComponent(checkpointRestoreMatch[1]);
      if (!isSafeCheckpointId(id)) {
        return {
          ok: false,
          code: 'invalid_checkpoint_id',
          error: 'invalid checkpoint id',
          __httpStatus: 400,
        };
      }
      try {
        const result = await api.checkpointRestore(id);
        return {
          ...(result && typeof result === 'object' ? result : {}),
          ok: result?.ok === true,
        };
      } catch (error) {
        return nativeCommandError(error, 'checkpoint_restore_failed');
      }
    }
    const checkpointRemoveMatch = /^\/api\/checkpoints\/([^/]+)$/.exec(pathname);
    if (checkpointRemoveMatch && verb === 'DELETE') {
      const command = 'checkpoint_remove';
      if (typeof api.checkpointRemoveAvailable !== 'function' || !api.checkpointRemoveAvailable()) {
        return workbenchCapabilityUnavailable(command);
      }
      const id = decodeURIComponent(checkpointRemoveMatch[1]);
      if (!isSafeCheckpointId(id)) {
        return {
          ok: false,
          code: 'invalid_checkpoint_id',
          error: 'invalid checkpoint id',
          __httpStatus: 400,
        };
      }
      try {
        const result = await api.checkpointRemove(id);
        return {
          ...(result && typeof result === 'object' ? result : {}),
          ok: result?.ok === true,
        };
      } catch (error) {
        return nativeCommandError(error, 'checkpoint_remove_failed');
      }
    }

    // Studio-native file history. Each route maps to one exact host command so
    // an upgraded bridge cannot accidentally widen an older host's permissions.
    if (pathname === '/api/file-history/files' && verb === 'GET') {
      const command = 'file_history_list_files';
      if (!api.fileHistoryListFilesAvailable()) return workbenchCapabilityUnavailable(command);
      try {
        const agentId = typeof query.agentId === 'string' ? query.agentId.trim() : '';
        return await api.fileHistoryListFiles(agentId);
      } catch (error) {
        return nativeCommandError(error, 'file_history_list_failed');
      }
    }
    if (pathname === '/api/file-history/versions' && verb === 'GET') {
      const command = 'file_history_list_versions';
      if (!api.fileHistoryListVersionsAvailable()) return workbenchCapabilityUnavailable(command);
      try {
        return await api.fileHistoryListVersions({
          agentId: typeof query.agentId === 'string' ? query.agentId.trim() : '',
          relPath: typeof query.relPath === 'string' ? query.relPath : '',
        });
      } catch (error) {
        return nativeCommandError(error, 'file_history_versions_failed');
      }
    }
    if (pathname === '/api/file-history/snapshot' && verb === 'GET') {
      const command = 'file_history_get_snapshot';
      if (!api.fileHistoryGetSnapshotAvailable()) return workbenchCapabilityUnavailable(command);
      try {
        return await api.fileHistoryGetSnapshot({
          agentId: typeof query.agentId === 'string' ? query.agentId.trim() : '',
          snapshotId: query.id,
        });
      } catch (error) {
        return nativeCommandError(error, 'file_history_snapshot_failed');
      }
    }
    if (pathname === '/api/file-history/restore' && verb === 'POST') {
      const command = 'file_history_restore';
      if (!api.fileHistoryRestoreAvailable()) return workbenchCapabilityUnavailable(command);
      try {
        return await api.fileHistoryRestore({
          agentId: typeof body?.agentId === 'string' ? body.agentId.trim() : '',
          snapshotId: body?.snapshotId,
        });
      } catch (error) {
        return nativeCommandError(error, 'file_history_restore_failed');
      }
    }

    // Studio-native ResourceIO core operations. Watch/subscription/event routes
    // stay on Hana for now because their long-lived event ownership is separate
    // from the request/response command surface.
    const resourceIOCommands = {
      '/api/resource-io/stat': ['POST', 'resource_io_stat'],
      '/api/resource-io/read': ['POST', 'resource_io_read'],
      '/api/resource-io/list': ['POST', 'resource_io_list'],
      '/api/resource-io/search': ['POST', 'resource_io_search'],
      '/api/resource-io/write': ['POST', 'resource_io_write'],
      '/api/resource-io/write-expected-version': ['POST', 'resource_io_write_expected_version'],
      '/api/resource-io/rename': ['POST', 'resource_io_rename'],
      '/api/resource-io/move': ['POST', 'resource_io_move'],
      '/api/resource-io/trash': ['POST', 'resource_io_trash'],
    };
    const resourceIOEntry = resourceIOCommands[pathname];
    if (resourceIOEntry && verb === resourceIOEntry[0]) {
      const command = resourceIOEntry[1];
      const available = {
        resource_io_stat: api.resourceIOStatAvailable,
        resource_io_read: api.resourceIOReadAvailable,
        resource_io_list: api.resourceIOListAvailable,
        resource_io_search: api.resourceIOSearchAvailable,
        resource_io_write: api.resourceIOWriteAvailable,
        resource_io_write_expected_version: api.resourceIOWriteExpectedVersionAvailable,
        resource_io_rename: api.resourceIORenameAvailable,
        resource_io_move: api.resourceIOMoveAvailable,
        resource_io_trash: api.resourceIOTrashAvailable,
      }[command];
      if (typeof available !== 'function' || !available()) return workbenchCapabilityUnavailable(command);
      try {
        const resource = body?.resource || body?.ref || body?.target || body;
        let result;
        if (command === 'resource_io_stat') {
          result = await api.resourceIOStat(resource);
        } else if (command === 'resource_io_read') {
          result = await api.resourceIORead({
            resource,
            encoding: body?.encoding || body?.responseEncoding || 'utf-8',
          });
        } else if (command === 'resource_io_list') {
          result = await api.resourceIOList(resource);
        } else if (command === 'resource_io_search') {
          result = await api.resourceIOSearch({ resource, query: body?.query });
        } else if (command === 'resource_io_write') {
          result = await api.resourceIOWrite({
            resource,
            content: body?.content,
            encoding: body?.encoding || body?.contentEncoding || 'utf-8',
            operationContext: resourceOperationContextForBridge(body),
          });
        } else if (command === 'resource_io_write_expected_version') {
          result = await api.resourceIOWriteExpectedVersion({
            resource,
            content: body?.content,
            encoding: body?.encoding || body?.contentEncoding || 'utf-8',
            expectedVersion: body?.expectedVersion,
            operationContext: resourceOperationContextForBridge(body),
          });
        } else if (command === 'resource_io_rename') {
          result = await api.resourceIORename({
            from: body?.from || body?.oldResource,
            to: body?.to || body?.newResource,
            operationContext: resourceOperationContextForBridge(body),
          });
        } else if (command === 'resource_io_move') {
          result = await api.resourceIOMove({
            from: body?.from || body?.oldResource,
            to: body?.to || body?.newResource,
            operationContext: resourceOperationContextForBridge(body),
          });
        } else {
          result = await api.resourceIOTrash({
            resource,
            trash: body?.trash || {},
            operationContext: resourceOperationContextForBridge(body),
          });
        }
        return nativeResourceResult(result);
      } catch (error) {
        return nativeCommandError(error, command + '_failed');
      }
    }

    const resourceMetadataMatch = /^\/api\/resources\/([^/]+)$/.exec(pathname);
    if (resourceMetadataMatch && verb === 'GET') {
      const command = 'resource_get_metadata';
      if (!api.resourceGetMetadataAvailable()) return workbenchCapabilityUnavailable(command);
      try {
        const resourceId = decodeURIComponent(resourceMetadataMatch[1]);
        const result = await api.resourceGetMetadata(resourceId);
        if (!result) {
          return {
            ok: false,
            code: 'resource_not_found',
            error: 'resource not found',
            __httpStatus: 404,
          };
        }
        return result;
      } catch (error) {
        return nativeCommandError(error, 'resource_metadata_failed');
      }
    }

    const resourceContentMatch = /^\/api\/resources\/([^/]+)\/content$/.exec(pathname);
    if (resourceContentMatch && (verb === 'GET' || verb === 'HEAD')) {
      const command = 'resource_read_content';
      if (!api.resourceReadContentAvailable()) return workbenchCapabilityUnavailable(command);
      try {
        const resourceId = decodeURIComponent(resourceContentMatch[1]);
        const result = await api.resourceReadContent({ resourceId });
        if (!result || result.exists === false) {
          return {
            ok: false,
            code: 'resource_not_found',
            error: 'resource content not found',
            __httpStatus: 404,
            __httpHeaders: { 'Cache-Control': 'no-store' },
          };
        }
        const contentBase64 = typeof result.contentBase64 === 'string' ? result.contentBase64 : '';
        if (!contentBase64 && Number(result.size) > 0) {
          return {
            ok: false,
            code: 'invalid_resource_content',
            error: 'native resource content is missing base64 payload',
            __httpStatus: 502,
          };
        }
        const headers = {
          'Content-Type': result.mime || result.mimeType || 'application/octet-stream',
          'Content-Length': String(Number.isFinite(Number(result.size))
            ? Number(result.size)
            : Math.floor(contentBase64.length * 3 / 4)),
          'Cache-Control': 'private, max-age=0, must-revalidate',
          ...(result.etag ? { ETag: String(result.etag) } : {}),
          ...(result.filename ? {
            'Content-Disposition': 'inline; filename="' + String(result.filename).replace(/["\\\\\\r\\n]/g, '_') + '"',
          } : {}),
        };
        return {
          __httpStatus: 200,
          __httpHeaders: headers,
          __httpBody: verb === 'HEAD' ? '' : contentBase64,
          __httpBodyEncoding: 'base64',
          __httpHeadOnly: verb === 'HEAD',
        };
      } catch (error) {
        return nativeCommandError(error, 'resource_content_failed');
      }
    }

    {
      const providerResult = await handleProviderHttp(pathname, verb, body);
      if (providerResult !== null) return providerResult;
    }

    if (pathname === '/api/server/identity' && verb === 'GET') {
      return {
        connectionKind: 'local',
        serverId: 'local',
        studioId: 'local',
        label: 'Studio',
        userLabel: loadUserPrefs().name,
        studioLabel: 'Studio',
        version: 'studio-bridge',
        authState: 'paired',
        trustState: 'local',
        credentialKind: 'loopback_token',
        serverProtocol: 1,
      };
    }

    if (pathname === '/api/models' && verb === 'GET') {
      try {
        const llm = await api.getLlmConfig();
        const current = llm && llm.current && typeof llm.current === 'object' ? llm.current : {};
        const requestedSessionPath = typeof query.sessionPath === 'string' && query.sessionPath
          ? query.sessionPath
          : (typeof query.sessionId === 'string' && query.sessionId ? pathFor(query.sessionId) : '');
        const assigned = requestedSessionPath ? storedModelForPath(requestedSessionPath) : null;
        const provider = assigned?.provider
          || (typeof current.provider === 'string' && current.provider
            ? current.provider
            : (typeof llm.default === 'string' ? llm.default : api.DEFAULT_PROVIDER));
        const model = assigned?.modelId
          || (typeof current.model === 'string' && current.model
            ? current.model
            : api.DEFAULT_MODEL);
        const lists = llm && llm.model_lists && typeof llm.model_lists === 'object' ? llm.model_lists : {};
        const models = [];
        Object.keys(lists).forEach((prov) => {
          const arr = Array.isArray(lists[prov]) ? lists[prov] : [];
          arr.forEach((id) => {
            const mid = typeof id === 'string' ? id : (id && id.id);
            if (!mid) return;
            const providerOverlay = readOverlay()[prov] && typeof readOverlay()[prov] === 'object' ? readOverlay()[prov] : {};
            const metadata = modelMetadataFor(providerOverlay, mid) || {};
            models.push({
              id: mid,
              name: metadata.name || mid,
              provider: prov,
              ...metadata,
              isCurrent: prov === provider && mid === model,
            });
          });
        });
        if (!models.some((entry) => entry.provider === provider && entry.id === model)) {
          const providerOverlay = readOverlay()[provider] && typeof readOverlay()[provider] === 'object' ? readOverlay()[provider] : {};
          const metadata = modelMetadataFor(providerOverlay, model) || {};
          models.push({ id: model, name: metadata.name || model, provider, ...metadata, isCurrent: true });
        }
        if (!models.length) {
          const providerOverlay = readOverlay()[provider] && typeof readOverlay()[provider] === 'object' ? readOverlay()[provider] : {};
          const metadata = modelMetadataFor(providerOverlay, model) || {};
          models.push({ id: model, name: metadata.name || model, provider, ...metadata, isCurrent: true });
        }
        return {
          models,
          current: model,
          activeModel: { id: model, provider },
        };
      } catch (_) {
        return {
          models: [{
            id: api.DEFAULT_MODEL,
            name: api.DEFAULT_MODEL,
            provider: api.DEFAULT_PROVIDER,
            isCurrent: true,
          }],
          current: api.DEFAULT_MODEL,
          activeModel: { id: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER },
        };
      }
    }

    if (pathname === '/api/models/set' && verb === 'POST') {
      const modelId = body && (body.modelId || body.model);
      const provider = body && body.provider;
      if (!modelId) throw new Error('missing modelId');
      if (!provider) throw new Error('missing provider');
      setPendingModel(modelId, provider);
      // Mirror into Studio llm.current so the next api.create() picks it up.
      try {
        await api.setLlmConfig({ current: { provider: String(provider), model: String(modelId) } });
      } catch (_) { /* still keep pending locally */ }
      let displayName = String(modelId);
      try {
        const listed = await api.listModels();
        const hit = (listed || []).find((m) => m.id === modelId && m.provider === provider);
        if (hit && hit.name) displayName = hit.name;
      } catch (_) {}
      const providerOverlay = readOverlay()[provider] && typeof readOverlay()[provider] === 'object' ? readOverlay()[provider] : {};
      const metadata = modelMetadataFor(providerOverlay, modelId) || {};
      return {
        ok: true,
        model: { ...serializeModel(modelId, provider, displayName), ...metadata },
        thinkingLevel: metadata.defaultThinkingLevel || 'medium',
        thinkingLevels: Array.isArray(metadata.thinkingLevels) ? metadata.thinkingLevels : ['medium'],
      };
    }

    if (pathname === '/api/models/switch' && verb === 'POST') {
      const sessionPath = body && (body.sessionPath || body.path);
      const modelId = body && (body.modelId || body.model);
      const provider = body && body.provider;
      if (!sessionPath) throw new Error('missing sessionPath');
      if (!modelId) throw new Error('missing modelId');
      if (!provider) throw new Error('missing provider');

      const sessionId = idFrom(sessionPath);
      if (!sessionId) throw new Error('missing session');

      let liveId = sessionId;
      try {
        liveId = await ensureLive(sessionId);
      } catch (_) {
        liveId = sessionId;
      }

      try {
        await api.rebind(liveId, provider, modelId);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (/stream|busy|in progress/i.test(message)) {
          throw new Error('cannot switch model while streaming');
        }
        throw new Error(message || 'MODEL_SWITCH_FAILED');
      }

      rememberSessionModel(sessionPath, modelId, provider);
      rememberSessionModel(pathFor(liveId), modelId, provider);
      setPendingModel(modelId, provider);
      try {
        await api.setLlmConfig({ current: { provider: String(provider), model: String(modelId) } });
      } catch (_) {}

      let displayName = String(modelId);
      try {
        const listed = await api.listModels();
        const hit = (listed || []).find((m) => m.id === modelId && m.provider === provider);
        if (hit && hit.name) displayName = hit.name;
      } catch (_) {}

      return {
        ok: true,
        model: serializeModel(modelId, provider, displayName),
        adaptations: [],
        thinkingLevel: 'medium',
      };
    }



    if (pathname === '/api/ws-ticket' && verb === 'POST') {
      return { ticket: 'studio-bridge', expiresAt: Date.now() + 600000 };
    }

    if (pathname === '/api/preferences/session-permission-default' && verb === 'GET') {
      return {
        permissionMode: 'ask',
        locked: true,
        supportedModes: ['ask'],
      };
    }

    if (pathname === '/api/preferences/session-permission-default'
      && (verb === 'PUT' || verb === 'POST' || verb === 'PATCH')) {
      return {
        ok: false,
        locked: true,
        permissionMode: 'ask',
        mode: 'ask',
        error: 'studio backend does not support permission mode changes',
      };
    }

    if (pathname === '/api/session-permission-mode'
      && (verb === 'GET' || verb === 'POST' || verb === 'PUT' || verb === 'PATCH')) {
      return {
        ok: verb === 'GET',
        locked: true,
        mode: 'ask',
        permissionMode: 'ask',
        ...(verb === 'GET'
          ? {}
          : { error: 'studio backend does not support permission mode changes' }),
      };
    }

    if (pathname === '/api/agents' && verb === 'GET') {
      const rows = await api.agents();
      return {
        agents: rows.map((row) => ({
          id: row.id,
          name: row.title || row.id,
          yuan: row.id === ASSISTANT_ID ? 'hanako' : undefined,
          isPrimary: row.id === ASSISTANT_ID,
          hasAvatar: false,
          live: row.live !== false,
          status: row.status || 'idle',
        })),
      };
    }

    if (/^\/api\/agents\/[^/]+\/config$/.test(pathname) && verb === 'GET') {
      const agentId = decodeURIComponent(pathname.split('/')[3] || '');
      const llm = await api.getLlmConfig();
      const current = llm && llm.current && typeof llm.current === 'object' ? llm.current : {};
      return {
        chat: {
          provider: typeof current.provider === 'string' ? current.provider : api.DEFAULT_PROVIDER,
          model: typeof current.model === 'string' ? current.model : api.DEFAULT_MODEL,
          agentId,
        },
        memory: { enabled: true },
        user: { name: loadUserPrefs().name },
        capabilities: {
          modelSwitch: true,
          thinkingLevel: false,
          permissionMode: false,
          primaryAgentSwitch: false,
        },
        source: 'studio',
      };
    }

    if (pathname === '/api/sessions' && verb === 'GET') {
      const [rows, fallbackModel] = await Promise.all([
        api.sessions(),
        configuredModelFallback(),
      ]);
      return rows
        .filter((row) => !archivedRecord(row.id) && !disposedIds.has(row.id))
        .map((row) => projection(row, fallbackModel));
    }


    if (pathname === '/api/sessions/search' && verb === 'GET') {
      const rawQuery = typeof query.q === 'string' ? query.q.trim() : '';
      const phase = query.phase === 'content' ? 'content' : 'title';
      const requestedLimit = Number(query.limit);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 50)
        : 20;
      if (!rawQuery) return { query: rawQuery, phase, results: [] };
      const needle = rawQuery.toLocaleLowerCase();
      const rows = (await api.sessions())
        .filter((row) => !archivedRecord(row.id) && !disposedIds.has(row.id));
      const fallbackModel = await configuredModelFallback();
      const results = [];
      for (const row of rows) {
        const projected = projection(row, fallbackModel);
        if (phase === 'title') {
          const haystack = `${projected.title || ''} ${projected.sessionId || ''}`.toLocaleLowerCase();
          if (!haystack.includes(needle)) continue;
          results.push({
            ...projected,
            matchKind: 'title',
            snippet: projected.title || '',
            score: 1,
          });
        } else {
          break;
        }
        if (results.length >= limit) break;
      }
      if (phase === 'content') {
        const contentResults = await sessionSearch.searchContentRows(
          rows,
          rawQuery,
          (row) => cachedTranscriptForRow(row),
          (row) => projection(row, fallbackModel),
          limit,
          4,
        );
        return { query: rawQuery, phase, results: contentResults };
      }
      return { query: rawQuery, phase, results };
    }

    if (pathname === '/api/sessions/summary' && verb === 'GET') {
      if (typeof api.getSessionSummary !== 'function' || typeof api.sessionSummaryAvailable !== 'function' || !api.sessionSummaryAvailable()) {
        return {
          hasSummary: false,
          summary: null,
          createdAt: null,
          updatedAt: null,
          code: 'capability_unavailable',
          error: 'studio backend does not expose persisted session summaries yet',
        };
      }
      const sessionId = sessionIdFromBody(body, query);
      if (!sessionId) {
        return { hasSummary: false, summary: null, createdAt: null, updatedAt: null, code: 'invalid_session', error: 'missing session id' };
      }
      try {
        const result = await api.getSessionSummary(sessionId);
        if (!result || typeof result.hasSummary !== 'boolean') {
          return { hasSummary: false, summary: null, createdAt: null, updatedAt: null, code: 'summary_failed', error: 'studio summary read failed' };
        }
        const iso = (value) => Number.isFinite(value) ? new Date(value).toISOString() : (value || null);
        return {
          hasSummary: result.hasSummary,
          summary: result.summary || null,
          createdAt: iso(result.createdAt),
          updatedAt: iso(result.updatedAt),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          hasSummary: false,
          summary: null,
          createdAt: null,
          updatedAt: null,
          code: error?.code === 'capability_unavailable' ? 'capability_unavailable' : 'summary_failed',
          error: message,
        };
      }
    }

    if (pathname === '/api/sessions/authorized-folders' && (verb === 'GET' || verb === 'PATCH')) {
      if (typeof api.getSessionFolderScope !== 'function' || typeof api.patchSessionAuthorizedFolders !== 'function' || typeof api.sessionFolderScopeAvailable !== 'function' || !api.sessionFolderScopeAvailable()) {
        return {
          ok: false,
          code: 'capability_unavailable',
          error: 'studio backend does not expose session authorized-folder persistence yet',
        };
      }
      const sessionId = sessionIdFromBody(body, query);
      if (!sessionId) {
        return { ok: false, code: 'invalid_session', error: 'missing session id' };
      }
      try {
        if (verb === 'GET') {
          const result = await api.getSessionFolderScope(sessionId);
          if (!result || result.ok !== true) {
            return { ok: false, code: result?.code || 'authorized_folders_failed', error: result?.error || 'studio folder scope read failed' };
          }
          return result;
        }

        const payload = body && typeof body === 'object' ? body : {};
        const action = typeof payload.action === 'string' ? payload.action.trim() : 'set';
        if (!['set', 'add', 'remove'].includes(action)) {
          return { ok: false, code: 'invalid_action', error: 'Invalid action' };
        }
        const result = await api.patchSessionAuthorizedFolders(
          sessionId,
          action,
          typeof payload.folder === 'string' ? payload.folder : null,
          Array.isArray(payload.folders) ? payload.folders : [],
        );
        if (!result || result.ok !== true) {
          return { ok: false, code: result?.code || 'authorized_folders_failed', error: result?.error || 'studio folder scope update failed' };
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error?.code === 'capability_unavailable'
          ? 'capability_unavailable'
          : /folder (is required|does not exist|must be a directory)/.test(message)
            ? 'invalid_folder'
            : message === 'session is busy'
              ? 'session_busy'
              : 'authorized_folders_failed';
        return { ok: false, code, error: message };
      }
    }

    if (pathname === '/api/sessions/archived' && verb === 'GET') {
      const archived = loadArchived();
      return Object.values(archived)
        .filter((row) => row && row.sessionId)
        .sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
    }

    if (pathname === '/api/runtime-state' && verb === 'GET') {
      const rows = (await api.sessions())
        .filter((row) => !archivedRecord(row.id) && !disposedIds.has(row.id));
      const liveIds = new Set(rows.map((row) => row.id));
      for (const id of runtimeTranscriptCache.keys()) {
        if (!liveIds.has(id)) runtimeTranscriptCache.delete(id);
      }
      const sessions = await Promise.all(rows.map(runtimeProjection));
      const signature = runtimeSignature(sessions);
      if (query.since && query.since === signature) {
        return { mode: api.mode(), signature, unchanged: true };
      }
      return { mode: api.mode(), signature, sessions };
    }

    const runtimeSessionMatch = pathname.match(/^\/api\/runtime-state\/([^/]+)$/);
    if (runtimeSessionMatch && verb === 'GET') {
      const sessionId = idFrom(decodeURIComponent(runtimeSessionMatch[1]));
      const rows = await api.sessions();
      const row = rows.find((item) => item.id === sessionId
        && !archivedRecord(item.id)
        && !disposedIds.has(item.id));
      if (!row) return { error: 'session not found', code: 'session_not_found' };
      return runtimeProjection(row);
    }

    if ((pathname === '/api/sessions/new' || pathname === '/api/sessions/new-detached') && verb === 'POST') {
      const pending = modelForPath(null);
      const catalog = loadCatalog();
      const requestedProjectId = typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
      const mappedProject = requestedProjectId ? catalog.projects.find((project) => project.id === requestedProjectId) : null;
      if (requestedProjectId && requestedProjectId !== UNCATEGORIZED_PROJECT_ID && !mappedProject) {
        return { ok: false, error: 'project not found' };
      }
      const mappedCwd = mappedProject?.workspacePath || null;
      const requestedCwd = typeof body?.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : mappedCwd;
      const id = await api.create(pending.provider, pending.modelId, null, requestedCwd);
      const path = pathFor(id);
      rememberSessionModel(path, pending.modelId, pending.provider);
      const projectId = body && typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim()
        : null;
      if (projectId && projectId !== UNCATEGORIZED_PROJECT_ID) {
        const assignments = loadAssignments();
        assignments[path] = projectId;
        saveAssignments(assignments);
      }
      return {
        ok: true,
        path,
        sessionId: id,
        agentId: ASSISTANT_ID,
        agentName: ASSISTANT_NAME,
        currentModelId: pending.modelId,
        currentModelName: pending.modelId,
        currentModelProvider: pending.provider,
        cwd: requestedCwd,
        workspaceFolders: Array.isArray(body?.workspaceFolders) ? body.workspaceFolders.filter((item) => typeof item === 'string') : [],
        projectId: projectId || null,
      };
    }

    if (pathname === '/api/sessions/switch' && verb === 'POST') {
      const sessionId = sessionIdOf(body, query);
      if (!sessionId) return { error: 'missing session' };
      // `ensureLive` restores a cold session with its persisted model. Never
      // rebind during navigation: rebind stops and recreates the driver, making
      // every session click expensive and risking loss of live runtime state.
      const liveId = await ensureLive(sessionId);
      let assigned = storedModelForPath(pathFor(liveId));
      if (!assigned) {
        try {
          const llm = await api.getLlmConfig();
          const current = llm && llm.current && typeof llm.current === 'object' ? llm.current : {};
          const provider = (typeof current.provider === 'string' && current.provider)
            || (typeof llm?.default === 'string' && llm.default)
            || api.DEFAULT_PROVIDER;
          const providerModel = llm?.providers?.[provider]?.model;
          const listed = Array.isArray(llm?.model_lists?.[provider]) ? llm.model_lists[provider] : [];
          const firstListed = listed
            .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
            .find(Boolean);
          assigned = {
            provider,
            modelId: (typeof current.model === 'string' && current.model)
              || providerModel
              || firstListed
              || (provider === api.DEFAULT_PROVIDER ? api.DEFAULT_MODEL : provider),
          };
        } catch (_) {
          assigned = { modelId: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER };
        }
      }
      return {
        ok: true,
        path: pathFor(liveId),
        sessionId: liveId,
        agentId: ASSISTANT_ID,
        agentName: ASSISTANT_NAME,
        isStreaming: false,
        memoryEnabled: true,
        workspaceFolders: [],
        cwd: null,
        permissionMode: 'ask',
        currentModelId: assigned.modelId,
        currentModelName: assigned.modelId,
        currentModelProvider: assigned.provider,
      };
    }

    if (pathname === '/api/sessions/pin' && verb === 'POST') {
      const sessionId = sessionIdOf(body, query);
      if (!sessionId) return { error: 'missing session' };
      const path = pathFor(sessionId);
      const pinned = !(body && body.pinned === false);
      const pins = loadPins();
      let pinnedAt = null;
      let pinOrder = null;
      if (pinned) {
        pinnedAt = new Date().toISOString();
        pinOrder = topPinOrder(pins);
        pins[path] = { pinnedAt, pinOrder };
      } else {
        delete pins[path];
      }
      savePins(pins);
      return { ok: true, sessionId, path, pinnedAt, pinOrder };
    }

    if (pathname === '/api/sessions/pin-order' && verb === 'POST') {
      const sessionIds = Array.isArray(body && body.sessionIds)
        ? body.sessionIds.filter((id) => typeof id === 'string' && id.trim())
        : [];
      if (sessionIds.length === 0) return { error: 'sessionIds required' };
      const pins = loadPins();
      const orders = [];
      sessionIds.forEach((sessionId, index) => {
        const path = pathFor(sessionId);
        const existing = pins[path];
        const pinnedAt = existing && existing.pinnedAt
          ? existing.pinnedAt
          : new Date().toISOString();
        const pinOrder = (index + 1) * PIN_ORDER_STEP;
        pins[path] = { pinnedAt, pinOrder };
        orders.push({ sessionId, pinOrder });
      });
      savePins(pins);
      return { ok: true, orders };
    }

    if (pathname === '/api/sessions/archive' && verb === 'POST') {
      const sessionId = sessionIdFromBody(body, query);
      if (!sessionId) return { ok: false, error: 'missing session' };
      deactivateTurn(activeTurns.get(sessionId));
      const [rows, fallbackModel] = await Promise.all([
        api.sessions(),
        configuredModelFallback(),
      ]);
      const row = rows.find((item) => item.id === sessionId) || { id: sessionId };
      const projected = projection(row, fallbackModel);
      try {
        await api.softUnbind(sessionId);
        runtimeTranscriptCache.delete(sessionId);
        const archived = loadArchived();
        archived[pathFor(sessionId)] = {
          ...projected,
          sessionId,
          path: pathFor(sessionId),
          archivedAt: new Date().toISOString(),
          live: false,
          busy: false,
          isStreaming: false,
        };
        saveArchived(archived);
        return { ok: true, sessionId, archived: true };
      } catch (err) {
        return { ok: false, sessionId, error: err && err.message ? err.message : String(err) };
      }
    }

    if (pathname === '/api/sessions/cleanup' && verb === 'POST') {
      const maxAgeDays = Number(body && body.maxAgeDays);
      if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
        return { ok: false, error: 'maxAgeDays must be a positive number' };
      }
      const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
      const archived = loadArchived();
      const candidates = Object.values(archived).filter((row) => {
        if (!row || !row.sessionId || !row.archivedAt) return false;
        const archivedAt = Date.parse(row.archivedAt);
        return Number.isFinite(archivedAt) && archivedAt <= cutoff;
      });
      const ids = candidates.map((row) => row.sessionId).sort();
      if (ids.length > 5000) return { ok: false, error: 'too many archived sessions for a single cleanup' };
      if (body?.dryRun === true) {
        return { ok: true, dryRun: true, count: ids.length, sessionIds: ids };
      }
      // Exact-snapshot execution is optional for legacy callers, but mandatory
      // for confirmed UI cleanup. Never delete a newly eligible unreviewed ID.
      if (body && Object.prototype.hasOwnProperty.call(body, 'expectedSessionIds')) {
        const expected = body.expectedSessionIds;
        if (!Array.isArray(expected) || expected.length > 5000
          || expected.some((id) => typeof id !== 'string' || !id.trim())
          || new Set(expected).size !== expected.length) {
          return { ok: false, code: 'invalid_preview', error: 'invalid cleanup preview' };
        }
        const sorted = expected.slice().sort();
        if (sorted.length !== ids.length || sorted.some((id, index) => id !== ids[index])) {
          return { ok: false, code: 'preview_changed', error: 'Archived sessions changed; preview again before cleanup' };
        }
      }
      let deleted = 0;
      const failures = [];
      for (const row of candidates) {
        const result = await disposeSession(row.sessionId);
        if (result && result.ok === true && result.sessionId === row.sessionId) {
          deleted += 1;
        } else {
          failures.push({
            sessionId: row.sessionId,
            error: result && result.error ? result.error : 'delete failed',
          });
        }
      }
      return {
        ok: failures.length === 0,
        deleted,
        failed: failures.length,
        ...(failures.length ? { failures } : {}),
      };
    }

    if (pathname === '/api/sessions/archived/delete' && verb === 'POST') {
      const sessionId = sessionIdFromBody(body, query);
      const result = await disposeSession(sessionId);
      if (result.ok && sessionId) purgeSessionMetadata(sessionId);
      return result;
    }

    if (pathname === '/api/sessions/rename' && verb === 'POST') {
      const sessionId = sessionIdOf(body, query);
      const title = trimName(body && (body.title || body.name));
      if (!sessionId) return { ok: false, error: 'missing session' };
      if (!title) return { ok: false, error: 'title required' };
      const path = pathFor(sessionId);
      const archived = loadArchived();
      const archivedEntry = archived[path] || null;
      if (!archivedEntry) {
        const rows = await api.sessions();
        const exists = rows.some((row) => row.id === sessionId && !disposedIds.has(row.id));
        if (!exists) return { ok: false, error: 'session not found' };
      }
      const titles = loadTitles();
      titles[path] = title;
      saveTitles(titles);
      if (archivedEntry) {
        archivedEntry.title = title;
        archivedEntry.firstMessage = title;
        saveArchived(archived);
      }
      return { ok: true, sessionId, path, title };
    }

    if (pathname === '/api/sessions/restore' && verb === 'POST') {
      const sessionId = sessionIdOf(body, query);
      if (!sessionId) return { ok: false, error: 'missing session' };
      const archived = loadArchived();
      const archivedEntry = archived[pathFor(sessionId)] || null;
      if (!archivedEntry) return { ok: false, error: 'session is not archived' };
      try {
        const resumed = await api.resume(sessionId);
        runtimeTranscriptCache.delete(sessionId);
        const restoredId = resumed || sessionId;
        if (archivedEntry.modelId && archivedEntry.modelProvider) {
          rememberSessionModel(
            pathFor(restoredId),
            archivedEntry.modelId,
            archivedEntry.modelProvider,
          );
          if (restoredId !== sessionId) {
            rememberSessionModel(
              pathFor(sessionId),
              archivedEntry.modelId,
              archivedEntry.modelProvider,
            );
          }
        }
        delete archived[pathFor(sessionId)];
        saveArchived(archived);
        disposedIds.delete(sessionId);
        return { ok: true, sessionId: restoredId, path: pathFor(restoredId), restored: true };
      } catch (err) {
        return { ok: false, sessionId, error: err && err.message ? err.message : String(err) };
      }
    }

    if ((pathname === '/api/sessions/delete' || pathname === '/api/sessions/remove') && verb === 'POST') {
      return disposeSession(sessionIdFromBody(body, query));
    }

    if (pathname === '/api/sessions/turns/retry' && verb === 'POST') {
      const sessionId = sessionIdFromBody(body, query);
      if (!sessionId) throw new Error('missing session');
      if (!body?.target || typeof body.target !== 'object') throw new Error('session node target is required');
      if (activeTurns.has(sessionId)) throw new Error('session_busy');
      const liveId = await ensureLive(sessionId);
      const result = await api.retryTurn(
        liveId,
        body.target,
        typeof body.text === 'string' ? body.text : null,
        body.clientMessageId || null,
      );
      runtimeTranscriptCache.delete(sessionId);
      return { ok: true, sessionId: liveId, ...(result && typeof result === 'object' ? result : {}) };
    }

    if (pathname === '/api/sessions/fork' && verb === 'POST') {
      const sessionId = sessionIdFromBody(body, query);
      if (!sessionId) throw new Error('missing session');
      if (!body?.target || typeof body.target !== 'object') throw new Error('session node target is required');
      if (activeTurns.has(sessionId)) throw new Error('session_busy');
      const liveId = await ensureLive(sessionId);
      const result = await api.forkSession(liveId, body.target);
      const childId = idFrom(result?.sessionId || result?.agentId || result?.id || result);
      if (!childId) throw new Error('fork response is missing sessionId');
      const childPath = pathFor(childId);
      return {
        ok: true,
        sessionId: childId,
        sessionPath: childPath,
        path: childPath,
        agentId: childId,
        sourceSessionId: liveId,
        target: body.target,
        ...(result && typeof result === 'object' ? result : {}),
      };
    }

    if (pathname === '/api/sessions/messages' && verb === 'GET') {
      if (query.before) {
        return { messages: [], blocks: [], todos: [], sessionFiles: [], hasMore: false, revision: null };
      }
      const sessionId = sessionIdOf(null, query);
      if (!sessionId) return { messages: [], blocks: [], todos: [], sessionFiles: [], hasMore: false };
      const liveId = await ensureLive(sessionId);
      const rows = await api.transcript(liveId);
      const results = toolResultsFromTranscript(rows);
      return {
        messages: historyMessages(rows, results),
        blocks: [],
        todos: todosFromTranscript(rows, results),
        sessionFiles: [],
        hasMore: false,
        revision: 'studio-' + liveId,
      };
    }

    const projectResult = handleSessionProjects(pathname, verb, body, query);
    if (projectResult !== null) return projectResult;

    const stub = await stubHttp(pathname, verb, body);
    if (stub !== null) return stub;

    return { error: 'studio bridge: unhandled ' + verb + ' ' + pathname };
  };

  const ws = async (message, emit) => {
    const msg = message || {};
    const type = msg.type;
    const sessionId = idFrom(msg.sessionId || msg.sessionPath);
    const sessionPath = msg.sessionPath || (sessionId ? pathFor(sessionId) : '');
    const collected = [];
    let turn = null;
    const push = (event) => {
      if (turn && !isActiveTurn(turn)) return false;
      const payload = turn && event.streamId == null
        ? { ...event, streamId: turn.streamId }
        : event;
      collected.push(payload);
      if (typeof emit === 'function') emit(payload);
      return true;
    };

    if (type === 'context_usage' || type === 'resume_stream' || type === 'stream_resume') {
      return { events: [], streamed: true };
    }

    if (type === 'abort') {
      const requestedStreamId = typeof msg.streamId === 'string' && msg.streamId.trim()
        ? msg.streamId.trim()
        : null;
      const active = activeTurns.get(sessionId) || null;
      // Reject only a token belonging to a different turn still known here.
      // After iframe/plugin recovery the map is empty, but backend agent may
      // still be running; Stop must remain a best-effort server cancellation.
      if (requestedStreamId && active && active.streamId !== requestedStreamId) {
        push({
          type: 'abort_result',
          status: 'rejected',
          reason: 'stale_stream',
          sessionId,
          sessionPath,
          streamId: active ? active.streamId : requestedStreamId,
        });
        return { events: collected, streamed: typeof emit === 'function' };
      }

      const streamId = active ? active.streamId : requestedStreamId;
      if (active) deactivateTurn(active);
      push({
        type: 'abort_result',
        status: active ? 'accepted' : 'already_stopped',
        sessionId,
        sessionPath,
        streamId,
      });
      push({ type: 'turn_end', sessionId, sessionPath, streamId, aborted: true });
      push({ type: 'status', sessionId, sessionPath, streamId, isStreaming: false });

      if (sessionId) {
        try { await api.cancel(sessionId); } catch (err) {
          push({
            type: 'error',
            sessionId,
            sessionPath,
            streamId,
            message: err && err.message ? err.message : String(err),
          });
        }
      }
      return { events: collected, streamed: typeof emit === 'function' };
    }

    if (type === 'prompt' || type === 'interject') {
      if (!sessionId) {
        push({ type: 'error', message: 'missing sessionId', code: 'session_identity_unresolved' });
        return { events: collected, streamed: typeof emit === 'function' };
      }
      const text = typeof msg.text === 'string' ? msg.text : '';
      const shown = msg.displayMessage && typeof msg.displayMessage.text === 'string'
        ? msg.displayMessage.text
        : text;
      const nativeImages = Array.isArray(msg.images)
        ? msg.images
          .filter((image) => image && typeof image.data === 'string' && image.data.length > 0)
          .filter((image) => typeof image.mimeType === 'string' && /^image\/(png|jpeg|gif|webp)$/i.test(image.mimeType))
          .slice(0, 10)
          .map((image) => ({
            data: image.data,
            mimeType: image.mimeType.trim().toLowerCase(),
            detail: 'auto',
          }))
        : [];
      const trustedAttachmentPaths = Array.isArray(msg.sessionFileRefs)
        ? msg.sessionFileRefs
          .map((ref) => ref && studioUploadedFiles.get(String(ref.fileId || '')))
          .filter((path) => typeof path === 'string' && path.length > 0)
        : [];
      const filePathContext = trustedAttachmentPaths.length > 0
        ? trustedAttachmentPaths.map((path) => `[Attached file path: ${path}]`).join('\n')
        : '';
      const promptText = filePathContext ? (text ? `${text}\n\n${filePathContext}` : filePathContext) : text;
      const clientMessageId = typeof msg.clientMessageId === 'string' ? msg.clientMessageId : '';
      const liveId = await ensureLive(sessionId);
      const livePath = msg.sessionPath || pathFor(liveId);
      const msgId = clientMessageId || ('ohk-' + Date.now());

      if (type === 'prompt') {
        // Check before activating a new token. A rejected second prompt must not
        // invalidate the callback token owned by the turn already in progress.
        try {
          const rows = await api.sessions();
          const row = rows.find((s) => s.id === liveId);
          if (row && row.busy) {
            push({
              type: 'error',
              sessionId: liveId,
              sessionPath: livePath,
              message: 'session is busy; wait for the current turn to finish',
              code: 'session_busy',
            });
            return { events: collected, streamed: typeof emit === 'function' };
          }
        } catch (_) { /* listing can race; still try send */ }
        turn = activateTurn(sessionId, liveId);
      }

      push({ type: 'status', sessionId: liveId, sessionPath: livePath, isStreaming: true });
      push({
        type: 'session_user_message',
        sessionId: liveId,
        sessionPath: livePath,
        clientMessageId: clientMessageId || null,
        message: {
          id: clientMessageId || ('user-' + Date.now()),
          clientMessageId: clientMessageId || null,
          text: shown || '',
          timestamp: Date.now(),
          // Echo the display fields back. The frontend confirms the optimistic
          // bubble with `{...current, ...message}`, so an omitted key here is not
          // "leave it alone" — it overwrites the optimistic value with
          // `undefined`. Dropping these is what made quotes / attachments /
          // skills disappear the instant the turn was confirmed.
          ...displayFields(msg.displayMessage),
        },
      });

      try {
        if (type === 'interject') {
          await api.steer(liveId, text, msgId);
          // Steer is fire-and-forget at a step boundary; surface a short ack.
          push({ type: 'text_delta', sessionId: liveId, sessionPath: livePath, delta: '' });
        } else {
          // Seed an empty assistant bubble immediately so the avatar + waiting
          // dots show before the first real token arrives from Studio.
          push({ type: 'text_delta', sessionId: liveId, sessionPath: livePath, delta: '' });
          await api.sendWithProgress(liveId, promptText, msgId, (progress) => {
            const kind = progress && progress.kind;
            if (kind === 'thinking_start') {
              push({ type: 'thinking_start', sessionId: liveId, sessionPath: livePath });
            } else if (kind === 'thinking_delta') {
              push({
                type: 'thinking_delta',
                sessionId: liveId,
                sessionPath: livePath,
                delta: progress.delta || '',
              });
            } else if (kind === 'thinking_end') {
              push({ type: 'thinking_end', sessionId: liveId, sessionPath: livePath });
            } else if (kind === 'text_delta') {
              push({
                type: 'text_delta',
                sessionId: liveId,
                sessionPath: livePath,
                delta: progress.delta || '',
              });
            } else if (kind === 'assistant_snapshot') {
              push({
                type: 'assistant_snapshot',
                sessionId: liveId,
                sessionPath: livePath,
                segments: Array.isArray(progress.segments) ? progress.segments : [],
              });
            } else if (kind === 'tool_start') {
              push({
                type: 'tool_start',
                sessionId: liveId,
                sessionPath: livePath,
                id: progress.id,
                name: progress.name,
                args: progress.args,
                startedAt: progress.startedAt,
              });
            } else if (kind === 'tool_end') {
              push({
                type: 'tool_end',
                sessionId: liveId,
                sessionPath: livePath,
                id: progress.id,
                name: progress.name,
                success: progress.success !== false,
                status: progress.success === false ? 'failed' : 'succeeded',
                startedAt: progress.startedAt,
                finishedAt: progress.finishedAt,
                ...(progress.output ? { output: progress.output } : {}),
                ...(progress.error ? { error: progress.error } : {}),
                ...(progress.details ? { details: progress.details } : {}),
              });
            }
          }, nativeImages.length > 0 ? { images: nativeImages } : undefined);
        }
      } catch (err) {
        push({
          type: 'error',
          sessionId: liveId,
          sessionPath: livePath,
          code: err?.code || 'turn_failed',
          message: err && err.message ? err.message : String(err),
        });
        push({ type: 'status', sessionId: liveId, sessionPath: livePath, isStreaming: false });
        if (turn) deactivateTurn(turn);
        return { events: collected, streamed: typeof emit === 'function' };
      }

      push({ type: 'turn_end', sessionId: liveId, sessionPath: livePath });
      push({ type: 'status', sessionId: liveId, sessionPath: livePath, isStreaming: false });
      if (turn) deactivateTurn(turn);
      return { events: collected, streamed: typeof emit === 'function' };
    }

    return { events: [], streamed: true };
  };

  const handle = (req, emit) => {
    const data = req || {};
    if (data.op === 'ws') return ws(data.message || {}, emit);
    const path = data.path || '/';
    const search = data.search ? String(data.search).replace(/^\?/, '') : '';
    const full = search ? (path + (path.indexOf('?') >= 0 ? '&' : '?') + search) : path;
    return http(data.method, full, data.body);
  };

  return {
    handle,
    http,
    ws,
    pathFor,
    idFrom,
    ASSISTANT_ID,
    PATH_PREFIX,
  };
})();
