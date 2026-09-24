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

  const ASSISTANT_ID = 'studio';
  const ASSISTANT_NAME = 'Hanako';
  const PATH_PREFIX = 'studio://';

  const pathFor = (id) => PATH_PREFIX + encodeURIComponent(String(id));

  // Studio progress callbacks can outlive cancel_agent. Keep a per-session
  // turn token so Stop can synchronously invalidate every late callback before
  // awaiting the backend cancellation request.
  const activeTurns = new Map();
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
  const PIN_ORDER_STEP = 1024;
  const UNCATEGORIZED_PROJECT_ID = 'cwd:';

  const trimName = (value) => {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, 80);
  };

  const nextId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // Prefer localStorage when it works; keep an in-memory mirror so pin /
  // project catalog still function in Node harnesses or private mode where
  // Storage exists but setItem/getItem no-ops or throws.
  const memoryStore = new Map();
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


  // ── Per-session model assignment (local; Studio agents bind model at create) ──
  const SESSION_MODEL_KEY = 'openhanako.sessionModels.v1';
  const PENDING_MODEL_KEY = 'openhanako.pendingModel.v1';

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
  const modelForPath = (sessionPathOrId) => {
    const path = sessionPathOrId && String(sessionPathOrId).startsWith(PATH_PREFIX)
      ? String(sessionPathOrId)
      : pathFor(sessionPathOrId || '');
    const map = loadSessionModels();
    const hit = map[path] || map[String(sessionPathOrId || '')];
    if (hit && hit.modelId && hit.provider) {
      return { modelId: String(hit.modelId), provider: String(hit.provider) };
    }
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

  const handleSessionProjects = (pathname, verb, body) => {
    if (pathname !== '/api/session-projects' && !pathname.startsWith('/api/session-projects/')) {
      return null;
    }

    if (pathname === '/api/session-projects' && verb === 'GET') {
      return { catalog: loadCatalog() };
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
      const assignments = loadAssignments();
      if (!projectId || projectId === UNCATEGORIZED_PROJECT_ID) delete assignments[sessionPath];
      else assignments[sessionPath] = projectId;
      saveAssignments(assignments);
      return { ok: true, assignment: { sessionPath, projectId } };
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
      if (typeof localStorage === 'undefined') return {};
      const raw = JSON.parse(localStorage.getItem(PROVIDER_OVERLAY_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (_) { return {}; }
  };

  const writeOverlay = (overlay) => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(PROVIDER_OVERLAY_KEY, JSON.stringify(overlay || {}));
    } catch (_) {}
  };

  const modelIdOf = (entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof entry.id === 'string') return entry.id;
    return '';
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
      const models = list.length
        ? list.map((id) => (typeof id === 'string' ? id : modelIdOf(id))).filter(Boolean)
        : (entry.model ? [entry.model] : []);
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
      const models = list.length
        ? list.map((id) => (typeof id === 'string' ? id : modelIdOf(id))).filter(Boolean)
        : (entry.model ? [entry.model] : []);
      const hasKey = !!(typeof entry.api_key === 'string' && entry.api_key.trim());
      const hasUrl = !!(typeof entry.base_url === 'string' && entry.base_url.trim());
      summary[name] = {
        display_name: name,
        has_credentials: hasKey || hasUrl,
        is_configured: hasUrl,
        supports_oauth: false,
        is_coding_plan: false,
        models,
        base_url: typeof entry.base_url === 'string' ? entry.base_url : '',
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
      return {
        locale: 'zh-CN',
        editor: null,
        studioBridge: api.mode(),
        providers: studioProvidersToHana(llm),
        llm,
      };
    }

    if (pathname === '/api/config' && (verb === 'PUT' || verb === 'PATCH' || verb === 'POST')) {
      const patch = body && typeof body === 'object' ? body : {};
      if (patch.providers && typeof patch.providers === 'object') {
        await applyProvidersPatchToStudio(patch.providers);
      }
      const llm = await api.getLlmConfig();
      return {
        ok: true,
        locale: 'zh-CN',
        studioBridge: api.mode(),
        providers: studioProvidersToHana(llm),
      };
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
      const models = Array.isArray(discovered) ? discovered
        : (Array.isArray(lists) ? lists.map((id) => ({ id })) : []);
      return { models };
    }

    const modelMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models\/([^/]+)$/);
    if (modelMatch && (verb === 'PATCH' || verb === 'PUT' || verb === 'DELETE')) {
      // Soft-ack model metadata edits; Studio stores flat id lists today.
      return { ok: true };
    }

    if (pathname === '/api/preferences/models' && verb === 'GET') {
      const llm = await api.getLlmConfig();
      const current = llm && llm.current && typeof llm.current === 'object' ? llm.current : {};
      return {
        models: {
          utility: current.provider && current.model
            ? { provider: current.provider, model: current.model }
            : null,
          utility_large: null,
          vision: null,
          vision_enabled: false,
        },
        search: { provider: 'auto', api_key: '', api_keys: {} },
      };
    }

    if (pathname === '/api/preferences/models' && (verb === 'PUT' || verb === 'POST' || verb === 'PATCH')) {
      return { ok: true };
    }

    return null;
  };


  const projection = (row) => {
    const path = pathFor(row.id);
    const pin = loadPins()[path] || null;
    const updatedAt = row.updated_at ?? row.updatedAt ?? null;
    const timestamp = updatedAt == null ? null : new Date(updatedAt);
    const isoTimestamp = timestamp && !Number.isNaN(timestamp.getTime())
      ? timestamp.toISOString()
      : null;
    return {
      path,
      sessionId: row.id,
      title: row.title || null,
      firstMessage: row.title || '',
      ...(isoTimestamp ? { modified: isoTimestamp, created: isoTimestamp } : {}),
      messageCount: row.messages || 0,
      cwd: null,
      agentId: ASSISTANT_ID,
      agentName: ASSISTANT_NAME,
      modelId: api.DEFAULT_MODEL,
      modelProvider: api.DEFAULT_PROVIDER,
      pinnedAt: pin ? pin.pinnedAt : null,
      pinOrder: pin && Number.isFinite(pin.pinOrder) ? pin.pinOrder : null,
      live: row.live !== false,
      busy: !!row.busy,
      projectId: loadAssignments()[path] || null,
    };
  };

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

  const historyMessage = (m, index, transcriptResults) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = m.text || '';
    const row = {
      id: String(index),
      role,
      content: text,
      timestamp: Date.now(),
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

  // Soft stubs for openhanako surfaces that are not part of the Studio agent
  // vertical slice. Returning empty/ok stops noisy 404s in the harness and
  // iframe console without pretending the feature exists.
  const stubHttp = (pathname, verb) => {
    if (pathname === '/api/preferences/models' && verb === 'GET') {
      return {
        models: [{ id: api.DEFAULT_MODEL, name: api.DEFAULT_MODEL, provider: api.DEFAULT_PROVIDER }],
        current: api.DEFAULT_MODEL,
      };
    }
    if (pathname === '/api/session-thinking-level' && (verb === 'GET' || verb === 'POST')) {
      return { level: 'off' };
    }
    if (pathname === '/api/user-profile' && verb === 'GET') {
      return { name: 'User', avatar: null };
    }
    if (pathname === '/api/desk/cron' && verb === 'GET') {
      return { jobs: [] };
    }
    if (pathname === '/api/agents/primary' && verb === 'GET') {
      return { id: ASSISTANT_ID, name: ASSISTANT_NAME };
    }
    if (pathname === '/api/agents/switch' && verb === 'POST') {
      return { ok: true, agentId: ASSISTANT_ID };
    }
    if (pathname === '/api/models/auxiliary-vision' && verb === 'GET') {
      return { available: false };
    }
    if (pathname === '/api/upload-blob' && verb === 'POST') {
      return { ok: false, error: 'studio bridge: upload not supported' };
    }
    if (pathname.startsWith('/api/bridge')) {
      return { ok: true, studioBridge: api.mode() };
    }
    if (pathname === '/api/sessions/archived' && verb === 'GET') return [];
    if (pathname === '/api/sessions/cleanup' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/continue-deleted-agent' && verb === 'POST') return { ok: false };
    if (pathname === '/api/sessions/fresh-compact' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/rename' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/restore' && verb === 'POST') return { ok: true };
    if (pathname === '/api/sessions/todos/complete' && verb === 'POST') return { ok: true };
    return null;
  };

  // Ids we successfully disposed this process — refuse silent resume so a
  // deleted/archived session cannot sticky-reattach via ensureLive.
  const disposedIds = new Set();

  const ensureLive = async (sessionId) => {
    if (!sessionId) throw new Error('missing session');
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

  /** Archive/delete must dispose the driver AND purge the JSONL (Studio side). */
  const disposeSession = async (sessionId) => {
    if (!sessionId) return { ok: false, error: 'missing session' };
    try {
      await api.dispose(sessionId);
      disposedIds.add(sessionId);
      clearPinForSession(sessionId);
      const assignments = loadAssignments();
      const path = pathFor(sessionId);
      if (assignments[path]) {
        delete assignments[path];
        saveAssignments(assignments);
      }
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

    if (pathname === '/api/health' && verb === 'GET') {
      return {
        status: 'ok',
        version: 'studio-bridge',
        agentId: ASSISTANT_ID,
        agent: ASSISTANT_NAME,
        agentYuan: 'hanako',
        user: 'User',
        model: api.DEFAULT_MODEL,
        avatars: { agent: false, user: false },
        sessionStore: null,
        studioBridge: api.mode(),
      };
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
        userLabel: 'User',
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
        const provider = typeof current.provider === 'string' && current.provider
          ? current.provider
          : (typeof llm.default === 'string' ? llm.default : api.DEFAULT_PROVIDER);
        const model = typeof current.model === 'string' && current.model
          ? current.model
          : api.DEFAULT_MODEL;
        const lists = llm && llm.model_lists && typeof llm.model_lists === 'object' ? llm.model_lists : {};
        const models = [];
        Object.keys(lists).forEach((prov) => {
          const arr = Array.isArray(lists[prov]) ? lists[prov] : [];
          arr.forEach((id) => {
            const mid = typeof id === 'string' ? id : (id && id.id);
            if (!mid) return;
            models.push({
              id: mid,
              name: mid,
              provider: prov,
              isCurrent: prov === provider && mid === model,
            });
          });
        });
        if (!models.length) {
          models.push({ id: model, name: model, provider, isCurrent: true });
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
      return {
        ok: true,
        model: serializeModel(modelId, provider, displayName),
        thinkingLevel: 'medium',
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
      return { permissionMode: 'ask' };
    }

    if (pathname === '/api/agents' && verb === 'GET') {
      return {
        agents: [{
          id: ASSISTANT_ID,
          name: ASSISTANT_NAME,
          yuan: 'hanako',
          isPrimary: true,
          hasAvatar: false,
        }],
      };
    }

    if (/^\/api\/agents\/[^/]+\/config$/.test(pathname) && verb === 'GET') {
      return { chat: {}, memory: { enabled: true } };
    }

    if (pathname === '/api/sessions' && verb === 'GET') {
      const rows = await api.sessions();
      return rows.map(projection);
    }

    if ((pathname === '/api/sessions/new' || pathname === '/api/sessions/new-detached') && verb === 'POST') {
      const pending = modelForPath(null);
      const id = await api.create(pending.provider, pending.modelId);
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
        cwd: null,
        workspaceFolders: [],
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
      const assigned = modelForPath(pathFor(liveId));
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
      return disposeSession(sessionIdFromBody(body, query));
    }

    if (pathname === '/api/sessions/archived/delete' && verb === 'POST') {
      return disposeSession(sessionIdFromBody(body, query));
    }

    if ((pathname === '/api/sessions/delete' || pathname === '/api/sessions/remove') && verb === 'POST') {
      return disposeSession(sessionIdFromBody(body, query));
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
        messages: rows
          .map((message, index) => {
            const transportOnly = message?.role === 'user'
              && !message.text
              && !message.reasoning
              && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
              && Array.isArray(message.tool_results)
              && message.tool_results.length > 0;
            return transportOnly ? null : historyMessage(message, index, results);
          })
          .filter(Boolean),
        blocks: [],
        todos: todosFromTranscript(rows, results),
        sessionFiles: [],
        hasMore: false,
        revision: 'studio-' + liveId,
      };
    }

    const projectResult = handleSessionProjects(pathname, verb, body);
    if (projectResult !== null) return projectResult;

    const stub = stubHttp(pathname, verb);
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
      if (requestedStreamId && (!active || active.streamId !== requestedStreamId)) {
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
          await api.sendWithProgress(liveId, text, msgId, (progress) => {
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
          });
        }
      } catch (err) {
        push({
          type: 'error',
          sessionId: liveId,
          sessionPath: livePath,
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
