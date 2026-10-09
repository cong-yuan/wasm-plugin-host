// Ported verbatim from openhanako RightWorkspacePanel.tsx (Apache-2.0).
// Upstream: desktop/src/react/components/right-workspace/RightWorkspacePanel.tsx
// Upstream hashes CSS-module class names; build-css.mjs appends the module
// rules unhashed, so the raw names below match the generated stylesheet.
return (function () {
  const { h, svg, clear } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const adapter = studio.require('lib/hana-adapter');
  const api = studio.require('lib/api');
  const { t } = studio.require('lib/i18n');
  // In-memory fallback is deliberately shared by panel instances in this host.
  const jianMirror = new Map();

  // function Chevron({ open }) — upstream markup, both branches.
  const CHEVRON_OPEN = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>`;
  const CHEVRON_CLOSED = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>`;

  // BASE_TABS
  const BASE_TABS = [
    { id: 'session-files', labelKey: 'rightWorkspace.tabs.sessionFiles' },
    { id: 'workspace', labelKey: 'rightWorkspace.tabs.workspace' },
  ];

  function render() {
    const state = { tab: 'workspace', jianOpen: false, sessionId: null };
    let historyVersion = 0;
    let historyView = { kind: 'idle' };
    let restoreIntent = null;
    let disposed = false;
    let workspaceVersion = 0;
    let workspacePath = '';
    let workspaceQuery = '';
    let workspaceFilter = '';
    let workspaceState = { kind: 'idle' };
    let workspaceEdit = null; // {name, subdir, version, content, original, create, saving, error}
    let workspaceMutation = null; // native rename/move/safe-delete intent
    let workspaceNotice = '';
    let workspaceUpload = null;
    let checkpointState = { kind: 'idle', rows: [] };
    let checkpointVersion = 0;
    let checkpointIntent = null;
    let latestData = { tools: [], plugins: [], runtime: { mode: 'unknown', sessions: [] } };

    // <div className={styles.workspaceHeader}> + workspaceTitle
    const title = h('div', { class: 'workspaceTitle' }, t('desk.title'));
    const header = h('div', { class: 'workspaceHeader' }, title);
    const headerSlot = h('div', { class: 'rail-header-slot' });
    slots.mount('openhanako.rail.header', headerSlot);

    // <div className={styles.tabs} role="tablist"> with slider + 2 tabs
    const slider = h('div', {
      class: 'tabSlider', 'data-right-workspace-tab-slider': '', 'aria-hidden': 'true',
    });
    const tabs = h('div', {
      class: 'tabs', role: 'tablist', 'aria-label': t('rightWorkspace.tabs.label'),
      style: '--right-workspace-active-tab-index:1;--right-workspace-tab-slider-offset:calc(100% + 2px)',
    }, slider);
    const tabButtons = BASE_TABS.map((tab) => {
      const selected = state.tab === tab.id;
      const btn = h('button', {
        type: 'button',
        class: 'tab' + (selected ? ' tabActive' : ''),
        role: 'tab',
        'aria-selected': String(selected),
      }, t(tab.labelKey));
      btn.onclick = () => selectTab(tab.id);
      tabs.appendChild(btn);
      return { id: tab.id, btn };
    });

    // <div className={styles.content} role="tabpanel"> → TabContent
    const runtimeSummary = h('div', { class: 'runtimeSummary' });
    const slotSummary = h('div', { class: 'slotSummary' });
    const fileList = h('div', { class: 'fileList' });
    const workspaceBrowser = h('section', { class: 'railWorkspaceBrowser', 'aria-label': 'Workspace files' });
    const checkpointPanel = h('section', { class: 'railCheckpointPanel', 'aria-label': 'Native checkpoints' });
    const itemsSlot = h('div', { class: 'rail-items-slot' });
    const content = h('div', { class: 'content', role: 'tabpanel' }, runtimeSummary, slotSummary, workspaceBrowser, checkpointPanel, fileList, itemsSlot);
    slots.mount('openhanako.rail.items', itemsSlot);

    // <section className={styles.jianDrawer} data-open=…>
    const jianMaxChars = 32000;
    let jianClearArmed = false;
    const editor = h('textarea', {
      class: 'jian-editor',
      'data-desk-editor': '',
      placeholder: t('desk.jianPlaceholder'),
      maxlength: String(jianMaxChars),
    });
    const jianStatus = h('div', { class: 'jianStatus', 'aria-live': 'polite' }, '');
    const jianCounter = h('span', { class: 'jianCounter' }, '0 / 32000');
    const jianClear = h('button', { class: 'jianClear', type: 'button' }, 'Clear note');
    const jianScope = h('span', { class: 'jianScope' }, 'Workspace note');
    const noteKey = () => 'openhanako.jian.notes.v1:' + encodeURIComponent(state.sessionId || 'workspace');
    const noteStorage = () => {
      try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
    };
    let jianDurability = 'memory';
    const writeNote = (text) => {
      const key = noteKey();
      jianMirror.set(key, text);
      const storage = noteStorage();
      if (!storage) { jianDurability = 'memory'; return; }
      try {
        storage.setItem(key, text);
        jianDurability = 'local';
      } catch {
        jianDurability = 'memory';
      }
    };
    const readNote = () => {
      const key = noteKey();
      const storage = noteStorage();
      if (storage) {
        try {
          const persisted = storage.getItem(key);
          if (typeof persisted === 'string') {
            jianMirror.set(key, persisted);
            jianDurability = 'local';
            return persisted.slice(0, jianMaxChars);
          }
        } catch { /* do not assume local persistence works in this sandbox */ }
      }
      jianDurability = 'memory';
      return String(jianMirror.get(key) || '').slice(0, jianMaxChars);
    };
    const updateJianStatus = (message) => {
      jianScope.textContent = state.sessionId ? 'Session note' : 'Workspace note';
      jianCounter.textContent = `${String(editor.value || '').length} / ${jianMaxChars}`;
      jianClear.textContent = jianClearArmed ? 'Confirm clear' : 'Clear note';
      jianStatus.textContent = message || (jianDurability === 'local'
        ? 'Saved locally in this browser' : 'Only kept in this open application (storage unavailable)');
    };
    const hydrateJian = () => {
      jianClearArmed = false;
      editor.value = readNote();
      updateJianStatus();
    };
    editor.oninput = () => {
      const value = String(editor.value || '');
      if (value.length > jianMaxChars) {
        editor.value = value.slice(0, jianMaxChars);
        jianClearArmed = false;
        writeNote(editor.value);
        updateJianStatus('Note limited to 32,000 characters');
        return;
      }
      jianClearArmed = false;
      writeNote(value);
      updateJianStatus();
    };
    jianClear.onclick = () => {
      if (jianClearArmed) {
        jianClearArmed = false;
        editor.value = '';
        writeNote('');
        updateJianStatus();
      } else {
        jianClearArmed = true;
        updateJianStatus('Click Confirm clear to delete this note locally');
      }
    };
    const drawer = h('section', {
      class: 'jianDrawer', 'data-open': 'false', role: 'region', 'aria-label': t('desk.jianLabel'),
    },
      h('div', { class: 'jianHeader' }, h('span', { class: 'jianTitle' }, t('desk.jianLabel')), jianScope, jianCounter, jianClear),
      h('div', { class: 'jianBody' }, editor, jianStatus));
    hydrateJian();

    // function JianFloatingToggle()
    const jianToggle = h('button', {
      class: 'jianToggle', type: 'button',
      'aria-label': t('rightWorkspace.jian.expand'), 'aria-expanded': 'false',
    }, svg(CHEVRON_CLOSED));
    jianToggle.onclick = () => {
      jianClearArmed = false;
      updateJianStatus();
      state.jianOpen = !state.jianOpen;
      drawer.setAttribute('data-open', state.jianOpen ? 'true' : 'false');
      card.setAttribute('data-jian-open', state.jianOpen ? 'true' : 'false');
      jianToggle.setAttribute('aria-expanded', String(state.jianOpen));
      jianToggle.setAttribute('aria-label',
        t(state.jianOpen ? 'rightWorkspace.jian.collapse' : 'rightWorkspace.jian.expand'));
      clear(jianToggle);
      jianToggle.appendChild(svg(state.jianOpen ? CHEVRON_OPEN : CHEVRON_CLOSED));
    };

    // <div className={`universal-card ${styles.workspaceCard}`} …>
    const card = h('div', {
      class: 'universal-card workspaceCard',
      'data-right-workspace-card': '',
      'data-jian-open': 'false',
    }, header, headerSlot, tabs, content, drawer, jianToggle);

    // <div className={styles.shell}>
    const shell = h('div', { class: 'workspaceShell' }, card);

    // The host shell needs a collapsible aside around the upstream panel.
    const root = h('aside', { class: 'jian-sidebar', id: 'jianSidebar' },
      h('div', { class: 'resize-handle resize-handle-left', id: 'jianResizeHandle' }),
      h('div', { class: 'jian-sidebar-inner' }, shell));

    const editIsDirty = () => workspaceEdit && (workspaceEdit.create || workspaceEdit.content !== workspaceEdit.original);
    const guardEdit = () => {
      if (workspaceUpload?.busy) { workspaceUpload.error = 'Upload in progress'; renderData(latestData); return true; }
      if (workspaceMutation?.busy) {
        workspaceMutation.error = 'Native file operation is still in progress';
        renderData(latestData);
        return true;
      }
      if (!workspaceEdit) { workspaceMutation = null; workspaceUpload = null; return false; }
      if (!editIsDirty() && !workspaceEdit.saving) { workspaceEdit = null; return false; }
      workspaceEdit.error = workspaceEdit.saving
        ? 'A native save is in progress; finish before navigating'
        : 'Unsaved changes: Save or Discard before navigating';
      renderData(latestData);
      return true;
    };
    function selectTab(id) {
      if (state.tab !== id && (restoreIntent?.busy || checkpointIntent?.busy)) return;
      if (state.tab !== id && guardEdit()) return;
      if (state.tab !== id) checkpointIntent = null;
      state.tab = id;
      const index = Math.max(0, BASE_TABS.findIndex((tab) => tab.id === id));
      tabs.setAttribute('style',
        `--right-workspace-active-tab-index:${index};` +
        `--right-workspace-tab-slider-offset:${index === 0 ? '0px' : 'calc(100% + 2px)'}`);
      for (const { id: tabId, btn } of tabButtons) {
        const selected = tabId === id;
        btn.className = 'tab' + (selected ? ' tabActive' : '');
        btn.setAttribute('aria-selected', String(selected));
      }
      renderData(latestData);
      if (state.tab === 'session-files') loadHistory();
      else { loadWorkspace(); loadCheckpoints(); }
    }

    function renderData(data) {
      const tools = (data && data.tools) || [];
      const plugins = (data && data.plugins) || [];
      const runtime = (data && data.runtime) || { mode: 'unknown', sessions: [] };
      clear(runtimeSummary);
      clear(slotSummary);
      clear(fileList);
      workspaceBrowser.style.display = state.tab === 'workspace' ? '' : 'none';
      checkpointPanel.style.display = state.tab === 'workspace' ? '' : 'none';
      if (state.tab === 'workspace') { renderWorkspace(); renderCheckpoints(); }

      if (state.tab === 'session-files') {
        content.setAttribute('data-content-state', historyView.kind);
        renderHistory();
        return;
      }

      content.setAttribute('data-content-state', 'workspace');
      const sessions = Array.isArray(runtime.sessions) ? runtime.sessions : [];
      const running = sessions.filter((session) => session.status === 'running' || session.isStreaming).length;
      const errors = sessions.filter((session) => session.status === 'error' || session.error).length;
      const activeTools = sessions.reduce((sum, session) => sum + (Number(session.activeToolCount) || 0), 0);
      const metrics = [
        ['Sessions', sessions.length],
        ['Running', running],
        ['Active tools', activeTools],
        ['Errors', errors],
        ['Plugins', plugins.length],
      ];
      for (const [label, value] of metrics) {
        runtimeSummary.appendChild(h('div', {
          class: 'runtimeMetric' + (label === 'Errors' && value > 0 ? ' runtimeMetricError' : ''),
        },
          h('span', { class: 'runtimeMetricLabel' }, label),
          h('strong', { class: 'runtimeMetricValue' }, String(value))));
      }
      runtimeSummary.setAttribute('data-runtime-mode', runtime.mode || 'unknown');
      const slotState = slots.snapshot();
      slotSummary.textContent = `Slots ${slotState.mounted}/${slotState.total} · visible ${slotState.visible} · contributions ${slotState.contributions}`;
      slotSummary.setAttribute('data-contributions', String(slotState.contributions));
      if (!tools.length) {
        fileList.appendChild(h('div', { class: 'emptyState' }, 'No host tools available'));
        return;
      }
      for (const tool of tools.slice(0, 12)) {
        fileList.appendChild(h('div', { class: 'fileRow' },
          h('div', { class: 'fileMain' },
            h('div', { class: 'fileName' }, tool.name || 'tool'))));
      }
    }

    // The default native workspace root is resolved and scoped by the host.
    // Mutations require native capability, explicit version and scope-checked root coordinates.
    const validName = (name) => typeof name === 'string' && name.length > 0
      && name !== '.' && name !== '..' && !/[\/\\\0-\x1f]/.test(name);
    const workspaceCurrent = (version, subdir) => !disposed
      && state.tab === 'workspace' && workspaceVersion === version && workspacePath === subdir;
    const setWorkspaceState = (view, version, subdir) => {
      if (!workspaceCurrent(version, subdir)) return;
      workspaceState = view;
      renderData(latestData);
    };
    const loadWorkspace = async () => {
      if (guardEdit()) return;
      const subdir = workspacePath;
      const version = ++workspaceVersion;
      if (!api.workbenchListFilesAvailable?.()) {
        setWorkspaceState({ kind: 'unavailable', text: 'Native workspace browsing is unavailable in this Studio host' }, version, subdir);
        return;
      }
      setWorkspaceState({ kind: 'loading', text: 'Loading workspace files…' }, version, subdir);
      try {
        const response = await adapter.http('GET', `/api/workbench/files?rootId=default&subdir=${encodeURIComponent(subdir)}`);
        if (!response || response.ok === false || response.error || !Array.isArray(response.files)
          || (response.rootId != null && response.rootId !== 'default')
          || (response.subdir != null && response.subdir !== subdir)
          || response.files.some((row) => !row || !validName(row.name) || typeof row.isDir !== 'boolean')) {
          throw new Error(response?.error || 'Invalid workspace directory response');
        }
        setWorkspaceState({ kind: 'files', files: response.files }, version, subdir);
      } catch (err) {
        setWorkspaceState({ kind: 'error', text: err?.message || 'Workspace browsing failed' }, version, subdir);
      }
    };
    const openWorkspaceFile = async (name) => {
      if (guardEdit()) return;
      workspaceNotice = '';
      if (!validName(name) || !api.workbenchReadFileAvailable?.()) {
        workspaceState = { kind: 'unavailable', text: 'Native file reading is unsupported by this Studio host' };
        renderData(latestData);
        return;
      }
      const subdir = workspacePath;
      const version = ++workspaceVersion;
      setWorkspaceState({ kind: 'loading', text: `Reading ${name}…` }, version, subdir);
      try {
        const response = await adapter.http('GET', `/api/workbench/content?rootId=default&subdir=${encodeURIComponent(subdir)}&name=${encodeURIComponent(name)}`);
        const mime = response?.__httpHeaders?.['Content-Type'] || '';
        if (!response || response.__httpStatus !== 200 || typeof response.__httpBody !== 'string'
          || !(/^(text\/|application\/(json|xml|javascript))/.test(String(mime)))) {
          throw new Error(response?.error || 'File is unavailable or cannot be previewed as text');
        }
        setWorkspaceState({ kind: 'preview', name, content: response.__httpBody,
          fileVersion: response.__httpHeaders?.['X-Hana-File-Version'] || null }, version, subdir);
      } catch (err) {
        setWorkspaceState({ kind: 'error', text: err?.message || 'File preview failed' }, version, subdir);
      }
    };
    const validRelativePath = (path) => typeof path === 'string' && path.length > 0
      && path.split('/').every(validName);
    const searchWorkspace = async () => {
      if (guardEdit()) return;
      const query = workspaceQuery.trim();
      if (!query) return loadWorkspace();
      const subdir = workspacePath;
      const version = ++workspaceVersion;
      if (query.length > 160) {
        setWorkspaceState({ kind: 'error', text: 'Workspace search must be at most 160 characters' }, version, subdir);
        return;
      }
      if (!api.workbenchSearchFilesAvailable?.()) {
        setWorkspaceState({ kind: 'unavailable', text: 'Native workspace search is not supported by this Studio host' }, version, subdir);
        return;
      }
      setWorkspaceState({ kind: 'loading', text: 'Searching workspace files…' }, version, subdir);
      try {
        const response = await adapter.http('GET', `/api/workbench/search?rootId=default&q=${encodeURIComponent(query)}`);
        if (!response || response.ok === false || response.error || !Array.isArray(response.results)
          || (response.rootId != null && response.rootId !== 'default')
          || (response.query != null && response.query !== query)
          || response.results.some((row) => !row || !validRelativePath(row.relativePath)
            || !validName(row.name) || row.name !== row.relativePath.split('/').slice(-1)[0]
            || typeof row.isDir !== 'boolean')) {
          throw new Error(response?.error || 'Invalid workspace search response');
        }
        setWorkspaceState({ kind: 'search', results: response.results, query }, version, subdir);
      } catch (err) {
        setWorkspaceState({ kind: 'error', text: err?.message || 'Workspace search failed' }, version, subdir);
      }
    };
    const changeWorkspacePath = (subdir) => {
      if (guardEdit()) return;
      workspaceNotice = '';
      workspaceVersion += 1;
      workspacePath = subdir;
      workspaceFilter = '';
      loadWorkspace();
    };
    const beginWorkspaceEdit = ({ name, content, fileVersion = null, create = false }) => {
      if (workspaceMutation || !validName(name) || !api.workbenchWriteFileAvailable?.()
        || (!create && (typeof fileVersion !== 'string' || !fileVersion.trim()))
        || typeof content !== 'string' || content.length > 256000) return false;
      workspaceEdit = {
        name, subdir: workspacePath, version: fileVersion, create,
        content, original: content, saving: false, error: '',
      };
      workspaceVersion += 1;
      workspaceState = { kind: 'edit' };
      renderData(latestData);
      return true;
    };
    const discardWorkspaceEdit = () => {
      if (!workspaceEdit || workspaceEdit.saving) return;
      workspaceEdit = null;
      loadWorkspace();
    };
    const saveWorkspaceEdit = async () => {
      const edit = workspaceEdit;
      if (!edit || edit.saving) return;
      if (edit.content.length > 256000) {
        edit.error = 'Text file exceeds the 256,000-character editing limit';
        renderData(latestData);
        return;
      }
      const version = workspaceVersion;
      edit.saving = true;
      edit.error = 'Saving to Studio…';
      renderData(latestData);
      try {
        const response = await adapter.http('POST', '/api/workbench/actions', {
          action: edit.create ? 'create' : 'writeText', rootId: 'default',
          subdir: edit.subdir, name: edit.name, content: edit.content,
          ...(edit.create ? {} : { expectedVersion: edit.version }),
        });
        if (!response || response.ok !== true || response.action !== (edit.create ? 'create' : 'writeText')
          || typeof response.version !== 'string' || !response.version.trim()) {
          throw new Error(response?.error || 'Studio did not acknowledge this file write');
        }
        if (disposed || workspaceEdit !== edit || workspaceVersion !== version) return;
        workspaceEdit = null;
        workspaceState = { kind: 'preview', name: edit.name, content: edit.content,
          fileVersion: response.version, saved: true };
        renderData(latestData);
      } catch (err) {
        if (disposed || workspaceEdit !== edit || workspaceVersion !== version) return;
        edit.error = err?.error || err?.message || 'Save failed; changes kept for retry';
      } finally {
        edit.saving = false;
        if (!disposed && workspaceEdit === edit && workspaceVersion === version) renderData(latestData);
      }
    };
    const startWorkspaceMutation = (action) => {
      if (workspaceState.kind !== 'preview' || workspaceMutation || workspaceEdit) return;
      const { name, fileVersion } = workspaceState;
      const supported = {
        rename: api.workbenchRenameFileAvailable?.(),
        move: api.workbenchMoveFileAvailable?.(),
        safeDelete: api.workbenchDeleteFileAvailable?.(),
      }[action];
      if (!supported || !validName(name) || typeof fileVersion !== 'string' || !fileVersion.trim()) return;
      workspaceMutation = { action, name, subdir: workspacePath, fileVersion,
        value: action === 'rename' ? name : '', confirm: false, busy: false, error: '' };
      renderData(latestData);
    };
    const cancelWorkspaceMutation = () => {
      if (workspaceMutation?.busy) return;
      workspaceMutation = null;
      renderData(latestData);
    };
    const applyWorkspaceMutation = async () => {
      const mutation = workspaceMutation;
      if (!mutation || mutation.busy || disposed) return;
      const value = mutation.value.trim();
      if (mutation.action === 'rename' && (!validName(value) || value === mutation.name)) {
        mutation.error = 'Enter a different valid filename';
        renderData(latestData);
        return;
      }
      if (mutation.action === 'move' && (value === mutation.subdir
        || (value && !validRelativePath(value)))) {
        mutation.error = 'Enter a different safe workspace-relative destination';
        renderData(latestData);
        return;
      }
      if (mutation.action === 'safeDelete' && !mutation.confirm) {
        mutation.confirm = true;
        mutation.error = 'Confirm moving this file into the native safe-delete trash';
        renderData(latestData);
        return;
      }
      const requestVersion = workspaceVersion;
      mutation.busy = true;
      mutation.error = 'Applying native file operation…';
      renderData(latestData);
      try {
        const response = await adapter.http('POST', '/api/workbench/actions', {
          action: mutation.action, rootId: 'default', subdir: mutation.subdir,
          ...(mutation.action === 'rename' ? { oldName: mutation.name, newName: value }
            : mutation.action === 'move' ? { name: mutation.name, destSubdir: value }
              : { name: mutation.name }),
          expectedVersion: mutation.fileVersion,
        });
        if (!response || response.ok !== true || response.action !== mutation.action
          || typeof response.version !== 'string' || !response.version.trim()
          || (mutation.action === 'safeDelete' && (typeof response.trashId !== 'string' || !response.trashId.trim()))) {
          throw new Error(response?.error || 'Studio did not acknowledge the native file operation');
        }
        if (disposed || workspaceMutation !== mutation || workspaceVersion !== requestVersion) return;
        workspaceMutation = null;
        workspaceNotice = mutation.action === 'safeDelete' ? 'Moved file into native safe-delete trash'
          : mutation.action === 'rename' ? `Renamed to ${value}` : `Moved file to workspace /${value}`;
        loadWorkspace();
      } catch (error) {
        if (disposed || workspaceMutation !== mutation || workspaceVersion !== requestVersion) return;
        mutation.error = error?.error || error?.message || 'Native file operation failed';
        mutation.confirm = false;
      } finally {
        mutation.busy = false;
        if (!disposed && workspaceMutation === mutation && workspaceVersion === requestVersion) renderData(latestData);
      }
    };
    const uploadLimit = 5 * 1024 * 1024;
    const stageUpload = (file) => {
      if (workspaceUpload?.busy || workspaceEdit || workspaceMutation
        || workspaceState.kind !== 'files' || !api.workbenchUploadFileAvailable?.()) return;
      const name = String(file?.name || '');
      if (!validName(name) || !Number.isFinite(file?.size) || file.size <= 0
        || file.size > uploadLimit || typeof file?.arrayBuffer !== 'function') {
        workspaceUpload = { error: 'Choose one valid file of at most 5 MiB', busy: false };
      } else if (workspaceState.files.some((item) => item.name === name)) {
        workspaceUpload = { error: 'A file with that name already exists here', busy: false };
      } else {
        workspaceUpload = { file, name, subdir: workspacePath, busy: false, error: '' };
      }
      renderData(latestData);
    };
    const cancelUpload = () => {
      if (workspaceUpload?.busy) return;
      workspaceUpload = null;
      renderData(latestData);
    };
    const sendUpload = async () => {
      const job = workspaceUpload;
      if (!job?.file || job.busy || !api.workbenchUploadFileAvailable?.()) return;
      const version = workspaceVersion;
      job.busy = true;
      job.error = 'Uploading to local Studio…';
      renderData(latestData);
      try {
        const bytes = new Uint8Array(await job.file.arrayBuffer());
        if (!bytes.length || bytes.length > uploadLimit) throw new Error('Invalid file size');
        let binary = '';
        for (let pos = 0; pos < bytes.length; pos += 8192)
          binary += String.fromCharCode(...bytes.subarray(pos, pos + 8192));
        if (disposed || workspaceUpload !== job || workspaceVersion !== version) return;
        const response = await adapter.http('POST', '/api/workbench/upload', {
          rootId: 'default', subdir: job.subdir,
          files: [{ name: job.name, mimeType: job.file.type || 'application/octet-stream',
            contentBase64: btoa(binary) }],
        });
        const file = response?.results?.[0];
        if (response?.ok !== true || response.rootId !== 'default' || response.subdir !== job.subdir
          || !Array.isArray(response.results) || response.results.length !== 1
          || file?.ok !== true || file?.name !== job.name
          || typeof file?.version !== 'string' || !file.version.trim()) {
          throw new Error(file?.error || response?.error || 'Native upload was not acknowledged');
        }
        if (disposed || workspaceUpload !== job || workspaceVersion !== version) return;
        workspaceUpload = null;
        workspaceNotice = `Uploaded ${job.name} to Studio workspace`;
        loadWorkspace();
      } catch (error) {
        if (!disposed && workspaceUpload === job && workspaceVersion === version)
          job.error = error?.message || 'Native upload failed';
      } finally {
        job.busy = false;
        if (!disposed && workspaceUpload === job && workspaceVersion === version) renderData(latestData);
      }
    };
    // Native Checkpoints apply to host-owned files, not the selected chat.
    // Only host-provided IDs are usable; arbitrary paths cannot be entered.
    const checkpointIdValid = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
    const loadCheckpoints = async () => {
      if (checkpointIntent?.busy) return;
      checkpointIntent = null;
      const version = ++checkpointVersion;
      if (!api.checkpointListAvailable?.()) {
        checkpointState = { kind: 'unavailable', text: 'Native checkpoints unavailable on this Studio host' };
        renderData(latestData);
        return;
      }
      checkpointState = { kind: 'loading', text: 'Loading native checkpoints…' };
      renderData(latestData);
      try {
        const result = await adapter.http('GET', '/api/checkpoints');
        if (!result || result.ok === false || result.error || !Array.isArray(result.checkpoints)
          || result.checkpoints.some((row) => !row || !checkpointIdValid(row.id)
            || typeof row.path !== 'string' || !row.path.trim())) {
          throw new Error(result?.error || 'Invalid native checkpoint listing');
        }
        if (disposed || version !== checkpointVersion) return;
        checkpointState = { kind: 'list', rows: result.checkpoints.slice(0, 100) };
      } catch (err) {
        if (disposed || version !== checkpointVersion) return;
        checkpointState = { kind: 'error', text: err?.message || 'Native checkpoint listing failed' };
      }
      if (!disposed && version === checkpointVersion) renderData(latestData);
    };
    const runCheckpointAction = async (row, action) => {
      if (checkpointIntent?.busy || checkpointState.kind !== 'list'
        || !checkpointState.rows.some((item) => item.id === row.id)) return;
      const supported = action === 'restore' ? api.checkpointRestoreAvailable?.()
        : api.checkpointRemoveAvailable?.();
      if (!supported || !checkpointIdValid(row.id)) return;
      if (!checkpointIntent || checkpointIntent.id !== row.id || checkpointIntent.action !== action
        || checkpointIntent.path !== row.path || !checkpointIntent.confirmed) {
        checkpointIntent = { id: row.id, path: row.path, action, confirmed: true, busy: false,
          error: `Confirm ${action} for checkpoint ${row.id} (${row.path})` };
        renderData(latestData);
        return;
      }
      const intent = checkpointIntent;
      const version = checkpointVersion;
      intent.busy = true;
      intent.error = `Applying native checkpoint ${action}…`;
      renderData(latestData);
      try {
        const path = `/api/checkpoints/${encodeURIComponent(intent.id)}`;
        const result = await adapter.http(action === 'restore' ? 'POST' : 'DELETE',
          action === 'restore' ? `${path}/restore` : path);
        if (!result || result.ok !== true
          || (action === 'restore' && result.restoredTo !== intent.path)
          || (action === 'remove' && result.id !== intent.id)) {
          throw new Error(result?.error || `Native checkpoint ${action} not acknowledged`);
        }
        if (disposed || checkpointIntent !== intent || checkpointVersion !== version) return;
        checkpointIntent = null;
        checkpointState = { kind: 'status', text: `Native checkpoint ${action} confirmed for ${intent.id}` };
        renderData(latestData);
        // Re-list only after a completed native mutation. Do not infer new rows.
        await loadCheckpoints();
      } catch (err) {
        if (disposed || checkpointIntent !== intent || checkpointVersion !== version) return;
        intent.error = err?.message || `Native checkpoint ${action} failed`;
        intent.confirmed = false;
      } finally {
        intent.busy = false;
        if (!disposed && checkpointIntent === intent && checkpointVersion === version) renderData(latestData);
      }
    };
    const renderCheckpoints = () => {
      clear(checkpointPanel);
      const refresh = h('button', { type: 'button', class: 'railCheckpointRefresh' }, 'Refresh');
      refresh.disabled = !!checkpointIntent?.busy;
      refresh.onclick = loadCheckpoints;
      checkpointPanel.appendChild(h('div', { class: 'railCheckpointHeader' },
        h('strong', {}, 'Native file checkpoints'), refresh));
      if (checkpointState.kind !== 'list') {
        checkpointPanel.appendChild(h('div', { class: 'railCheckpointStatus', 'aria-live': 'polite' },
          checkpointState.text || 'No checkpoints loaded'));
        return;
      }
      if (!checkpointState.rows.length) checkpointPanel.appendChild(h('div', {
        class: 'railCheckpointStatus',
      }, 'No native checkpoints'));
      for (const row of checkpointState.rows) {
        const item = h('div', { class: 'railCheckpointRow' },
          h('div', { class: 'railCheckpointPath' }, row.path),
          h('div', { class: 'railCheckpointMeta' }, `${row.id} · ${row.reason || 'checkpoint'}`));
        for (const [action, label, available] of [
          ['restore', 'Restore', api.checkpointRestoreAvailable?.()],
          ['remove', 'Remove', api.checkpointRemoveAvailable?.()],
        ]) {
          if (!available) continue;
          const active = checkpointIntent && checkpointIntent.id === row.id && checkpointIntent.action === action;
          const button = h('button', { type: 'button', class: `railCheckpoint${action === 'restore' ? 'Restore' : 'Remove'}` },
            active && checkpointIntent.confirmed ? `Confirm ${label}` : label);
          button.disabled = !!checkpointIntent?.busy;
          button.onclick = () => runCheckpointAction(row, action);
          item.appendChild(button);
        }
        checkpointPanel.appendChild(item);
      }
      if (checkpointIntent) {
        const cancel = h('button', { type: 'button', class: 'railCheckpointCancel' }, 'Cancel checkpoint action');
        cancel.disabled = checkpointIntent.busy;
        cancel.onclick = () => { checkpointIntent = null; renderData(latestData); };
        checkpointPanel.appendChild(cancel);
        checkpointPanel.appendChild(h('div', { class: 'railCheckpointStatus', 'aria-live': 'polite' }, checkpointIntent.error));
      }
    };
    const renderWorkspace = () => {
      clear(workspaceBrowser);
      const refresh = h('button', { class: 'railWorkspaceRefresh', type: 'button' }, 'Refresh');
      refresh.onclick = loadWorkspace;
      const searchInput = h('input', {
        class: 'railWorkspaceSearchInput', type: 'search', 'aria-label': 'Search workspace files',
        placeholder: 'Find workspace file…',
      });
      searchInput.value = workspaceQuery;
      searchInput.oninput = () => {
        if (workspaceUpload?.busy || workspaceMutation?.busy || workspaceEdit?.saving) return;
        workspaceQuery = String(searchInput.value || '');
        // Typing invalidates a previously submitted asynchronous search immediately.
        workspaceVersion += 1;
      };
      searchInput.onkeydown = (event) => {
        if (event?.key === 'Enter' && !event?.isComposing) {
          event.preventDefault?.();
          searchWorkspace();
        }
      };
      const searchButton = h('button', { class: 'railWorkspaceSearchButton', type: 'button' }, 'Search');
      searchButton.onclick = searchWorkspace;
      const back = h('button', { class: 'railWorkspaceBack', type: 'button' }, 'Up');
      back.disabled = !workspacePath;
      back.onclick = () => changeWorkspacePath(workspacePath.split('/').slice(0, -1).join('/'));
      workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceHeader' },
        h('span', {}, `Workspace /${workspacePath}`), back, refresh));
      const breadcrumbs = h('nav', { class: 'railWorkspaceBreadcrumbs', 'aria-label': 'Workspace path' });
      const segments = workspacePath ? workspacePath.split('/') : [];
      for (let index = 0; index <= segments.length; index += 1) {
        const subdir = segments.slice(0, index).join('/');
        const crumb = h('button', { class: 'railWorkspaceCrumb', type: 'button' },
          index === 0 ? 'Root' : segments[index - 1]);
        crumb.disabled = subdir === workspacePath;
        crumb.onclick = () => changeWorkspacePath(subdir);
        breadcrumbs.appendChild(crumb);
      }
      workspaceBrowser.appendChild(breadcrumbs);
      workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceSearchRow' }, searchInput, searchButton));
      if (workspaceNotice) workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceSaveStatus', 'aria-live': 'polite' }, workspaceNotice));
      if (workspaceState.kind === 'files' && api.workbenchUploadFileAvailable?.()) {
        const chooser = h('input', { class: 'railWorkspaceUploadChooser', type: 'file',
          'aria-label': 'Choose file for Studio workspace upload' });
        chooser.onchange = () => {
          const file = Array.from(chooser.files || [])[0];
          if (file) stageUpload(file);
        };
        workspaceBrowser.appendChild(chooser);
        if (workspaceUpload) {
          const item = workspaceUpload;
          if (item.file) workspaceBrowser.appendChild(h('span', { class: 'railWorkspaceUploadName' },
            `Staged: ${item.name}`));
          const upload = h('button', { class: 'railWorkspaceUploadSubmit', type: 'button' }, 'Upload file');
          upload.disabled = !item.file || item.busy;
          upload.onclick = sendUpload;
          const cancel = h('button', { class: 'railWorkspaceUploadCancel', type: 'button' }, 'Cancel');
          cancel.disabled = item.busy;
          cancel.onclick = cancelUpload;
          workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceUploadActions' }, upload, cancel));
          if (item.error) workspaceBrowser.appendChild(h('div', {
            class: 'railWorkspaceSaveStatus', 'aria-live': 'polite',
          }, item.error));
        }
      }
      if (workspaceState.kind === 'files' && api.workbenchWriteFileAvailable?.()) {
        const newName = h('input', { class: 'railWorkspaceNewName', type: 'text',
          'aria-label': 'New workspace filename', placeholder: 'new-file.txt' });
        const create = h('button', { class: 'railWorkspaceCreate', type: 'button' }, 'New file');
        create.onclick = () => {
          const name = String(newName.value || '').trim();
          if (!validName(name)) {
            workspaceState = { ...workspaceState, error: 'Enter a valid single filename' };
            renderData(latestData);
          } else beginWorkspaceEdit({ name, content: '', create: true });
        };
        workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceNewRow' }, newName, create));
        if (workspaceState.error) workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceSaveStatus', 'aria-live': 'polite' }, workspaceState.error));
      }
      if (workspaceState.kind === 'files') {
        const filterInput = h('input', { class: 'railWorkspaceFilter', type: 'search',
          'aria-label': 'Filter current folder', placeholder: 'Filter this folder…' });
        filterInput.value = workspaceFilter;
        const filterCount = h('span', { class: 'railWorkspaceFilterCount', 'aria-live': 'polite' }, '');
        const filterEmpty = h('div', { class: 'emptyState railWorkspaceFilterEmpty' }, 'No matching files in this folder');
        workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceFilterRow' }, filterInput, filterCount));
        if (!workspaceState.files.length) workspaceBrowser.appendChild(h('div', { class: 'emptyState' }, 'Empty workspace directory'));
        const orderedRows = workspaceState.files.slice().sort((a, b) =>
          Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        const entries = [];
        for (const row of orderedRows) {
          const button = h('button', { class: row.isDir ? 'railWorkspaceDir' : 'railWorkspaceFile', type: 'button' },
            `${row.isDir ? '📁 ' : '📄 '}${row.name}`);
          button.onclick = () => row.isDir ? changeWorkspacePath(workspacePath ? `${workspacePath}/${row.name}` : row.name)
            : openWorkspaceFile(row.name);
          entries.push({ name: row.name.toLocaleLowerCase(), button });
          workspaceBrowser.appendChild(button);
        }
        const applyFilter = () => {
          const query = workspaceFilter.trim().toLocaleLowerCase();
          let matching = 0;
          for (const entry of entries) {
            const visible = !query || entry.name.includes(query);
            entry.button.style.display = visible ? '' : 'none';
            if (visible) matching += 1;
          }
          filterCount.textContent = `${matching} / ${entries.length} visible`;
          filterEmpty.style.display = entries.length > 0 && matching === 0 ? '' : 'none';
        };
        filterInput.oninput = () => {
          workspaceFilter = String(filterInput.value || '');
          applyFilter();
        };
        filterInput.onkeydown = (event) => {
          if (event?.key !== 'Escape') return;
          event.preventDefault?.();
          filterInput.value = '';
          workspaceFilter = '';
          applyFilter();
        };
        workspaceBrowser.appendChild(filterEmpty);
        applyFilter();
      } else if (workspaceState.kind === 'search') {
        workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceSearchCaption' },
          `${workspaceState.results.length} results for ${workspaceState.query}`));
        if (!workspaceState.results.length) workspaceBrowser.appendChild(h('div', { class: 'emptyState' }, 'No matching workspace files'));
        for (const row of workspaceState.results) {
          const button = h('button', { class: 'railWorkspaceSearchResult', type: 'button' },
            `${row.isDir ? '📁 ' : '📄 '}${row.relativePath}`);
          button.onclick = () => {
            workspaceQuery = '';
            if (row.isDir) changeWorkspacePath(row.relativePath);
            else {
              workspaceVersion += 1;
              workspacePath = row.relativePath.split('/').slice(0, -1).join('/');
              workspaceFilter = '';
              openWorkspaceFile(row.name);
            }
          };
          workspaceBrowser.appendChild(button);
        }
      } else if (workspaceState.kind === 'preview') {
        const backToList = h('button', { class: 'railWorkspaceList', type: 'button' }, 'Back to listing');
        backToList.onclick = loadWorkspace;
        workspaceBrowser.appendChild(backToList);
        workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceName' }, workspaceState.name));
        if (workspaceState.saved) workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceSaveStatus', 'aria-live': 'polite' }, 'File saved to Studio'));
        if (!workspaceMutation && workspaceState.fileVersion) {
          const actions = h('div', { class: 'railWorkspaceFileActions' });
          for (const [action, label, available] of [
            ['rename', 'Rename', api.workbenchRenameFileAvailable?.()],
            ['move', 'Move', api.workbenchMoveFileAvailable?.()],
            ['safeDelete', 'Safe delete', api.workbenchDeleteFileAvailable?.()],
          ]) {
            if (!available) continue;
            const button = h('button', { class: 'railWorkspaceMutationStart', type: 'button' }, label);
            button.onclick = () => startWorkspaceMutation(action);
            actions.appendChild(button);
          }
          workspaceBrowser.appendChild(actions);
        }
        if (workspaceMutation) {
          const mutation = workspaceMutation;
          const controls = h('div', { class: 'railWorkspaceMutationPanel' });
          controls.appendChild(h('div', { class: 'railWorkspaceName' },
            mutation.action === 'safeDelete' ? `Move ${mutation.name} to trash?` : `${mutation.action} ${mutation.name}`));
          if (mutation.action !== 'safeDelete') {
            const field = h('input', { class: 'railWorkspaceMutationInput', type: 'text',
              'aria-label': mutation.action === 'rename' ? 'New filename' : 'Destination subdirectory' });
            field.value = mutation.value;
            field.disabled = mutation.busy;
            field.oninput = () => { mutation.value = String(field.value || ''); };
            controls.appendChild(field);
          }
          const apply = h('button', { class: 'railWorkspaceMutationApply', type: 'button' },
            mutation.action === 'safeDelete' && mutation.confirm ? 'Confirm safe delete' :
              mutation.action === 'rename' ? 'Apply rename' : mutation.action === 'move' ? 'Move file' : 'Safe delete');
          apply.disabled = mutation.busy;
          apply.onclick = applyWorkspaceMutation;
          const cancel = h('button', { class: 'railWorkspaceMutationCancel', type: 'button' }, 'Cancel');
          cancel.disabled = mutation.busy;
          cancel.onclick = cancelWorkspaceMutation;
          controls.appendChild(h('div', { class: 'railWorkspaceEditorActions' }, apply, cancel));
          if (mutation.error) controls.appendChild(h('div', { class: 'railWorkspaceSaveStatus', 'aria-live': 'polite' }, mutation.error));
          workspaceBrowser.appendChild(controls);
        }
        if (api.workbenchWriteFileAvailable?.() && workspaceState.fileVersion && workspaceState.content.length <= 256000) {
          const editButton = h('button', { class: 'railWorkspaceEditButton', type: 'button' }, 'Edit text');
          editButton.onclick = () => beginWorkspaceEdit(workspaceState);
          workspaceBrowser.appendChild(editButton);
        }
        workspaceBrowser.appendChild(h('pre', { class: 'railWorkspacePreview' },
          workspaceState.content.slice(0, 16000) + (workspaceState.content.length > 16000 ? '\n… preview truncated' : '')));
      } else if (workspaceState.kind === 'edit' && workspaceEdit) {
        const edit = workspaceEdit;
        const editor = h('textarea', { class: 'railWorkspaceEditor', 'aria-label': 'Edit workspace text file',
          maxlength: '256000' });
        editor.value = edit.content;
        editor.disabled = edit.saving;
        editor.oninput = () => { edit.content = String(editor.value || ''); };
        const save = h('button', { class: 'railWorkspaceSave', type: 'button' }, edit.create ? 'Create file' : 'Save file');
        const discard = h('button', { class: 'railWorkspaceDiscard', type: 'button' }, 'Discard');
        save.disabled = discard.disabled = edit.saving;
        save.onclick = saveWorkspaceEdit;
        discard.onclick = discardWorkspaceEdit;
        workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceName' }, edit.name));
        workspaceBrowser.appendChild(editor);
        workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceEditorActions' }, save, discard));
        if (edit.error) workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceSaveStatus', 'aria-live': 'polite' }, edit.error));
      } else {
        workspaceBrowser.appendChild(h('div', { class: 'emptyState railWorkspaceStatus', 'aria-live': 'polite' },
          workspaceState.text || 'Choose a workspace directory'));
      }
    };

    const isCurrentHistory = (version, sessionId) => !disposed
      && state.tab === 'session-files' && state.sessionId === sessionId
      && historyVersion === version;
    const setHistory = (view, version, sessionId) => {
      if (!isCurrentHistory(version, sessionId)) return;
      historyView = view;
      renderData(latestData);
    };
    const requestHistory = async (path) => {
      const response = await adapter.http('GET', path);
      if (!response || response.ok === false || response.error) {
        throw new Error(response?.error || 'Session file history is unavailable');
      }
      return response;
    };
    const loadHistory = async () => {
      if (restoreIntent?.busy) return;
      restoreIntent = null;
      const sessionId = state.sessionId;
      const version = ++historyVersion;
      if (!sessionId) {
        setHistory({ kind: 'empty', text: 'Open a session to view its tracked file history' }, version, sessionId);
        return;
      }
      if (!api.fileHistoryListFilesAvailable?.()) {
        setHistory({ kind: 'unavailable', text: 'This Studio host does not support native file history' }, version, sessionId);
        return;
      }
      setHistory({ kind: 'loading', text: 'Loading tracked file history…' }, version, sessionId);
      try {
        const response = await requestHistory(`/api/file-history/files?agentId=${encodeURIComponent(sessionId)}`);
        if (!Array.isArray(response.files) || response.files.some((row) =>
          !row || typeof row.relPath !== 'string' || !row.relPath.trim())) {
          throw new Error('Invalid file history list from Studio');
        }
        setHistory({ kind: 'files', files: response.files }, version, sessionId);
      } catch (error) {
        setHistory({ kind: 'error', text: error?.message || 'File history loading failed' }, version, sessionId);
      }
    };
    const openVersions = async (relPath) => {
      if (restoreIntent?.busy) return;
      restoreIntent = null;
      const sessionId = state.sessionId;
      const version = ++historyVersion;
      if (!api.fileHistoryListVersionsAvailable?.()) {
        setHistory({ kind: 'unavailable', text: 'History versions are not supported by this Studio host' }, version, sessionId);
        return;
      }
      setHistory({ kind: 'loading', text: `Loading versions for ${relPath}…` }, version, sessionId);
      try {
        const response = await requestHistory(`/api/file-history/versions?agentId=${encodeURIComponent(sessionId)}&relPath=${encodeURIComponent(relPath)}`);
        if (!Array.isArray(response.versions) || response.versions.some((row) =>
          !row || !Number.isSafeInteger(row.id) || row.id < 0)) {
          throw new Error('Invalid file history versions from Studio');
        }
        setHistory({ kind: 'versions', relPath, versions: response.versions }, version, sessionId);
      } catch (error) {
        setHistory({ kind: 'error', text: error?.message || 'History versions loading failed' }, version, sessionId);
      }
    };
    const openSnapshot = async (relPath, snapshotId) => {
      if (restoreIntent?.busy) return;
      restoreIntent = null;
      const sessionId = state.sessionId;
      const version = ++historyVersion;
      if (!api.fileHistoryGetSnapshotAvailable?.()) {
        setHistory({ kind: 'unavailable', text: 'Snapshot reading is unsupported by this Studio host' }, version, sessionId);
        return;
      }
      setHistory({ kind: 'loading', text: 'Loading historical snapshot…' }, version, sessionId);
      try {
        const response = await requestHistory(`/api/file-history/snapshot?agentId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(snapshotId)}`);
        if (response.relPath !== relPath || typeof response.content !== 'string') {
          throw new Error('Invalid or mismatched snapshot response');
        }
        setHistory({ kind: 'snapshot', relPath, snapshotId, content: response.content }, version, sessionId);
      } catch (error) {
        setHistory({ kind: 'error', text: error?.message || 'Snapshot reading failed' }, version, sessionId);
      }
    };
    const restoreSnapshot = async () => {
      const snapshot = historyView;
      if (snapshot.kind !== 'snapshot' || !state.sessionId
        || !api.fileHistoryRestoreAvailable?.() || !Number.isSafeInteger(snapshot.snapshotId)) return;
      if (!restoreIntent || !restoreIntent.confirmed || restoreIntent.snapshotId !== snapshot.snapshotId
        || restoreIntent.sessionId !== state.sessionId || restoreIntent.relPath !== snapshot.relPath) {
        restoreIntent = { snapshotId: snapshot.snapshotId, relPath: snapshot.relPath,
          sessionId: state.sessionId, confirmed: true, busy: false,
          error: 'Confirm restoring this historical file version to the current workspace' };
        renderData(latestData);
        return;
      }
      const intent = restoreIntent;
      if (intent.busy) return;
      const version = historyVersion;
      intent.busy = true;
      intent.error = 'Restoring historical file through Studio…';
      renderData(latestData);
      try {
        const response = await adapter.http('POST', '/api/file-history/restore', {
          agentId: intent.sessionId, snapshotId: intent.snapshotId,
        });
        if (response?.ok !== true || response.relPath !== intent.relPath
          || (response.agentId != null && response.agentId !== intent.sessionId)) {
          throw new Error(response?.error || 'Native file history restore was not acknowledged');
        }
        if (disposed || restoreIntent !== intent || historyVersion !== version
          || state.sessionId !== intent.sessionId) return;
        restoreIntent = null;
        historyView = { ...snapshot, restored: true };
        renderData(latestData);
      } catch (error) {
        if (disposed || restoreIntent !== intent || historyVersion !== version) return;
        intent.error = error?.message || 'Native file restore failed';
        intent.confirmed = false;
      } finally {
        intent.busy = false;
        if (!disposed && restoreIntent === intent && historyVersion === version) renderData(latestData);
      }
    };
    const renderHistory = () => {
      const refresh = h('button', { class: 'railHistoryRefresh', type: 'button' }, 'Refresh');
      refresh.onclick = loadHistory;
      fileList.appendChild(h('div', { class: 'railHistoryHeader' },
        h('span', {}, 'Tracked file history'), refresh));
      if (historyView.kind === 'files') {
        if (!historyView.files.length) fileList.appendChild(h('div', { class: 'emptyState' }, 'No tracked files for this session'));
        for (const row of historyView.files) {
          const button = h('button', { class: 'railHistoryFile', type: 'button' },
            `${row.relPath} (${Number.isSafeInteger(row.snapshotCount) ? row.snapshotCount : 0} versions)`);
          button.onclick = () => openVersions(row.relPath);
          fileList.appendChild(button);
        }
      } else if (historyView.kind === 'versions') {
        const back = h('button', { class: 'railHistoryBack', type: 'button' }, 'Back to files');
        back.onclick = loadHistory;
        fileList.appendChild(back);
        fileList.appendChild(h('div', { class: 'railHistoryPath' }, historyView.relPath));
        if (!historyView.versions.length) fileList.appendChild(h('div', { class: 'emptyState' }, 'No snapshots available'));
        for (const row of historyView.versions) {
          const button = h('button', { class: 'railHistoryVersion', type: 'button' },
            `Snapshot ${row.id}${row.origin ? ` · ${row.origin}` : ''}`);
          button.onclick = () => openSnapshot(historyView.relPath, row.id);
          fileList.appendChild(button);
        }
      } else if (historyView.kind === 'snapshot') {
        const back = h('button', { class: 'railHistoryBack', type: 'button' }, 'Back to files');
        back.onclick = loadHistory;
        fileList.appendChild(back);
        fileList.appendChild(h('div', { class: 'railHistoryPath' }, historyView.relPath));
        fileList.appendChild(h('pre', { class: 'railHistorySnapshot' },
          historyView.content.slice(0, 16000) + (historyView.content.length > 16000 ? '\n… preview truncated' : '')));
        if (historyView.restored) fileList.appendChild(h('div', { class: 'railHistoryRestoreStatus', 'aria-live': 'polite' },
          'Studio acknowledged the historical file restoration'));
        if (api.fileHistoryRestoreAvailable?.() && !historyView.restored) {
          const restore = h('button', { class: 'railHistoryRestoreButton', type: 'button' },
            restoreIntent?.confirmed ? 'Confirm restore' : 'Restore this snapshot');
          restore.disabled = !!restoreIntent?.busy;
          restore.onclick = restoreSnapshot;
          fileList.appendChild(restore);
          if (restoreIntent) {
            const cancel = h('button', { class: 'railHistoryRestoreCancel', type: 'button' }, 'Cancel');
            cancel.disabled = restoreIntent.busy;
            cancel.onclick = () => { restoreIntent = null; renderData(latestData); };
            fileList.appendChild(cancel);
            if (restoreIntent.error) fileList.appendChild(h('div', {
              class: 'railHistoryRestoreStatus', 'aria-live': 'polite',
            }, restoreIntent.error));
          }
        }
      } else {
        fileList.appendChild(h('div', { class: 'emptyState railHistoryStatus', 'aria-live': 'polite' },
          historyView.text || 'No history loaded'));
      }
    };
    const setSession = (sessionId) => {
      const nextId = typeof sessionId === 'string' && sessionId ? sessionId : null;
      if (state.sessionId === nextId) return;
      state.sessionId = nextId;
      hydrateJian();
      restoreIntent = null;
      historyVersion += 1;
      historyView = { kind: 'idle' };
      if (state.tab === 'session-files') loadHistory();
      else { loadWorkspace(); loadCheckpoints(); }
    };

    function update(data) {
      latestData = data || latestData;
      // Runtime polls must not replace a focused native textarea mid-edit.
      if (state.tab === 'workspace' && (workspaceState.kind === 'edit' || workspaceMutation || workspaceUpload)) return;
      renderData(latestData);
    }

    loadWorkspace();
    loadCheckpoints();
    const unsubscribeSlots = slots.subscribe((slotState) => {
      slotSummary.textContent = `Slots ${slotState.mounted}/${slotState.total} · visible ${slotState.visible} · contributions ${slotState.contributions}`;
      slotSummary.setAttribute('data-contributions', String(slotState.contributions));
    });

    const openJian = () => {
      if (disposed) return;
      if (!state.jianOpen) jianToggle.onclick();
      editor.focus?.();
    };
    return {
      root,
      update, setSession, openJian,
      dispose: () => { disposed = true; historyVersion += 1; workspaceVersion += 1; checkpointVersion += 1; if (typeof unsubscribeSlots === 'function') unsubscribeSlots(); },
    };
  }

  return { render };
})();
