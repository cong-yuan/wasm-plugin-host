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
    let disposed = false;
    let workspaceVersion = 0;
    let workspacePath = '';
    let workspaceQuery = '';
    let workspaceState = { kind: 'idle' };
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
    const itemsSlot = h('div', { class: 'rail-items-slot' });
    const content = h('div', { class: 'content', role: 'tabpanel' }, runtimeSummary, slotSummary, workspaceBrowser, fileList, itemsSlot);
    slots.mount('openhanako.rail.items', itemsSlot);

    // <section className={styles.jianDrawer} data-open=…>
    const editor = h('textarea', {
      class: 'jian-editor',
      'data-desk-editor': '',
      placeholder: t('desk.jianPlaceholder'),
    });
    const drawer = h('section', {
      class: 'jianDrawer', 'data-open': 'false', role: 'region', 'aria-label': t('desk.jianLabel'),
    },
      h('div', { class: 'jianHeader' }, h('span', { class: 'jianTitle' }, t('desk.jianLabel'))),
      h('div', { class: 'jianBody' }, editor));

    // function JianFloatingToggle()
    const jianToggle = h('button', {
      class: 'jianToggle', type: 'button',
      'aria-label': t('rightWorkspace.jian.expand'), 'aria-expanded': 'false',
    }, svg(CHEVRON_CLOSED));
    jianToggle.onclick = () => {
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

    function selectTab(id) {
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
      else loadWorkspace();
    }

    function renderData(data) {
      const tools = (data && data.tools) || [];
      const plugins = (data && data.plugins) || [];
      const runtime = (data && data.runtime) || { mode: 'unknown', sessions: [] };
      clear(runtimeSummary);
      clear(slotSummary);
      clear(fileList);
      workspaceBrowser.style.display = state.tab === 'workspace' ? '' : 'none';
      if (state.tab === 'workspace') renderWorkspace();

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
    // This UI never passes absolute filesystem paths or performs mutations.
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
        setWorkspaceState({ kind: 'preview', name, content: response.__httpBody }, version, subdir);
      } catch (err) {
        setWorkspaceState({ kind: 'error', text: err?.message || 'File preview failed' }, version, subdir);
      }
    };
    const validRelativePath = (path) => typeof path === 'string' && path.length > 0
      && path.split('/').every(validName);
    const searchWorkspace = async () => {
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
      workspaceVersion += 1;
      workspacePath = subdir;
      loadWorkspace();
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
      workspaceBrowser.appendChild(h('div', { class: 'railWorkspaceSearchRow' }, searchInput, searchButton));
      if (workspaceState.kind === 'files') {
        if (!workspaceState.files.length) workspaceBrowser.appendChild(h('div', { class: 'emptyState' }, 'Empty workspace directory'));
        for (const row of workspaceState.files) {
          const button = h('button', { class: row.isDir ? 'railWorkspaceDir' : 'railWorkspaceFile', type: 'button' },
            `${row.isDir ? '📁 ' : '📄 '}${row.name}`);
          button.onclick = () => row.isDir ? changeWorkspacePath(workspacePath ? `${workspacePath}/${row.name}` : row.name)
            : openWorkspaceFile(row.name);
          workspaceBrowser.appendChild(button);
        }
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
        workspaceBrowser.appendChild(h('pre', { class: 'railWorkspacePreview' },
          workspaceState.content.slice(0, 16000) + (workspaceState.content.length > 16000 ? '\n… preview truncated' : '')));
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
        setHistory({ kind: 'snapshot', relPath, content: response.content }, version, sessionId);
      } catch (error) {
        setHistory({ kind: 'error', text: error?.message || 'Snapshot reading failed' }, version, sessionId);
      }
    };
    const renderHistory = () => {
      const refresh = h('button', { class: 'railHistoryRefresh', type: 'button' }, 'Refresh');
      refresh.onclick = loadHistory;
      fileList.appendChild(h('div', { class: 'railHistoryHeader' },
        h('span', {}, 'Tracked file history (read-only)'), refresh));
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
      } else {
        fileList.appendChild(h('div', { class: 'emptyState railHistoryStatus', 'aria-live': 'polite' },
          historyView.text || 'No history loaded'));
      }
    };
    const setSession = (sessionId) => {
      const nextId = typeof sessionId === 'string' && sessionId ? sessionId : null;
      if (state.sessionId === nextId) return;
      state.sessionId = nextId;
      historyVersion += 1;
      historyView = { kind: 'idle' };
      if (state.tab === 'session-files') loadHistory();
      else loadWorkspace();
    };

    function update(data) {
      latestData = data || latestData;
      renderData(latestData);
    }

    loadWorkspace();
    const unsubscribeSlots = slots.subscribe((slotState) => {
      slotSummary.textContent = `Slots ${slotState.mounted}/${slotState.total} · visible ${slotState.visible} · contributions ${slotState.contributions}`;
      slotSummary.setAttribute('data-contributions', String(slotState.contributions));
    });

    return {
      root,
      update, setSession,
      dispose: () => { disposed = true; historyVersion += 1; workspaceVersion += 1; if (typeof unsubscribeSlots === 'function') unsubscribeSlots(); },
    };
  }

  return { render };
})();
