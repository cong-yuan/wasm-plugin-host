// Ported from openhanako (Apache-2.0): ChatPage.tsx, WelcomeScreen.tsx,
// InputArea.tsx, InputControlBar.tsx, SendButton.tsx, PlanModeButton.tsx.
// Markup, class names and SVG geometry are copied verbatim from upstream.
return (function () {
  const { h, svg, clear } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const api = studio.require('lib/api');
  const adapter = studio.require('lib/hana-adapter');
  const avatar = studio.require('lib/avatar');
  const { t } = studio.require('lib/i18n');

  // Upstream store defaults (agent-slice.ts): agentName 'Hanako', userName 'User'.
  const AGENT_NAME = 'Hanako';
  const USER_NAME = 'User';

  // WelcomeScreen.tsx — folder picker icon + swap icon.
  const FOLDER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>`;
  const FOLDER_SWAP = `<svg class="folderSwapIcon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="17 1 21 5 17 9"></polyline>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
    <polyline points="7 23 3 19 7 15"></polyline>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
  </svg>`;
  const MEMORY = `<svg class="memoryToggleIcon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2 L22 12 L12 22 L2 12 Z" />
  </svg>`;
  // InputControlBar.tsx — attach (plus) and slash (star) buttons.
  const PLUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>`;
  const SLASH = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2L14 10L22 12L14 14L12 22L10 14L2 12L10 10Z" />
  </svg>`;
  // PlanModeButton.tsx — default (accept-edits) mode glyph.
  const PLAN = `<svg data-permission-mode="default" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>`;
  // SendButton.tsx — enter-key glyph inside the send label.
  const SEND_ENTER = `<svg class="send-enter-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 01-4 4H4" />
  </svg>`;
  const CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>`;

  function render(options) {
    const state = { id: null, turns: [], busy: false, cancelling: false, opening: false, memory: true, epoch: 0, switchingModel: false };
    // Compact mode follows deepseek-harness's turn/process separation: the
    // final answer stays visible; the intermediate steps disclose on demand.
    const DISPLAY_KEY = 'openhanako.conversation.displayMode.v1';
    let displayMode = 'compact';
    try {if (localStorage.getItem(DISPLAY_KEY) === 'normal') displayMode = 'normal';} catch (_) {}
    const expandedProcessBySession = new Map();
    const markUnsupported = (button, reason) => {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('data-unsupported', 'true');
      button.title = reason;
    };

    // ── WelcomeScreen.tsx ──
    const heroSlot = h('div', { class: 'hana-slot' });
    slots.mount('openhanako.conversation.hero', heroSlot);

    const folderBtn = h('button', { class: 'folderSelectBtn', type: 'button' },
      svg(FOLDER), h('span', {}, 'Authorized folders'), svg(FOLDER_SWAP));
    folderBtn.title = 'Manage authorized folders for this session';
    const memoryBtn = h('button', { class: 'memoryToggleBtn memoryToggleBtnDisabled', type: 'button' },
      svg(MEMORY), h('span', {}, t('welcome.memoryDisabled')));
    markUnsupported(memoryBtn,
      'Memory controls are unavailable until the standalone Studio bridge can pass memoryEnabled to sessions.');

    const welcomeInner = h('div', { class: 'welcome' },
      h('img', { class: 'welcomeAvatar', src: avatar, alt: AGENT_NAME, draggable: 'false' }),
      h('p', { class: 'welcomeText' }, t('welcome.messages', { name: AGENT_NAME })),
      h('div', { class: 'folderSelectWrap' }, folderBtn),
      memoryBtn,
      heroSlot);
    // ChatPage.tsx: <div className={`welcome${visible ? '' : ' hidden'}`} id="welcome">
    const welcome = h('div', { class: 'welcome', id: 'welcome' }, welcomeInner);

    // ── ChatArea ──
    const viewModeButton = h('button', {class:'conversationViewMode',type:'button',
      'aria-label':'Toggle conversation detail display'}, '简洁视图 · 展开过程');
    const viewToolbar = h('div', {class:'conversationViewToolbar'}, viewModeButton);
    const stream = h('div', { class: 'message-stream' });
    slots.mount('openhanako.conversation.stream', stream);
    const chat = h('div', { class: 'chat-area' }, welcome, viewToolbar, stream);
    const conversationStatus = h('div', {
      class: 'conversation-status',
      'aria-live': 'polite',
    }, '');

    // ── InputArea.tsx ──
    const dock = h('div', { class: 'input-dock hana-slot' });
    slots.mount('openhanako.conversation.input.dock', dock);

    const input = h('div', {
      class: 'input-box', contenteditable: 'true', role: 'textbox',
      'aria-multiline': 'true', 'aria-label': t('input.placeholder'),
      'data-placeholder': t('input.placeholder'),
    });

    // Compose drafts stay in memory (not localStorage): unsent content may be sensitive.
    const draftBySession = new Map();
    const draftMaxLength = 50000;
    const draftKey = (id) => id || '__new_chat__';
    const draftStatus = h('span', { class: 'conversationDraftStatus', 'aria-live': 'polite' }, '');
    const setDraft = (text, id = state.id) => {
      const value = String(text || '').slice(0, draftMaxLength);
      if (value) draftBySession.set(draftKey(id), value);
      else draftBySession.delete(draftKey(id));
      draftStatus.textContent = value ? `Draft retained in this app · ${value.length} characters` : '';
    };
    const captureDraft = () => {
      let value = String(input.textContent || '');
      if (value.length > draftMaxLength) {
        value = value.slice(0, draftMaxLength);
        input.textContent = value;
      }
      setDraft(value);
    };
    const restoreDraft = (id = state.id) => {
      const value = draftBySession.get(draftKey(id)) || '';
      input.textContent = value;
      draftStatus.textContent = value ? `Draft retained in this app · ${value.length} characters` : '';
    };
    const attach = h('button', { class: 'attach-btn', type: 'button', title: t('input.attachFiles') }, svg(PLUS));
    const scopeBtn = h('button', { class: 'attach-btn sessionFolderScopeBtn', type: 'button', title: 'Session authorized folders', 'aria-expanded': 'false' }, svg(FOLDER));
    const slash = h('button', { class: 'attach-btn nativeSlashButton', type: 'button', title: 'Local slash commands' }, svg(SLASH));
    const plan = h('button', { class: 'plan-mode-btn plan-mode-default', type: 'button' }, svg(PLAN));
    const uploadAvailable = typeof api.uploadBlobAvailable === 'function' && api.uploadBlobAvailable();
    if (!uploadAvailable) markUnsupported(attach, 'Studio does not support native file uploads in this window.');
    const scopeAvailable = typeof api.sessionFolderScopeAvailable === 'function' && api.sessionFolderScopeAvailable();
    if (!scopeAvailable) {
      markUnsupported(scopeBtn, 'Studio does not expose authorized folder controls in this window.');
      markUnsupported(folderBtn, 'Studio does not expose authorized folder controls in this window.');
    }
    markUnsupported(plan, 'Permission modes are unavailable until the Studio bridge can enforce them.');
    const attachmentChooser = h('input', {
      class: 'nativeAttachmentChooser', type: 'file', multiple: 'multiple',
      'aria-label': 'Choose files to attach',
    });
    attachmentChooser.style.display = 'none';
    const attachmentList = h('div', { class: 'nativeAttachmentList', 'aria-live': 'polite' });
    let stagedFiles = [];
    const uploadedRefs = new WeakMap();
    const maxAttachmentBytes = 10 * 1024 * 1024;
    const maxAttachmentCount = 5;
    const renderAttachments = (message = '') => {
      clear(attachmentList);
      for (const item of stagedFiles) {
        const remove = h('button', {
          class: 'nativeAttachmentRemove', type: 'button',
          'aria-label': `Remove attachment ${item.name}`,
        }, '×');
        remove.disabled = state.busy || state.opening;
        remove.onclick = () => {
          if (state.busy || state.opening) return;
          stagedFiles = stagedFiles.filter((entry) => entry !== item);
          renderAttachments();
        };
        attachmentList.appendChild(h('span', { class: 'nativeAttachmentChip' },
          h('span', {}, item.name), remove));
      }
      if (message) attachmentList.appendChild(h('span', { class: 'nativeAttachmentError' }, message));
    };
    attachmentChooser.onchange = () => {
      if (!uploadAvailable || state.busy || state.opening) return;
      const incoming = Array.from(attachmentChooser.files || []);
      attachmentChooser.value = '';
      const error = incoming.some((file) => !file || typeof file.arrayBuffer !== 'function'
        || !Number.isFinite(file.size) || file.size <= 0 || file.size > maxAttachmentBytes)
        ? 'Each attachment must be a nonempty file of 10 MiB or less'
        : stagedFiles.length + incoming.length > maxAttachmentCount
          ? 'Choose at most five attachments per message' : '';
      if (error) return renderAttachments(error);
      stagedFiles = [...stagedFiles, ...incoming];
      renderAttachments();
    };
    attach.onclick = () => {
      if (!uploadAvailable || state.busy || state.opening) return;
      attachmentChooser.click?.();
    };
    const base64FromFile = async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.length || bytes.length > maxAttachmentBytes) throw new Error('Attachment exceeds upload limit');
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      }
      return btoa(binary);
    };
    const trailing = h('span', { class: 'input-trailing-slot hana-slot' });
    slots.mount('openhanako.conversation.input.right', trailing);

    const canCompact = !!api.freshCompactSessionAvailable?.();
    const canCompleteTodos = !!api.completeSessionTodosAvailable?.();
    const canReadSummary = !!api.sessionSummaryAvailable?.();
    const hasSessionActions = canCompact || canCompleteTodos || canReadSummary;
    const sessionToolsButton = h('button', {
      class: 'sessionToolsButton', type: 'button',
      title: 'Session context, summary and todos', 'aria-expanded': 'false',
    }, 'Session');
    if (!hasSessionActions) markUnsupported(sessionToolsButton,
      'This Studio host does not expose native session actions.');
    const sessionToolsStatus = h('span', { class: 'sessionToolsStatus', 'aria-live': 'polite' }, '');
    const sessionSummaryContent = h('div', { class: 'sessionSummaryContent' });
    const sessionToolsClose = h('button', { class: 'sessionToolsClose', type: 'button' }, 'Close');
    const sessionToolsSummary = h('button', { class: 'sessionToolsSummary', type: 'button' }, 'Read summary');
    const sessionToolsCompact = h('button', { class: 'sessionToolsCompact', type: 'button' }, 'Compact context');
    const sessionToolsTodos = h('button', { class: 'sessionToolsTodos', type: 'button' }, 'Complete TODOs');
    sessionToolsSummary.disabled = !canReadSummary;
    sessionToolsCompact.disabled = !canCompact;
    sessionToolsTodos.disabled = !canCompleteTodos;
    const sessionToolsPanel = h('section', {
      class: 'sessionToolsPanel', 'aria-label': 'Session tools',
    }, h('div', { class: 'sessionToolsHeading' }, 'Session actions', sessionToolsClose),
    h('div', { class: 'sessionToolsControls' },
      sessionToolsSummary, sessionToolsCompact, sessionToolsTodos),
    sessionSummaryContent, sessionToolsStatus);
    sessionToolsPanel.style.display = 'none';
    let toolsPending = false;
    const pendingNativeActions = new Set();
    let toolsGeneration = 0;
    let toolsConfirm = null;
    const toolsIsCurrent = (id, epoch, version) =>
      state.id === id && state.epoch === epoch && toolsGeneration === version;
    const toolsUpdateControls = () => {
      const locked = toolsPending || pendingNativeActions.has(state.id) || state.busy || state.opening;
      sessionToolsSummary.disabled = locked || !canReadSummary;
      sessionToolsCompact.disabled = locked || !canCompact;
      sessionToolsTodos.disabled = locked || !canCompleteTodos;
      sessionToolsCompact.textContent = toolsConfirm === 'compact' ? 'Confirm compact' : 'Compact context';
      sessionToolsTodos.textContent = toolsConfirm === 'todos' ? 'Confirm complete' : 'Complete TODOs';
    };
    const toolsReset = () => {
      toolsGeneration += 1;
      toolsPending = false;
      toolsConfirm = null;
      sessionToolsPanel.style.display = 'none';
      sessionToolsButton.setAttribute('aria-expanded', 'false');
      sessionToolsStatus.textContent = '';
      clear(sessionSummaryContent);
      toolsUpdateControls();
    };
    const toolsExecute = async (kind) => {
      if (!state.id || state.busy || state.opening || toolsPending || pendingNativeActions.has(state.id)
        || sessionToolsPanel.style.display === 'none') return;
      if ((kind === 'summary' && !canReadSummary) || (kind === 'compact' && !canCompact)
        || (kind === 'todos' && !canCompleteTodos)) return;
      if (kind !== 'summary' && toolsConfirm !== kind) {
        toolsConfirm = kind;
        sessionToolsStatus.textContent = kind === 'compact'
          ? 'Confirm native context compaction; transcript history is retained'
          : 'Confirm marking every current TODO completed';
        toolsUpdateControls();
        return;
      }
      const id = state.id;
      const epoch = state.epoch;
      const version = ++toolsGeneration;
      toolsConfirm = null;
      toolsPending = true;
      pendingNativeActions.add(id);
      toolsUpdateControls();
      sessionToolsStatus.textContent = kind === 'summary' ? 'Loading session summary…'
        : kind === 'compact' ? 'Compacting session context…' : 'Completing session TODOs…';
      try {
        const result = kind === 'summary'
          ? await adapter.http('GET', `/api/sessions/summary?sessionId=${encodeURIComponent(id)}`)
          : await adapter.http('POST', kind === 'compact'
            ? '/api/sessions/fresh-compact' : '/api/sessions/todos/complete', { sessionId: id });
        if (!toolsIsCurrent(id, epoch, version)) return;
        if (kind === 'summary') {
          if (!result || result.error || typeof result.hasSummary !== 'boolean'
            || (result.hasSummary && typeof result.summary !== 'string')) {
            throw new Error(result?.error || 'Invalid native session summary');
          }
          clear(sessionSummaryContent);
          sessionSummaryContent.appendChild(h('div', { class: 'sessionSummaryText' },
            result.hasSummary ? result.summary : 'No persisted session summary yet'));
          sessionToolsStatus.textContent = result.hasSummary ? 'Persisted summary loaded' : 'No summary yet';
        } else if (kind === 'compact') {
          if (!result || result.ok !== true || result.fresh !== true) {
            throw new Error(result?.error || 'Studio did not confirm compaction');
          }
          clear(sessionSummaryContent);
          sessionToolsStatus.textContent = 'Session context compacted';
        } else {
          if (!result || result.ok !== true || !Array.isArray(result.completed)
            || !Array.isArray(result.todos) || result.todos.length > 0) {
            throw new Error(result?.error || 'Studio did not confirm TODO completion');
          }
          sessionToolsStatus.textContent = `${result.completed.length} TODOs marked completed`;
        }
      } catch (err) {
        if (toolsIsCurrent(id, epoch, version)) {
          sessionToolsStatus.textContent = err?.message || 'Session action failed';
        }
      } finally {
        pendingNativeActions.delete(id);
        if (toolsIsCurrent(id, epoch, version)) toolsPending = false;
        // Closing the panel invalidates its request, not the native mutation.
        // The same session remains locked until that command settles.
        toolsUpdateControls();
      }
    };
    sessionToolsButton.onclick = () => {
      if (!hasSessionActions) return;
      if (sessionToolsPanel.style.display !== 'none') return toolsReset();
      if (!state.id || state.opening || state.busy) {
        conversationStatus.textContent = 'Open an idle session before using session actions';
        return;
      }
      sessionToolsPanel.style.display = '';
      sessionToolsButton.setAttribute('aria-expanded', 'true');
      toolsUpdateControls();
    };
    sessionToolsClose.onclick = toolsReset;
    sessionToolsSummary.onclick = () => toolsExecute('summary');
    sessionToolsCompact.onclick = () => toolsExecute('compact');
    sessionToolsTodos.onclick = () => toolsExecute('todos');

    const modelPill = h('button', { class: 'model-pill', type: 'button', 'data-open': 'false', 'aria-expanded': 'false', 'aria-haspopup': 'true' },
      h('span', { class: 'model-pill-label' }, '—'), svg(CHEVRON_DOWN));
    const modelDropdown = h('div', { class: 'model-dropdown' });
    const modelStatus = h('span', {
      class: 'model-switch-status',
      'aria-live': 'polite',
    }, '');
    const modelSelector = h('div', { class: 'model-selector' }, modelPill, modelStatus, modelDropdown);

    const send = h('button', { class: 'send-btn', type: 'button' },
      h('span', { class: 'send-label' }, svg(SEND_ENTER), h('span', {}, t('chat.send'))));

    function renderSendState() {
      clear(send);
      if (state.opening) {
        send.setAttribute('data-mode', 'opening');
        send.classList.remove('send-btn-stop');
        send.disabled = true;
        send.appendChild(h('span', { class: 'send-label' }, h('span', {}, 'Opening…')));
      } else if (state.busy) {
        send.setAttribute('data-mode', 'stop');
        send.classList.add('send-btn-stop');
        send.disabled = !!state.cancelling;
        send.appendChild(h('span', { class: 'send-label' },
          h('span', { class: 'send-stop-icon', 'aria-hidden': 'true' }),
          h('span', {}, state.cancelling ? 'Stopping…' : 'Stop')));
      } else {
        send.setAttribute('data-mode', 'send');
        send.classList.remove('send-btn-stop');
        send.disabled = false;
        send.appendChild(h('span', { class: 'send-label' },
          svg(SEND_ENTER), h('span', {}, t('chat.send'))));
      }
      attach.disabled = !uploadAvailable || state.opening || state.busy;
      slash.disabled = state.opening || state.busy;
      sessionToolsButton.disabled = !hasSessionActions || state.opening || state.busy;
      toolsUpdateControls();
      const modelDisabled = !!state.opening || !!state.busy || !!state.switchingModel;
      modelPill.disabled = modelDisabled;
      modelPill.classList.toggle('model-pill-disabled', modelDisabled);
      modelSelector.setAttribute('aria-busy', state.switchingModel ? 'true' : 'false');
    }

    const controlBar = h('div', { class: 'input-bottom-bar' },
      h('div', { class: 'input-actions' }, attach, scopeBtn, slash, plan, trailing),
      h('div', { class: 'input-controls' }, sessionToolsButton, modelSelector, send));

    const wrapper = h('div', { class: 'input-wrapper' }, input, controlBar);
    const surface = h('div', { class: 'input-surface' },
      dock, h('div', { class: 'input-stack' }, attachmentChooser, attachmentList, wrapper));
    // The native backend owns authorized-folder persistence and path validation.
    // This editor is available only when the host advertises both commands.
    const scopePath = h('input', {
      class: 'sessionFolderScopePath', type: 'text',
      placeholder: 'Absolute directory path', 'aria-label': 'Authorize directory path',
    });
    const scopeAdd = h('button', { class: 'sessionFolderScopeAdd', type: 'button' }, 'Add folder');
    const scopeRefresh = h('button', { class: 'sessionFolderScopeRefresh', type: 'button' }, 'Refresh');
    const scopeClose = h('button', { class: 'sessionFolderScopeClose', type: 'button' }, 'Close');
    const scopeList = h('div', { class: 'sessionFolderScopeList' });
    const scopeStatus = h('span', { class: 'sessionFolderScopeStatus', 'aria-live': 'polite' }, '');
    const scopePanel = h('section', { class: 'sessionFolderScopePanel', 'aria-label': 'Authorized session folders' },
      h('div', { class: 'sessionFolderScopeHeading' }, 'Authorized folders', scopeRefresh, scopeClose),
      h('div', { class: 'sessionFolderScopeEditor' }, scopePath, scopeAdd),
      scopeList, scopeStatus);
    scopePanel.style.display = 'none';
    let scopeGeneration = 0;
    let scopePending = false;
    const scopeIsCurrent = (id, epoch, version) => state.id === id
      && state.epoch === epoch && scopeGeneration === version;
    const scopeBusy = (busy) => {
      scopePending = busy;
      scopeAdd.disabled = busy;
      scopeRefresh.disabled = busy;
      scopePath.disabled = busy;
    };
    const scopeReset = () => {
      scopeGeneration += 1;
      scopeBusy(false);
      clear(scopeList);
      scopeStatus.textContent = '';
      scopePath.value = '';
      scopePanel.style.display = 'none';
      scopeBtn.setAttribute('aria-expanded', 'false');
      folderBtn.setAttribute('aria-expanded', 'false');
    };
    const scopeRender = (folders) => {
      clear(scopeList);
      if (!folders.length) {
        scopeList.appendChild(h('div', { class: 'sessionFolderScopeEmpty' }, 'No extra authorized directories'));
      }
      for (const folder of folders) {
        const remove = h('button', {
          class: 'sessionFolderScopeRemove', type: 'button',
          'aria-label': `Remove authorized folder ${folder}`,
        }, 'Remove');
        remove.onclick = () => scopeMutation('remove', folder);
        scopeList.appendChild(h('div', { class: 'sessionFolderScopeRow' },
          h('span', { class: 'sessionFolderScopeName' }, folder), remove));
      }
    };
    const scopeValidate = (result, id) => {
      if (!result || result.ok !== true
        || (result.sessionId != null && result.sessionId !== id)
        || !Array.isArray(result.authorizedFolders)
        || result.authorizedFolders.some((value) => typeof value !== 'string' || !value.trim())) {
        throw new Error(result?.error || 'Invalid authorized folders response');
      }
      return result.authorizedFolders;
    };
    const scopeLoad = async () => {
      if (scopePending || !state.id || scopePanel.style.display === 'none') return;
      const id = state.id;
      const epoch = state.epoch;
      const version = ++scopeGeneration;
      scopeBusy(true);
      scopeStatus.textContent = 'Loading folders…';
      clear(scopeList);
      try {
        const result = await adapter.http('GET', `/api/sessions/authorized-folders?sessionId=${encodeURIComponent(id)}`);
        const folders = scopeValidate(result, id);
        if (!scopeIsCurrent(id, epoch, version)) return;
        scopeRender(folders);
        scopeStatus.textContent = '';
      } catch (err) {
        if (scopeIsCurrent(id, epoch, version)) {
          clear(scopeList);
          scopeStatus.textContent = err?.message || 'Unable to load authorized folders';
        }
      } finally {
        if (scopeIsCurrent(id, epoch, version)) scopeBusy(false);
      }
    };
    const scopeMutation = async (action, folder) => {
      if (scopePending || !state.id || scopePanel.style.display === 'none') return;
      const path = String(folder || '').trim();
      if (!path || !(/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(path))) {
        scopeStatus.textContent = 'Enter an absolute directory path';
        return;
      }
      const id = state.id;
      const epoch = state.epoch;
      const version = ++scopeGeneration;
      scopeBusy(true);
      scopeStatus.textContent = action === 'add' ? 'Adding folder…' : 'Removing folder…';
      try {
        const result = await adapter.http('PATCH', '/api/sessions/authorized-folders', {
          sessionId: id, action, folder: path,
        });
        const folders = scopeValidate(result, id);
        if (!scopeIsCurrent(id, epoch, version)) return;
        if ((action === 'add' && !folders.includes(path))
          || (action === 'remove' && folders.includes(path))) {
          throw new Error('Folder update was not confirmed by Studio');
        }
        scopeRender(folders);
        if (action === 'add') scopePath.value = '';
        scopeStatus.textContent = action === 'add' ? 'Folder authorized' : 'Folder removed';
      } catch (err) {
        if (scopeIsCurrent(id, epoch, version)) {
          scopeStatus.textContent = err?.message || 'Folder update failed';
        }
      } finally {
        if (scopeIsCurrent(id, epoch, version)) scopeBusy(false);
      }
    };
    const toggleScopePanel = () => {
      if (!scopeAvailable) return;
      if (scopePanel.style.display !== 'none') {
        scopeReset();
        return;
      }
      if (!state.id || state.opening) {
        conversationStatus.textContent = 'Open or create a session before editing its authorized folders';
        return;
      }
      scopePanel.style.display = '';
      scopeBtn.setAttribute('aria-expanded', 'true');
      folderBtn.setAttribute('aria-expanded', 'true');
      scopeLoad();
    };
    scopeBtn.onclick = toggleScopePanel;
    folderBtn.onclick = toggleScopePanel;
    scopeClose.onclick = scopeReset;
    scopeRefresh.onclick = scopeLoad;
    scopeAdd.onclick = () => scopeMutation('add', scopePath.value);
    scopePath.onkeydown = (event) => {
      if (event?.key === 'Enter' && !event?.isComposing) {
        event.preventDefault?.();
        scopeAdd.onclick();
      }
    };
    // Built-in slash commands are local shortcuts to acknowledged Studio capabilities.
    const slashMenu = h('section', { class: 'nativeSlashMenu', 'aria-label': 'Local commands' });
    slashMenu.style.display = 'none';
    slash.setAttribute('aria-expanded', 'false');
    slash.setAttribute('aria-haspopup', 'true');
    const slashStatus = h('span', { class: 'nativeSlashStatus', 'aria-live': 'polite' }, '');
    const closeSlash = () => {
      slashMenu.style.display = 'none';
      slash.setAttribute('aria-expanded', 'false');
    };
    const slashCommands = [
      { name: 'help', label: 'Show local commands', enabled: () => true },
      { name: 'notes', label: 'Open session or workspace notes', enabled: () => typeof options.onOpenNotes === 'function' },
      { name: 'models', label: 'Choose model', enabled: () => !state.opening && !state.busy && !state.switchingModel },
      { name: 'folders', label: 'Authorized folders', enabled: () => scopeAvailable && !!state.id && !state.opening },
      { name: 'summary', label: 'Read session summary', enabled: () => canReadSummary && !!state.id && !state.busy && !state.opening },
      { name: 'compact', label: 'Compact session (confirm)', enabled: () => canCompact && !!state.id && !state.busy && !state.opening },
      { name: 'todos', label: 'Complete TODOs (confirm)', enabled: () => canCompleteTodos && !!state.id && !state.busy && !state.opening },
    ];
    const showSlash = () => {
      clear(slashMenu);
      for (const command of slashCommands) {
        const option = h('button', { class: 'nativeSlashOption', type: 'button' },
          `/${command.name} — ${command.label}`);
        option.disabled = !command.enabled();
        option.onclick = () => executeSlash(command.name);
        slashMenu.appendChild(option);
      }
      slashMenu.style.display = '';
      slash.setAttribute('aria-expanded', 'true');
    };
    const executeSlash = (name) => {
      const command = slashCommands.find((item) => item.name === name);
      if (!command) {
        slashStatus.textContent = `Unknown local command /${name}; use /help`;
        return false;
      }
      if (name === 'help') {
        showSlash();
        slashStatus.textContent = 'Local commands are not sent to the model';
        return true;
      }
      if (!command.enabled()) {
        slashStatus.textContent = `/${name} is unavailable in this session or Studio host`;
        return false;
      }
      closeSlash();
      slashStatus.textContent = '';
      if (name === 'notes') options.onOpenNotes();
      else if (name === 'models') modelPill.onclick();
      else if (name === 'folders') {
        if (scopePanel.style.display === 'none') toggleScopePanel();
      } else {
        if (sessionToolsPanel.style.display === 'none') sessionToolsButton.onclick();
        if (sessionToolsPanel.style.display !== 'none') {
          const control = { summary: sessionToolsSummary, compact: sessionToolsCompact, todos: sessionToolsTodos }[name];
          control?.onclick?.();
        }
      }
      return true;
    };
    slash.onclick = () => {
      if (slashMenu.style.display === 'none') showSlash();
      else closeSlash();
    };
    input.addEventListener('input', () => {
      captureDraft();
      if (slashMenu.style.display !== 'none' && !input.textContent.trim().startsWith('/')) closeSlash();
    });
    // ChatPage.tsx: <div className="input-area">
    const inputArea = h('div', { class: 'input-area' }, slashMenu, slashStatus, sessionToolsPanel, scopePanel, surface, draftStatus);

    const headerSlot = h('div', { class: 'conversation-header-slot hana-slot' });
    slots.mount('openhanako.conversation.header', headerSlot);

    // MainContent.tsx: <div className={`main-content${welcomeMode ? ' welcome-mode' : ''}`}>
    const root = h('div', { class: 'main-content welcome-mode' }, headerSlot, conversationStatus, chat, inputArea);

    function setModelLabel(label) {
      modelPill.firstChild.textContent = label || '—';
    }

    let modelRequestVersion = 0;
    let modelOpenIntent = false;
    const closeModels = () => {
      modelOpenIntent = false;
      modelRequestVersion += 1;
      modelSelector.classList.remove('open');
      modelPill.setAttribute('data-open', 'false');
      modelPill.setAttribute('aria-expanded', 'false');
      if (modelStatus.textContent === 'Loading models…') modelStatus.textContent = '';
    };

    const chooseModel = async (model) => {
      if (!model || state.opening || state.busy || state.switchingModel) return;
      state.switchingModel = true;
      modelRequestVersion += 1;
      const switchEpoch = state.epoch;
      modelStatus.textContent = 'Switching model…';
      modelStatus.className = 'model-switch-status';
      renderSendState();
      const optionsNow = modelDropdown.querySelectorAll('.model-option');
      optionsNow.forEach((option) => { option.disabled = true; });
      try {
        const payload = { modelId: model.id, provider: model.provider };
        const result = state.id
          ? await adapter.http('POST', '/api/models/switch', {
              ...payload,
              sessionPath: 'studio://' + state.id,
            })
          : await adapter.http('POST', '/api/models/set', payload);
        if (state.epoch !== switchEpoch) return;
        if (!result || result.ok !== true || !result.model
          || result.model.id !== model.id || result.model.provider !== model.provider) {
          throw new Error(result?.error || 'Model switch was not acknowledged for the selected model');
        }
        const selected = result.model;
        setModelLabel(selected.name || selected.id || model.id);
        closeModels();
        options.onChanged();
        modelStatus.textContent = '';
      } catch (err) {
        if (state.epoch === switchEpoch) {
          modelStatus.textContent = `Model switch failed: ${(err && err.message) ? err.message : String(err)}`;
          modelStatus.className = 'model-switch-status error';
        }
        throw err;
      } finally {
        optionsNow.forEach((option) => { option.disabled = false; });
        if (state.epoch === switchEpoch) {
          state.switchingModel = false;
          renderSendState();
        }
      }
    };

    const refreshModels = async (requestVersion, requestEpoch) => {
      const modelEndpoint = state.id
        ? `/api/models?sessionPath=${encodeURIComponent('studio://' + state.id)}`
        : '/api/models';
      const result = await adapter.http('GET', modelEndpoint);
      if (state.epoch !== requestEpoch || modelRequestVersion !== requestVersion) return null;
      if (!result || result.ok === false || result.error || !Array.isArray(result.models)
        || result.models.some((model) => !model || typeof model.id !== 'string' || !model.id.trim()
          || typeof model.provider !== 'string' || !model.provider.trim())) {
        throw new Error(result?.error || 'Invalid model list response');
      }
      modelStatus.className = 'model-switch-status';
      const models = result.models;
      clear(modelDropdown);
      for (const model of models) {
        const active = !!model.isCurrent
          || !!(result.activeModel
            && result.activeModel.id === model.id
            && result.activeModel.provider === model.provider);
        const option = h('button', {
          class: 'model-option' + (active ? ' active' : ''),
          type: 'button',
          title: model.provider ? `${model.provider} / ${model.id}` : model.id,
        }, model.name || model.id);
        option.onclick = () => chooseModel(model).catch((err) => {
          option.title = (err && err.message) ? err.message : String(err);
        });
        modelDropdown.appendChild(option);
        if (active) setModelLabel(model.name || model.id);
      }
      if (!models.length) {
        modelDropdown.appendChild(h('div', { class: 'model-option model-pill-disabled' }, 'No models'));
      }
      return result;
    };

    const refreshModelsWithStatus = async () => {
      const requestEpoch = state.epoch;
      const requestVersion = ++modelRequestVersion;
      modelStatus.textContent = 'Loading models…';
      try {
        const result = await refreshModels(requestVersion, requestEpoch);
        if (!result || state.epoch !== requestEpoch || modelRequestVersion !== requestVersion) return null;
        modelStatus.textContent = '';
        modelStatus.className = 'model-switch-status';
        return result;
      } catch (err) {
        if (state.epoch !== requestEpoch || modelRequestVersion !== requestVersion) return null;
        modelStatus.textContent = `Models unavailable: ${(err && err.message) ? err.message : String(err)}`;
        modelStatus.className = 'model-switch-status error';
        clear(modelDropdown);
        modelDropdown.appendChild(h('div', {
          class: 'model-option model-pill-disabled',
          'data-model-state': 'unavailable',
        }, 'Models unavailable'));
        return null;
      }
    };

    const refreshPendingModel = async () => {
      if (state.id || state.opening || state.busy) return false;
      await refreshModelsWithStatus();
      return true;
    };

    modelPill.onclick = async () => {
      if (state.opening || state.busy || state.switchingModel) return;
      if (modelOpenIntent) {
        closeModels();
        return;
      }
      modelOpenIntent = true;
      const epoch = state.epoch;
      const result = await refreshModelsWithStatus();
      if (!modelOpenIntent || state.epoch !== epoch || !result) {
        if (state.epoch === epoch && !result) modelOpenIntent = false;
        return;
      }
      modelSelector.classList.add('open');
      modelPill.setAttribute('data-open', 'true');
      modelPill.setAttribute('aria-expanded', 'true');
    };

    const retryFailedTurn = (index, message) => {
      if (state.busy || !message?.retryText) return;
      const retryText = String(message.retryText);
      const previous = state.turns[index - 1];
      if (previous?.role === 'user'
        && String(previous.text || '').trim() === retryText.trim()) {
        state.turns.splice(index - 1, 2);
      } else {
        state.turns.splice(index, 1);
      }
      input.textContent = retryText;
      captureDraft();
      draw();
      submit();
    };

    viewModeButton.onclick = () => {
      displayMode = displayMode === 'compact' ? 'normal' : 'compact';
      try {localStorage.setItem(DISPLAY_KEY, displayMode);} catch (_) {}
      draw();
    };
    function draw() {
      clear(stream);
      viewToolbar.style.display = state.turns.length ? '' : 'none';
      viewModeButton.textContent = displayMode === 'compact'
        ? '简洁视图 · 展开过程' : '完整视图 · 显示全部';
      const empty = !state.turns.length;
      welcome.classList.toggle('hidden', !empty);
      root.classList.toggle('welcome-mode', empty);
      chat.classList.toggle('has-panels', !empty);
      // Tool call ids may be reused in distinct turns. Results must never
      // escape their user-turn boundary when rendering historical evidence.
      const toolResultsByIndex = [];
      let resultsInTurn = new Map();
      let turnStart = 0;
      const commitResultScope = (end) => {
        for (let i = turnStart; i < end; i++) toolResultsByIndex[i] = resultsInTurn;
      };
      state.turns.forEach((message, i) => {
        if (message.role === 'user') {
          commitResultScope(i);
          resultsInTurn = new Map();
          turnStart = i;
        }
        (Array.isArray(message.tool_results) ? message.tool_results : []).forEach((result) => {
          const id = result && (result.tool_call_id ?? result.toolCallId ?? result.id);
          if (id != null) resultsInTurn.set(String(id), result);
        });
      });
      commitResultScope(state.turns.length);
      // Build one message at a time; the completed-turn fold below preserves
      // this exact order when it moves process rows inside disclosure panels.
      const renderMessage = (m, index, parent = stream) => {
        const isUser = m.role === 'user';
        const name = isUser ? USER_NAME : AGENT_NAME;
        const group = h('div', {
          class: 'messageGroup ' + (isUser ? 'messageGroupUser' : 'messageGroupAssistant')
            + (!isUser && m.retryText ? ' messageGroupError' : ''),
          ...(!isUser && m.retryText ? { 'data-message-state': 'error' } : {}),
        });
        if (isUser) {
          group.appendChild(h('div', { class: 'avatarRow avatarRowUser' },
            h('span', { class: 'avatarName' }, name),
            h('img', { class: 'avatar userAvatar', src: avatar, alt: name })));
        } else {
          group.appendChild(h('div', { class: 'avatarRow' },
            h('img', { class: 'avatar hanaAvatar', src: avatar, alt: name }),
            h('span', { class: 'avatarName' }, name)));
        }
        const appendText = (value) => group.appendChild(h('div', {
          class: 'message ' + (isUser ? 'messageUser' : 'messageAssistant'),
        }, h('div', { class: 'md-content' }, value || '')));
        const appendReasoning = (value) => group.appendChild(h('details', {class:'thinkingBlock'},
          h('summary', {class:'thinkingBlockSummary'}, 'Thinking'),
          h('div', {class:'thinkingBlockBody'}, value)));
        const appendTool = (call) => {
          const id = String(call.id ?? call.call_id ?? call.tool_call_id ?? '');
          const result = id ? toolResultsByIndex[index]?.get(id) : null;
          const failed = !!(result && (result.is_error === true || result.isError === true || result.success === false));
          const status = result ? (failed ? 'Failed' : 'Succeeded') : 'Running';
          const rawArgs = typeof call.arguments === 'string'
            ? call.arguments : JSON.stringify(call.arguments ?? {});
          const rawResult = result ? String(result.content ?? result.output ?? '') : 'Pending';
          const started = Number(call.started_at ?? call.startedAt);
          const finished = Number(result?.finished_at ?? result?.finishedAt);
          const elapsed = result && Number.isFinite(started) && Number.isFinite(finished)
            && finished >= started && started > 0 ? ` · ${finished - started} ms` : '';
          const preview = (value) => value.length > 24000
            ? value.slice(0,24000) + '\n[Output truncated in UI]' : value;
          const detail = h('details', {class:'conversationToolDetails'},
            h('summary', {class:'conversationToolSummary'},
              h('span', {class:'toolGroupTitle'}, call.name || 'tool'),
              h('span', {class:'openhanako-tool-status'}, status + elapsed)),
            h('div', {class:'conversationToolDetailBody'},
              h('strong', {}, 'Arguments'),
              h('pre', {}, preview(String(rawArgs || '{}'))),
              h('strong', {}, 'Result'),
              h('pre', {}, preview(rawResult))));
          group.appendChild(h('div', {
            class: 'toolGroup toolGroupSingle',
            'data-tool-state': result ? (failed ? 'failed' : 'succeeded') : 'running',
          }, detail));
        };
        const tools = !isUser && Array.isArray(m.tool_calls) ? m.tool_calls : [];
        const timeline = !isUser && Array.isArray(m.streamTimeline) && m.streamTimeline.length
          ? m.streamTimeline : null;
        if (timeline) {
          const seenTools = new Set();
          for (const segment of timeline) {
            if (segment?.kind === 'text' && segment.text) appendText(segment.text);
            if (segment?.kind === 'reasoning' && segment.text) appendReasoning(segment.text);
            if (segment?.kind === 'tool') {
              const id = String(segment.id || '');
              if (!id || seenTools.has(id)) continue;
              const call = tools.find((item) => String(item?.id ?? item?.call_id ?? item?.tool_call_id ?? '') === id);
              if (call) {
                appendTool(call);
                seenTools.add(id);
              }
            }
          }
          // A transcript snapshot may supply tools that live progress omitted.
          for (const call of tools) {
            const id = String(call.id ?? call.call_id ?? call.tool_call_id ?? '');
            if (id && !seenTools.has(id)) appendTool(call);
          }
        } else {
          if (m.text || isUser) appendText(m.text || '');
          for (const call of tools) appendTool(call);
        }
        if (!isUser && m.retryText) {
          const retry = h('button', {
            class: 'messageRetryBtn',
            type: 'button',
            title: 'Retry this message',
            'aria-label': 'Retry this message',
          }, 'Retry');
          retry.onclick = () => retryFailedTurn(index, m);
          group.appendChild(retry);
        }
        if (!isUser && m.reasoning && !timeline?.some((part) => part.kind === 'reasoning'))
          appendReasoning(m.reasoning);
        parent.appendChild(group);
      };
      if (displayMode === 'normal') {
        state.turns.forEach((m, index) => renderMessage(m, index));
      } else {
        let pending = [];
        let turnKey = null;
        const flushTurn = () => {
          if (!pending.length) return;
          const rows = pending;
          pending = [];
          // A final answer is the last plain text-bearing Assistant step.
          // If that same message contained tool calls, only the text after
          // its last tool call qualifies as a final answer.
          let answer = null;
          let answerIndex = -1;
          let processes = rows.slice();
          for (let n = rows.length - 1; n >= 0; n--) {
            const item = rows[n].m;
            if (item.role !== 'assistant' || item.retryText) continue;
            const timeline = Array.isArray(item.streamTimeline) ? item.streamTimeline : [];
            const tools = Array.isArray(item.tool_calls) ? item.tool_calls : [];
            const visibleText = !tools.length && !(item.tool_results || []).length
              ? String(item.text || '') : '';
            if (!visibleText.trim()) continue;
            answer = { ...item, text: visibleText, reasoning: '', tool_calls: [],
              tool_results: [], streamTimeline: [{kind:'text',text:visibleText}] };
            answerIndex = n;
            if (item.reasoning) {
              processes[n] = {...rows[n], m: {...item, text:'',
                streamTimeline:[], retryText:null}};
            } else processes.splice(n, 1);
            break;
          }
          const containsProcess = processes.some((row) => row.m.role === 'assistant'
            && (row.m.text || row.m.reasoning || row.m.tool_calls?.length
              || row.m.tool_results?.length));
          if (answer || containsProcess) {
            const key = `${turnKey || 'earlier'}:${rows[0].i}`;
            const selected = expandedProcessBySession.get(state.id) || new Set();
            const live = state.busy && rows.at(-1)?.i === state.turns.length - 1;
            const expanded = live || selected.has(key) || !answer;
            const toolIds = new Set();
            let reasoning = false;
            for (const row of processes) {
              if (row.m.reasoning) reasoning = true;
              for (const call of row.m.tool_calls || [])
                toolIds.add(String(call.id ?? call.call_id ?? call.tool_call_id ?? ''));
            }
            const summaryParts = ['过程详情'];
            if (toolIds.size) summaryParts.push(`${toolIds.size} 次工具调用`);
            if (reasoning) summaryParts.push('思考');
            const priorMessages = processes.filter((row) => row.m.role === 'assistant'
              && String(row.m.text || '').trim() && !(row.m.tool_calls || []).length).length;
            if (priorMessages) summaryParts.push(`${priorMessages} 条中间回复`);
            if (!containsProcess) summaryParts.push('无额外过程');
            const disclosure = h('details', {class:'conversationTurnDetails',
              'data-turn-key': key});
            disclosure.open = expanded;
            const summary = h('summary', {class:'conversationTurnSummary'}, summaryParts.join(' · '));
            summary.onclick = (event) => {
              event.preventDefault?.();
              disclosure.open = !disclosure.open;
              let current = expandedProcessBySession.get(state.id);
              if (!current) {current = new Set();expandedProcessBySession.set(state.id,current);}
              if (disclosure.open) current.add(key); else current.delete(key);
            };
            disclosure.appendChild(summary);
            const body = h('div', {class:'conversationTurnProcess'});
            if (!containsProcess) body.appendChild(h('p', {class:'conversationEmptyProcess'},
              '本轮没有额外的工具或思考记录。'));
            else for (const row of processes) {
              if (row.m.tool_results?.length && !row.m.text && !row.m.reasoning
                && !(row.m.tool_calls || []).length) continue;
              renderMessage(row.m,row.i,body);
            }
            disclosure.appendChild(body);
            stream.appendChild(disclosure);
          }
          if (answer) renderMessage(answer, rows[answerIndex].i);
          else if (!containsProcess) rows.forEach((row)=>renderMessage(row.m,row.i));
        };
        state.turns.forEach((m,index) => {
          if (m.role === 'user') {
            flushTurn();
            turnKey = `${index}:${String(m.text || '').slice(0, 80)}`;
            renderMessage(m,index);
          } else pending.push({m,i:index});
        });
        flushTurn();
      }
      chat.scrollTop = chat.scrollHeight;
    }

    async function open(session) {
      const previousId = state.id;
      captureDraft();
      stagedFiles = [];
      renderAttachments();
      const previousTurns = state.turns.slice();
      const wasBusy = state.busy;
      state.epoch += 1;
      closeSlash();
      slashStatus.textContent = '';
      scopeReset();
      toolsReset();
      const openEpoch = state.epoch;
      closeModels();
      state.id = session.id;
      restoreDraft();
      state.busy = false;
      state.cancelling = false;
      state.switchingModel = false;
      conversationStatus.textContent = 'Opening session…';
      state.opening = true;
      conversationStatus.className = 'conversation-status';
      renderSendState();
      if (wasBusy && previousId && previousId !== session.id) {
        api.cancel(previousId).catch(() => {});
      }
      try {
        if (session.live === false) {
          const resumed = await api.resume(session.id);
          if (state.epoch !== openEpoch) return false;
          if (resumed && (resumed.id || typeof resumed === 'string')) {
            state.id = resumed.id || resumed;
            restoreDraft();
          }
        }
        const transcript = await api.transcript(state.id);
        if (state.epoch !== openEpoch) return false;
        state.turns = transcript;
        await refreshModelsWithStatus();
        if (state.epoch !== openEpoch) return false;
        state.opening = false;
        renderSendState();
        conversationStatus.textContent = '';
        conversationStatus.className = 'conversation-status';
        draw();
        options.onOpened(state.id);
        return true;
      } catch (err) {
        if (state.epoch !== openEpoch) return false;
        state.id = previousId;
        restoreDraft();
        state.turns = previousTurns;
        state.busy = false;
        state.cancelling = false;
        state.switchingModel = false;
        conversationStatus.textContent = `Could not open session: ${(err && err.message) ? err.message : String(err)}`;
        state.opening = false;
        conversationStatus.className = 'conversation-status error';
        renderSendState();
        draw();
        options.onChanged();
        return false;
      }
    }

    const failSubmit = (err, submitEpoch = state.epoch, retryText = '') => {
      if (state.epoch !== submitEpoch) return;
      if (retryText && !input.textContent.trim()) { input.textContent = retryText; captureDraft(); }
      state.turns.push({
        role: 'assistant',
        text: (err && err.message) ? err.message : String(err),
        retryText: retryText || null,
      });
      state.busy = false;
      state.cancelling = false;
      renderSendState();
      draw();
      options.onChanged();
    };

    const transcriptIncludesLatestTurn = (transcript, text, minimumLength) => {
      if (!Array.isArray(transcript) || transcript.length < minimumLength) return false;
      const latestUser = [...transcript].reverse().find((message) => message?.role === 'user');
      return !!latestUser
        && String(latestUser.text || '').trim() === String(text || '').trim();
    };

    async function submit() {
      const rawText = input.textContent.trim();
      if ((!rawText && !stagedFiles.length) || state.opening || state.busy) return;
      if (rawText.startsWith('/')) {
        const match = /^\/([a-z]+)(?:\s(.*))?$/i.exec(rawText);
        if (match) {
          if (stagedFiles.length) {
            slashStatus.textContent = 'Remove attachments before running local commands';
          } else if (match[2]?.trim()) slashStatus.textContent = `/${match[1]} does not accept arguments`;
          else if (executeSlash(match[1].toLowerCase())) { input.textContent = ''; setDraft(''); }
          return;
        }
      }
      closeSlash();
      const filesForTurn = stagedFiles.slice();
      const text = rawText || 'Please inspect these attached files.';
      state.busy = true;
      const submitEpoch = state.epoch;
      conversationStatus.textContent = '';
      conversationStatus.className = 'conversation-status';
      state.cancelling = false;
      renderSendState();
      renderAttachments();
      input.textContent = '';
      setDraft('');
      const userTurn = { role: 'user', text };
      state.turns.push(userTurn);
      draw();
      if (!state.id) {
        try {
          const provider = await api.pickProvider();
          if (state.epoch !== submitEpoch) return;
          if (!provider) {
            failSubmit(new Error(t('error.llmAuthFailed')), submitEpoch, text);
            return;
          }
          const createdId = provider === 'mock'
            ? await api.create(provider, 'mock-1')
            : await api.create(provider);
          if (state.epoch !== submitEpoch) {
            if (createdId) api.dispose(createdId).catch(() => {});
            return;
          }
          state.id = createdId;
          options.onCreated(state.id);
        } catch (err) {
          failSubmit(err, submitEpoch, text);
          return;
        }
      }
      const assistant = {
        role: 'assistant',
        text: '',
        reasoning: '',
        tool_calls: [],
        tool_results: [],
        streamTimeline: [],
      };
      state.turns.push(assistant);
      const appendTimelineText = (delta) => {
        if (!delta) return;
        const latest = assistant.streamTimeline[assistant.streamTimeline.length - 1];
        if (latest?.kind === 'text') latest.text += String(delta);
        else assistant.streamTimeline.push({ kind: 'text', text: String(delta) });
      };
      draw();
      options.onChanged();
      try {
        const uploaded = [];
        const images = [];
        for (const file of filesForTurn) {
          if (state.epoch !== submitEpoch) return;
          if (state.cancelling) throw new Error('Attachment send cancelled');
          let cached = uploadedRefs.get(file);
          if (!cached || cached.sessionId !== state.id) {
            renderAttachments(`Uploading ${file.name}…`);
            const data = await base64FromFile(file);
            if (state.epoch !== submitEpoch) return;
            const result = await adapter.http('POST', '/api/upload-blob', {
              sessionId: state.id, name: file.name, mimeType: file.type || 'application/octet-stream',
              base64Data: data,
            });
            const upload = result?.uploads?.[0];
            if (result?.ok !== true
              || typeof upload?.fileId !== 'string' || !upload.fileId.trim()
              || typeof upload?.dest !== 'string' || !upload.dest.trim()) {
              throw new Error(result?.error || `Could not upload ${file.name}`);
            }
            cached = { sessionId: state.id, upload, data };
            uploadedRefs.set(file, cached);
          }
          uploaded.push({ name: file.name, dest: cached.upload.dest });
          if (file.type?.startsWith('image/') && api.sendImagesAvailable?.()) {
            images.push({ data: cached.data, mimeType: file.type, detail: 'auto' });
          }
        }
        if (state.epoch !== submitEpoch) return;
        if (state.cancelling) throw new Error('Attachment send cancelled');
        const sendText = uploaded.length
          ? `${text}\n\nAttached session files:\n${uploaded.map((file) => `- ${file.name}: ${file.dest}`).join('\n')}`
          : text;
        userTurn.text = sendText;
        draw();
        if (state.cancelling) throw new Error('Attachment send cancelled');
        const sent = await api.sendWithProgress(
          state.id,
          sendText,
          'hana-' + Date.now(),
          (event) => {
            if (!event || typeof event !== 'object') return;
            if (state.epoch !== submitEpoch || state.cancelling) return;
            if (event.kind === 'text_delta' && event.delta) {
              assistant.text += event.delta;
              appendTimelineText(event.delta);
            } else if (event.kind === 'thinking_delta' && event.delta) {
              assistant.reasoning += event.delta;
            } else if (event.kind === 'tool_start') {
              const id = String(event.id || ('tool-' + Date.now()));
              if (!assistant.tool_calls.some((call) => String(call.id) === id)) {
                assistant.tool_calls.push({
                  id,
                  name: event.name || 'tool',
                  arguments: event.args || {},
                });
                assistant.streamTimeline.push({ kind: 'tool', id });
              }
            } else if (event.kind === 'tool_end') {
              const id = String(event.id || '');
              if (id && !assistant.tool_calls.some((call) => String(call.id) === id)) {
                // Some bridges report completion without a matching start.
                assistant.tool_calls.push({ id, name: event.name || 'tool', arguments: {} });
                assistant.streamTimeline.push({ kind: 'tool', id });
              }
              if (id && !assistant.tool_results.some((result) => String(result.tool_call_id) === id)) {
                assistant.tool_results.push({
                  tool_call_id: id,
                  content: event.error || event.output || '',
                  is_error: event.success === false,
                  details: event.details,
                });
              }
            }
            draw();
            options.onChanged();
          },
          images.length ? { images } : {},
        );
        if (state.epoch === submitEpoch && sent !== false) {
          stagedFiles = stagedFiles.filter((file) => !filesForTurn.includes(file));
          renderAttachments();
        }
        if (state.epoch === submitEpoch
          && !sent
          && !assistant.text
          && !assistant.reasoning
          && !assistant.tool_calls.length
          && !assistant.tool_results.length) {
          assistant.text = t('error.llmEmptyResponse');
          assistant.retryText = text;
        }
        try {
          const minimumTranscriptLength = state.turns.length;
          const transcript = await api.transcript(state.id);
          if (state.epoch === submitEpoch
            && transcriptIncludesLatestTurn(transcript, sendText, minimumTranscriptLength)) {
            // Preserve precise live ordering only when the backend condensed
            // the current turn into a single assistant row with matching text.
            const lastUserIndex = transcript.map((row) => row?.role).lastIndexOf('user');
            const replies = transcript.slice(lastUserIndex + 1)
              .filter((row) => row?.role === 'assistant');
            const authoritativeTools = Array.isArray(replies[0]?.tool_calls)
              ? replies[0].tool_calls : [];
            const toolIds = new Set(authoritativeTools.map((call) =>
              String(call.id ?? call.call_id ?? call.tool_call_id ?? '')));
            const toolsPreserved = assistant.tool_calls.every((call) => toolIds.has(String(call.id)));
            if (replies.length === 1 && assistant.streamTimeline.length > 0 && toolsPreserved
              && (!Array.isArray(replies[0].streamTimeline) || !replies[0].streamTimeline.length)
              && String(replies[0].text || '').startsWith(assistant.text)) {
              const segments = assistant.streamTimeline.map((segment) => ({ ...segment }));
              const suffix = String(replies[0].text || '').slice(assistant.text.length);
              if (suffix) {
                const last = segments[segments.length - 1];
                if (last?.kind === 'text') last.text += suffix;
                else segments.push({ kind: 'text', text: suffix });
              }
              replies[0].streamTimeline = segments;
            }
            state.turns = transcript;
          }
        } catch (err) {
          if (state.epoch === submitEpoch
            && !assistant.text
            && !assistant.reasoning
            && !assistant.tool_calls.length
            && !assistant.tool_results.length) {
            assistant.text = (err && err.message) ? err.message : String(err);
          }
        }
      } catch (err) {
        if (state.epoch === submitEpoch) {
          const errorMessage = (err && err.message) ? err.message : String(err);
          if (filesForTurn.length) renderAttachments(errorMessage);
          assistant.text = errorMessage;
          if (assistant.streamTimeline.length) appendTimelineText(`\n${errorMessage}`);
          if (!assistant.reasoning && !assistant.tool_calls.length && !assistant.tool_results.length) {
            assistant.retryText = text;
          }
        }
      } finally {
        if (state.epoch === submitEpoch) {
          state.busy = false;
          state.cancelling = false;
          renderSendState();
          draw();
          options.onChanged();
        }
      }
    }

    async function stop() {
      if (!state.busy || state.cancelling || !state.id) return;
      state.cancelling = true;
      renderSendState();
      options.onChanged();
      try {
        await api.cancel(state.id);
      } catch (err) {
        state.turns.push({
          role: 'assistant',
          text: (err && err.message) ? err.message : String(err),
        });
        state.cancelling = false;
        renderSendState();
        draw();
        options.onChanged();
      }
    }

    send.onclick = () => (state.busy ? stop() : submit());
    input.addEventListener('keydown', (event) => {
      if (event?.key === 'Escape' && slashMenu.style.display !== 'none') {
        event.preventDefault?.();
        closeSlash();
        return;
      }
      if (event?.isComposing || event?.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });

    renderSendState();
    refreshModelsWithStatus();
    draw();
    return {
      root, open, setModelLabel, refreshPendingModel,
      reset: () => {
        const previousId = state.id;
        captureDraft();
        const wasBusy = state.busy;
        state.epoch += 1;
        closeSlash();
        slashStatus.textContent = '';
        stagedFiles = [];
        renderAttachments();
        scopeReset();
        toolsReset();
        state.id = null;
        state.turns = [];
        state.busy = false;
        state.cancelling = false;
        state.switchingModel = false;
        conversationStatus.textContent = '';
        state.opening = false;
        conversationStatus.className = 'conversation-status';
        closeModels();
        modelStatus.textContent = '';
        modelStatus.className = 'model-switch-status';
        setDraft('', null);
        restoreDraft(null);
        renderSendState();
        draw();
        input.focus?.();
        refreshPendingModel();
        if (wasBusy && previousId) api.cancel(previousId).catch(() => {});
      },
    };
  }
  return { render };
})();
