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
    const state = { id: null, turns: [], busy: false, cancelling: false, memory: true, epoch: 0, switchingModel: false };
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
      svg(FOLDER), h('span', {}, t('input.selectWorkspace')), svg(FOLDER_SWAP));
    markUnsupported(folderBtn, 'Workspace selection is not available in the standalone Studio bridge yet.');
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
    const stream = h('div', { class: 'message-stream' });
    slots.mount('openhanako.conversation.stream', stream);
    const chat = h('div', { class: 'chat-area' }, welcome, stream);
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

    const attach = h('button', { class: 'attach-btn', type: 'button', title: t('input.attachFiles') }, svg(PLUS));
    const slash = h('button', { class: 'attach-btn', type: 'button', title: t('input.commandMenu') }, svg(SLASH));
    const plan = h('button', { class: 'plan-mode-btn plan-mode-default', type: 'button' }, svg(PLAN));
    markUnsupported(attach, 'File attachments are not available in the standalone Studio bridge yet.');
    markUnsupported(slash, 'Slash commands require the server command dispatcher and are not available here yet.');
    markUnsupported(plan, 'Permission modes are unavailable until the Studio bridge can enforce them.');
    const trailing = h('span', { class: 'input-trailing-slot hana-slot' });
    slots.mount('openhanako.conversation.input.right', trailing);

    const modelPill = h('button', { class: 'model-pill', type: 'button', 'data-open': 'false' },
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
      if (state.busy) {
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
      const modelDisabled = !!state.busy || !!state.switchingModel;
      modelPill.disabled = modelDisabled;
      modelPill.classList.toggle('model-pill-disabled', modelDisabled);
      modelSelector.setAttribute('aria-busy', state.switchingModel ? 'true' : 'false');
    }

    const controlBar = h('div', { class: 'input-bottom-bar' },
      h('div', { class: 'input-actions' }, attach, slash, plan, trailing),
      h('div', { class: 'input-controls' }, modelSelector, send));

    const wrapper = h('div', { class: 'input-wrapper' }, input, controlBar);
    const surface = h('div', { class: 'input-surface' },
      dock, h('div', { class: 'input-stack' }, wrapper));
    // ChatPage.tsx: <div className="input-area">
    const inputArea = h('div', { class: 'input-area' }, surface);

    const headerSlot = h('div', { class: 'conversation-header-slot hana-slot' });
    slots.mount('openhanako.conversation.header', headerSlot);

    // MainContent.tsx: <div className={`main-content${welcomeMode ? ' welcome-mode' : ''}`}>
    const root = h('div', { class: 'main-content welcome-mode' }, headerSlot, conversationStatus, chat, inputArea);

    function setModelLabel(label) {
      modelPill.firstChild.textContent = label || '—';
    }

    const closeModels = () => {
      modelSelector.classList.remove('open');
      modelPill.setAttribute('data-open', 'false');
    };

    const chooseModel = async (model) => {
      if (!model || state.busy || state.switchingModel) return;
      state.switchingModel = true;
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
        const selected = result && result.model ? result.model : model;
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

    const refreshModels = async () => {
      const result = await adapter.http('GET', '/api/models');
      const models = result && Array.isArray(result.models) ? result.models : [];
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

    modelPill.onclick = async () => {
      if (state.busy || state.switchingModel) return;
      const opening = !modelSelector.classList.contains('open');
      if (!opening) {
        closeModels();
        return;
      }
      try {
        await refreshModels();
        modelStatus.textContent = '';
        modelStatus.className = 'model-switch-status';
      } catch (err) {
        modelStatus.textContent = `Models unavailable: ${(err && err.message) ? err.message : String(err)}`;
        modelStatus.className = 'model-switch-status error';
      }
      modelSelector.classList.add('open');
      modelPill.setAttribute('data-open', 'true');
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
      draw();
      submit();
    };

    function draw() {
      clear(stream);
      const empty = !state.turns.length;
      welcome.classList.toggle('hidden', !empty);
      root.classList.toggle('welcome-mode', empty);
      chat.classList.toggle('has-panels', !empty);
      const toolResults = new Map();
      state.turns.forEach((message) => {
        (message && Array.isArray(message.tool_results) ? message.tool_results : []).forEach((result) => {
          const id = result && (result.tool_call_id ?? result.toolCallId ?? result.id);
          if (id != null) toolResults.set(String(id), result);
        });
      });
      // UserMessage.tsx / AssistantMessage.tsx group markup (Chat.module.css).
      state.turns.forEach((m, index) => {
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
        group.appendChild(h('div', {
          class: 'message ' + (isUser ? 'messageUser' : 'messageAssistant'),
        }, h('div', { class: 'md-content' }, m.text || '')));
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
        if (!isUser && m.reasoning) {
          group.appendChild(h('details', { class: 'thinkingBlock' },
            h('summary', { class: 'thinkingBlockSummary' }, 'Thinking'),
            h('div', { class: 'thinkingBlockBody' }, m.reasoning)));
        }
        if (!isUser && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          m.tool_calls.forEach((call) => {
            const id = String(call.id ?? call.call_id ?? call.tool_call_id ?? '');
            const result = id ? toolResults.get(id) : null;
            const failed = !!(result && (result.is_error === true || result.isError === true || result.success === false));
            const status = result ? (failed ? 'Failed' : 'Succeeded') : 'Running';
            const box = h('div', {
              class: 'toolGroup toolGroupSingle',
              'data-tool-state': result ? (failed ? 'failed' : 'succeeded') : 'running',
            },
              h('div', { class: 'toolGroupContent' },
                h('div', { class: 'toolGroupSummary' },
                  h('span', { class: 'toolGroupTitle' }, call.name || 'tool'),
                  h('span', { class: 'openhanako-tool-status' }, status))));
            group.appendChild(box);
          });
        }
        stream.appendChild(group);
      });
      chat.scrollTop = chat.scrollHeight;
    }

    async function open(session) {
      const previousId = state.id;
      const previousTurns = state.turns.slice();
      const wasBusy = state.busy;
      state.epoch += 1;
      const openEpoch = state.epoch;
      state.id = session.id;
      state.busy = false;
      state.cancelling = false;
      state.switchingModel = false;
      conversationStatus.textContent = 'Opening session…';
      conversationStatus.className = 'conversation-status';
      renderSendState();
      if (wasBusy && previousId && previousId !== session.id) {
        api.cancel(previousId).catch(() => {});
      }
      try {
        if (session.live === false) {
          const resumed = await api.resume(session.id);
          if (state.epoch !== openEpoch) return false;
          if (resumed && (resumed.id || typeof resumed === 'string')) state.id = resumed.id || resumed;
        }
        const transcript = await api.transcript(state.id);
        if (state.epoch !== openEpoch) return false;
        state.turns = transcript;
        await refreshModels().catch(() => {});
        if (state.epoch !== openEpoch) return false;
        conversationStatus.textContent = '';
        conversationStatus.className = 'conversation-status';
        draw();
        options.onOpened(state.id);
        return true;
      } catch (err) {
        if (state.epoch !== openEpoch) return false;
        state.id = previousId;
        state.turns = previousTurns;
        state.busy = false;
        state.cancelling = false;
        state.switchingModel = false;
        conversationStatus.textContent = `Could not open session: ${(err && err.message) ? err.message : String(err)}`;
        conversationStatus.className = 'conversation-status error';
        renderSendState();
        draw();
        options.onChanged();
        return false;
      }
    }

    const failSubmit = (err, submitEpoch = state.epoch, retryText = '') => {
      if (state.epoch !== submitEpoch) return;
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
      const text = input.textContent.trim();
      if (!text || state.busy) return;
      state.busy = true;
      const submitEpoch = state.epoch;
      conversationStatus.textContent = '';
      conversationStatus.className = 'conversation-status';
      state.cancelling = false;
      renderSendState();
      input.textContent = '';
      state.turns.push({ role: 'user', text });
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
      };
      state.turns.push(assistant);
      draw();
      options.onChanged();
      try {
        const sent = await api.sendWithProgress(
          state.id,
          text,
          'hana-' + Date.now(),
          (event) => {
            if (!event || typeof event !== 'object') return;
            if (state.epoch !== submitEpoch || state.cancelling) return;
            if (event.kind === 'text_delta' && event.delta) {
              assistant.text += event.delta;
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
              }
            } else if (event.kind === 'tool_end') {
              const id = String(event.id || '');
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
        );
        if (state.epoch === submitEpoch && !sent && !assistant.text) assistant.text = t('error.llmEmptyResponse');
        try {
          const minimumTranscriptLength = state.turns.length;
          const transcript = await api.transcript(state.id);
          if (state.epoch === submitEpoch
            && transcriptIncludesLatestTurn(transcript, text, minimumTranscriptLength)) {
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
          assistant.text = (err && err.message) ? err.message : String(err);
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
      if (event?.isComposing || event?.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });

    renderSendState();
    refreshModels().catch(() => {});
    draw();
    return {
      root, open, setModelLabel,
      reset: () => {
        const previousId = state.id;
        const wasBusy = state.busy;
        state.epoch += 1;
        state.id = null;
        state.turns = [];
        state.busy = false;
        state.cancelling = false;
        state.switchingModel = false;
        conversationStatus.textContent = '';
        conversationStatus.className = 'conversation-status';
        closeModels();
        renderSendState();
        draw();
        input.focus?.();
        if (wasBusy && previousId) api.cancel(previousId).catch(() => {});
      },
    };
  }
  return { render };
})();
