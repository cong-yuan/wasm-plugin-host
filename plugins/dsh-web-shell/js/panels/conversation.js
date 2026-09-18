// Centre column — official conversation root + composer classes. No fake chrome.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  const render = (el) => {
    const state = { agentId: null, turns: [], busy: false };

    const root = h('main', {
      class: 'dw-conv-root',
      'data-slot': 'main.conversation',
      'data-dsh-surface': 'conversation',
      'data-phase': 'hero',
    });

    const header = h('header', {
      class: 'dw-conv-header',
      'data-slot': 'conversation.session.header',
      'data-dsh-surface': 'session-header',
    });
    const titleRow = h('div', { class: 'dw-conv-titleRow' });
    const titleEl = h('div', {
      class: 'dw-conv-titleCluster',
      style: 'font-size:16px;font-weight:500;line-height:24px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
      text: 'New session',
    });
    const headerActions = h('div', {
      class: 'dw-conv-headerActions',
      'data-slot': 'conversation.session.header.actions',
    });
    S.mount('dsh-web.conversation.header.actions', headerActions);
    titleRow.appendChild(titleEl);
    titleRow.appendChild(headerActions);
    header.appendChild(titleRow);
    root.appendChild(header);

    const body = h('div', { class: 'dw-conv-body' });
    const scroll = h('div', {
      class: 'dw-conv-scrollBody dw-scroll-quiet',
      'data-conversation-scroll': '',
      'data-dsh-part': 'scrollport',
      'data-slot': 'conversation',
    });

    // Empty state, in the serif display face. Centred by margin:auto so it sits
    // in the middle of the scroll area without absolute positioning.
    const hero = h('div', { class: 'dw-hero-root' },
      h('div', { class: 'dw-hero-stack' },
        h('div', { class: 'dw-hero-titleGroup' },
          h('div', { class: 'dw-hero-headline', text: 'How can I help you today?' }),
          h('div', { class: 'dw-hero-body',
            text: 'Your first message creates a dsh agent and streams its reply here.' }),
        ),
        // Slot inside the empty state, so a plugin can add a suggestion row or
        // a starter card without this file changing.
        h('div', { class: 'dw-slot', 'data-slot': 'conversation.hero' }),
      ),
    );
    S.mount('dsh-web.conversation.hero', hero.querySelector('[data-slot="conversation.hero"]'));

    const stream = h('div', {
      class: 'dw-msg-stream',
      'data-slot': 'conversation.session',
    });
    const overlay = h('div', {
      style: 'position:absolute;top:0;right:0;pointer-events:none',
      'data-slot': 'conversation.overlay',
    });
    S.mount('dsh-web.conversation.overlay', overlay);

    scroll.appendChild(hero);
    scroll.appendChild(stream);
    scroll.appendChild(overlay);
    body.appendChild(scroll);

    const seat = h('div', { class: 'dw-conv-composerSeat' });
    const stack = h('div', { class: 'dw-conv-composerStack' });
    const dockSlot = h('div', { 'data-slot': 'conversation.input.dock' });
    S.mount('dsh-web.conversation.input.dock', dockSlot);
    stack.appendChild(dockSlot);

    const ta = h('textarea', {
      class: 'dw-comp-input',
      rows: 1,
      placeholder: 'Ask anything…',
      'data-phase': 'idle',
      'data-dsh-part': 'composer-input',
      style: 'resize:none;border:0;background:transparent;width:100%;display:block',
    });

    const sendBtn = h('button', {
      class: 'dw-comp-primary',
      type: 'button',
      title: 'Send',
      'aria-label': 'Send',
    }, svgIcon('M5 12h14M13 6l6 6-6 6', 16));

    const rightSlot = h('div', { style: 'display:flex;align-items:center;gap:8px' });
    S.mount('dsh-web.conversation.input.right', rightSlot);

    // The composer is a column: the input on top, a toolbar row beneath it.
    // That is Hana's shape, and it is what makes the 16px radius read as a
    // single surface rather than a bordered box around a textarea.
    const composer = h('div', {
      class: 'dw-comp-root',
      'data-slot': 'conversation.composer',
    },
      ta,
      h('div', { class: 'dw-comp-row' },
        h('div', { class: 'dw-comp-tools' },
          h('button', {
            class: 'dw-comp-add', type: 'button', title: 'Add', 'aria-label': 'Add',
          }, svgIcon('M12 5v14M5 12h14', 14)),
        ),
        h('div', { class: 'dw-comp-trailing' }, rightSlot, sendBtn),
      ),
    );
    stack.appendChild(composer);
    seat.appendChild(stack);
    body.appendChild(seat);
    root.appendChild(body);

    const setPhase = (phase) => root.setAttribute('data-phase', phase);

    const draw = () => {
      stream.replaceChildren();
      const empty = state.turns.length === 0;
      hero.style.display = empty ? '' : 'none';
      setPhase(empty ? 'hero' : 'active');
      for (const t of state.turns) {
        if (t.role === 'user') {
          stream.appendChild(h('div', {
            class: 'dw-msg-userRow',
            'data-role': 'user',
            'data-dsh-part': 'message-row',
          },
            h('div', { class: 'dw-msg-userStack' },
              h('div', {
                class: 'dw-msg-bubble',
                'data-dsh-part': 'message-body',
                text: t.text,
              }),
            ),
          ));
        } else {
          stream.appendChild(h('div', {
            'data-role': t.role,
            'data-dsh-part': 'message-row',
          },
            h('div', {
              class: t.role === 'system' ? 'dw-msg-system' : 'dw-msg-assistant',
              'data-dsh-part': 'message-body',
              text: t.text,
            }),
          ));
        }
      }
      scroll.scrollTop = scroll.scrollHeight;
    };

    const submit = async () => {
      const text = ta.value.trim();
      if (!text || state.busy) return;
      state.busy = true;
      sendBtn.disabled = true;
      state.turns.push({ role: 'user', text });
      if (titleEl.textContent === 'New session') {
        titleEl.textContent = text.length > 42 ? text.slice(0, 42) + '…' : text;
      }
      ta.value = '';
      ta.style.height = '';
      draw();
      if (!state.agentId) {
        const a = await api.createAgent('mock', 'mock-1');
        state.agentId = typeof a === 'string' && a ? a : (a && a.id) || null;
        if (!state.agentId) {
          state.turns.push({ role: 'system', text: 'Harness offline — could not create an agent.' });
          state.busy = false;
          sendBtn.disabled = false;
          draw();
          return;
        }
      }
      await api.send(state.agentId, text, 'm' + state.turns.length);
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const t = await api.transcript(state.agentId);
        const last = t && t[t.length - 1];
        if (last && last.role !== 'user') {
          state.turns = t.map((m) => ({ role: m.role, text: m.text ?? '' }));
          draw();
          break;
        }
      }
      state.busy = false;
      sendBtn.disabled = false;
    };

    sendBtn.onclick = submit;
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };
    ta.oninput = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 336) + 'px';
    };

    draw();
    el.appendChild(root);
    return undefined;
  };
  return { render };
})();
