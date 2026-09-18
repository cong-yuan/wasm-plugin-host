// Centre column — the conversation: header, hero/stream, composer.
//
// Upstream's shape: a session header with a title and actions, a scrolling body
// where the hero (empty state, serif) gives way to the message stream, and a
// composer at the bottom with a toolbar row beneath the input. That composer
// column — input on top, tools/send beneath — is what makes the 16px radius
// read as one surface rather than a bordered box.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  const render = (el, opts) => {
    const t = opts && opts.titleSetter;
    const state = { agentId: null, turns: [], busy: false };

    const root = h('main', {
      class: 'hn-conv',
      'data-slot': 'conversation',
      'data-phase': 'hero',
    });

    // ── session header ──────────────────────────────────────────────────────
    const header = h('header', {
      class: 'hn-conv-header',
      'data-slot': 'conversation.session.header',
    });
    const titleRow = h('div', { class: 'hn-conv-titleRow' });
    const titleEl = h('div', { class: 'hn-conv-title', text: 'New session' });
    const headerActions = h('div', { class: 'hn-conv-headerActions' });
    S.mount('hana.conversation.header', headerActions);
    titleRow.appendChild(titleEl);
    titleRow.appendChild(headerActions);
    header.appendChild(titleRow);
    root.appendChild(header);

    // ── body ────────────────────────────────────────────────────────────────
    const body = h('div', { class: 'hn-conv-body' });
    const scroll = h('div', {
      class: 'hn-conv-scroll hn-scroll-quiet',
      'data-conversation-scroll': '',
      'data-slot': 'conversation',
    });

    // Empty state, in the serif display face, centred by margin:auto.
    const hero = h('div', { class: 'hn-hero' },
      h('div', { class: 'hn-hero-stack' },
        h('div', { class: 'hn-hero-titleGroup' },
          h('div', { class: 'hn-hero-headline', text: 'How can I help you today?' }),
          h('div', { class: 'hn-hero-body',
            text: 'Your first message creates a dsh agent and streams its reply here.' }),
        ),
        // Slot inside the empty state, for a suggestion row or starter cards.
        h('div', { class: 'hn-slot', 'data-slot': 'conversation.hero' }),
      ),
    );
    S.mount('hana.conversation.hero', hero.querySelector('[data-slot="conversation.hero"]'));

    // The stream is its own slot: a plugin may add a card between messages.
    const stream = h('div', { class: 'hn-msg-stream', 'data-slot': 'conversation.stream' });
    S.mount('hana.conversation.stream', stream);

    scroll.appendChild(hero);
    scroll.appendChild(stream);
    body.appendChild(scroll);

    // ── composer ────────────────────────────────────────────────────────────
    const seat = h('div', { class: 'hn-conv-composerSeat' });
    const stack = h('div', { class: 'hn-conv-composerStack' });
    const dockSlot = h('div', { 'data-slot': 'conversation.input.dock' });
    S.mount('hana.conversation.input.dock', dockSlot);
    stack.appendChild(dockSlot);

    const ta = h('textarea', {
      class: 'hn-comp-input',
      rows: 1,
      placeholder: 'Ask anything…',
      style: 'resize:none;border:0;background:transparent;width:100%;display:block',
    });

    const sendBtn = h('button', {
      class: 'hn-comp-primary',
      type: 'button',
      title: 'Send',
      'aria-label': 'Send',
    }, svgIcon('M5 12h14M13 6l6 6-6 6', 16));

    const rightSlot = h('div', { class: 'hn-comp-trailingSlot' });
    S.mount('hana.conversation.input.right', rightSlot);

    // Input on top, a toolbar row beneath — Hana's shape, and the one that makes
    // the 16px radius read as a single surface.
    const composer = h('div', {
      class: 'hn-comp',
      'data-slot': 'conversation.composer',
    },
      ta,
      h('div', { class: 'hn-comp-row' },
        h('div', { class: 'hn-comp-tools' },
          h('button', {
            class: 'hn-comp-add', type: 'button', title: 'Add', 'aria-label': 'Add',
          }, svgIcon('M12 5v14M5 12h19', 14)),
        ),
        h('div', { class: 'hn-comp-trailing' }, rightSlot, sendBtn),
      ),
    );
    stack.appendChild(composer);
    seat.appendChild(stack);
    body.appendChild(seat);
    root.appendChild(body);

    const setPhase = (phase) => root.setAttribute('data-phase', phase);

    const draw = () => {
      // Only the shell's own turns are redrawn; a stream slot's contributions
      // live in their own box and are left alone.
      for (const n of Array.from(stream.querySelectorAll('[data-role]'))) n.remove();
      const empty = state.turns.length === 0;
      hero.style.display = empty ? '' : 'none';
      setPhase(empty ? 'hero' : 'active');
      for (const turn of state.turns) {
        if (turn.role === 'user') {
          stream.appendChild(h('div', { class: 'hn-msg-userRow', 'data-role': 'user' },
            h('div', { class: 'hn-msg-userStack' },
              h('div', { class: 'hn-msg-bubble', text: turn.text }),
            ),
          ));
        } else {
          stream.appendChild(h('div', {
            'data-role': turn.role,
          },
            h('div', {
              class: turn.role === 'system' ? 'hn-msg-system' : 'hn-msg-assistant',
              text: turn.text,
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
        const short = text.length > 42 ? text.slice(0, 42) + '…' : text;
        titleEl.textContent = short;
        if (t) t(short);
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
        const transcript = await api.transcript(state.agentId);
        const last = transcript && transcript[transcript.length - 1];
        if (last && last.role !== 'user') {
          state.turns = transcript.map((m) => ({ role: m.role, text: m.text ?? '' }));
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
