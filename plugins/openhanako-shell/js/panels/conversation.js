// Ported from openhanako (Apache-2.0): ChatPage.tsx, WelcomeScreen.tsx,
// InputArea.tsx, InputControlBar.tsx, SendButton.tsx, PlanModeButton.tsx.
// Markup, class names and SVG geometry are copied verbatim from upstream.
return (function () {
  const { h, svg, clear } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const api = studio.require('lib/api');
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
    const state = { id: null, turns: [], busy: false, memory: true };

    // ── WelcomeScreen.tsx ──
    const heroSlot = h('div', { class: 'hana-slot' });
    slots.mount('hana.conversation.hero', heroSlot);

    const folderBtn = h('button', { class: 'folderSelectBtn', type: 'button' },
      svg(FOLDER), h('span', {}, t('input.selectWorkspace')), svg(FOLDER_SWAP));
    const memoryBtn = h('button', { class: 'memoryToggleBtn memoryToggleBtnActive', type: 'button' },
      svg(MEMORY), h('span', {}, t('welcome.memoryOn')));
    memoryBtn.onclick = () => {
      state.memory = !state.memory;
      memoryBtn.classList.toggle('memoryToggleBtnActive', state.memory);
      memoryBtn.lastChild.textContent = t(state.memory ? 'welcome.memoryOn' : 'welcome.memoryOff');
    };

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
    slots.mount('hana.conversation.stream', stream);
    const chat = h('div', { class: 'chat-area' }, welcome, stream);

    // ── InputArea.tsx ──
    const dock = h('div', { class: 'input-dock hana-slot' });
    slots.mount('hana.conversation.input.dock', dock);

    const input = h('div', {
      class: 'input-box', contenteditable: 'true', role: 'textbox',
      'aria-multiline': 'true', 'aria-label': t('input.placeholder'),
      'data-placeholder': t('input.placeholder'),
    });

    const attach = h('button', { class: 'attach-btn', type: 'button', title: t('input.attachFiles') }, svg(PLUS));
    const slash = h('button', { class: 'attach-btn', type: 'button', title: t('input.commandMenu') }, svg(SLASH));
    const plan = h('button', { class: 'plan-mode-btn plan-mode-default', type: 'button' }, svg(PLAN));
    const trailing = h('span', { class: 'input-trailing-slot hana-slot' });
    slots.mount('hana.conversation.input.right', trailing);

    const modelPill = h('button', { class: 'model-pill', type: 'button' },
      h('span', { class: 'model-pill-label' }, '—'), svg(CHEVRON_DOWN));
    const modelSelector = h('div', { class: 'model-selector' }, modelPill);

    const send = h('button', { class: 'send-btn', type: 'button' },
      h('span', { class: 'send-label' }, svg(SEND_ENTER), h('span', {}, t('chat.send'))));

    const controlBar = h('div', { class: 'input-bottom-bar' },
      h('div', { class: 'input-actions' }, attach, slash, plan, trailing),
      h('div', { class: 'input-controls' }, modelSelector, send));

    const wrapper = h('div', { class: 'input-wrapper' }, input, controlBar);
    const surface = h('div', { class: 'input-surface' },
      dock, h('div', { class: 'input-stack' }, wrapper));
    // ChatPage.tsx: <div className="input-area">
    const inputArea = h('div', { class: 'input-area' }, surface);

    const headerSlot = h('div', { class: 'conversation-header-slot hana-slot' });
    slots.mount('hana.conversation.header', headerSlot);

    // MainContent.tsx: <div className={`main-content${welcomeMode ? ' welcome-mode' : ''}`}>
    const root = h('div', { class: 'main-content welcome-mode' }, headerSlot, chat, inputArea);

    function setModelLabel(label) {
      modelPill.firstChild.textContent = label || '—';
    }

    function draw() {
      clear(stream);
      const empty = !state.turns.length;
      welcome.classList.toggle('hidden', !empty);
      root.classList.toggle('welcome-mode', empty);
      chat.classList.toggle('has-panels', !empty);
      // UserMessage.tsx / AssistantMessage.tsx group markup (Chat.module.css).
      state.turns.forEach((m) => {
        const isUser = m.role === 'user';
        const name = isUser ? USER_NAME : AGENT_NAME;
        const group = h('div', {
          class: 'messageGroup ' + (isUser ? 'messageGroupUser' : 'messageGroupAssistant'),
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
        stream.appendChild(group);
      });
      chat.scrollTop = chat.scrollHeight;
    }

    async function open(session) {
      state.id = session.id;
      if (session.live === false) {
        const resumed = await api.resume(session.id);
        if (resumed && (resumed.id || typeof resumed === 'string')) state.id = resumed.id || resumed;
      }
      state.turns = await api.transcript(state.id);
      draw();
      options.onOpened(state.id);
    }

    async function submit() {
      const text = input.textContent.trim();
      if (!text || state.busy) return;
      state.busy = true;
      send.disabled = true;
      input.textContent = '';
      state.turns.push({ role: 'user', text });
      draw();
      if (!state.id) {
        const provider = await api.pickProvider();
        if (!provider) {
          state.turns.push({ role: 'assistant', text: t('error.llmAuthFailed') });
          state.busy = false; send.disabled = false; draw(); return;
        }
        state.id = await api.create(provider, provider === 'mock' ? 'mock-1' : provider);
        options.onCreated(state.id);
      }
      const sent = await api.send(state.id, text, 'hana-' + Date.now());
      if (!sent) state.turns.push({ role: 'assistant', text: t('error.llmEmptyResponse') });
      else state.turns = await api.transcript(state.id);
      state.busy = false;
      send.disabled = false;
      draw();
      options.onChanged();
    }

    send.onclick = submit;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });

    draw();
    return {
      root, open, setModelLabel,
      reset: () => { state.id = null; state.turns = []; draw(); input.focus(); },
    };
  }
  return { render };
})();
