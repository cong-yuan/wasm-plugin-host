// Centre column — the conversation: header, hero/stream, composer.
//
// Upstream's shape: a session header with a title and actions, a scrolling body
// where the hero (empty state, serif) gives way to the message stream, and a
// composer at the bottom with a toolbar row beneath the input. That composer
// column — input on top, tools/send beneath — is what makes the 16px radius
// read as one surface rather than a bordered box.
//
// The panel talks to the **real** backend: it picks a configured provider
// rather than assuming `mock`, and it can open an existing session's transcript.
return (function () {
  const { h, svgIcon } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  /** Collapse an assistant turn's tool activity into a readable summary line. */
  const toolSummary = (msg) => {
    const calls = msg.tool_calls || [];
    if (!calls.length) return '';
    const names = calls.map((c) => c.name).filter(Boolean);
    return names.length ? 'used ' + names.join(', ') : '';
  };

  const render = (el, opts) => {
    const state = { agentId: null, turns: [], busy: false, locked: false };

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
    const usageEl = h('div', { class: 'hn-conv-usage' });
    const headerActions = h('div', { class: 'hn-conv-headerActions' });
    S.mount('hana.conversation.header', headerActions);
    titleRow.appendChild(titleEl);
    titleRow.appendChild(usageEl);
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
          h('div', { class: 'hn-hero-body', 'data-hero-body': '',
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

    /**
     * Lock the composer when the open session has no live agent behind it.
     *
     * A stored session whose resume failed is still worth *reading*, but sending
     * to it cannot work. Disabling the input says so up front, rather than
     * accepting a message and failing on send — which reads as the app losing
     * the message.
     */
    const setLocked = (locked) => {
      state.locked = locked;
      root.setAttribute('data-locked', locked ? 'true' : 'false');
      ta.disabled = locked;
      sendBtn.disabled = locked || state.busy;
      ta.placeholder = locked
        ? 'This session could not be resumed, so it is read-only.'
        : 'Ask anything…';
    };

    /** The shell's own message rows only; a stream slot's box is left alone. */
    const ownRows = () => Array.from(stream.querySelectorAll('[data-own-turn]'));

    const messageNode = (turn) => {
      if (turn.role === 'user') {
        return h('div', { class: 'hn-msg-userRow', 'data-role': 'user', 'data-own-turn': '' },
          h('div', { class: 'hn-msg-userStack' },
            h('div', { class: 'hn-msg-bubble', text: turn.text }),
          ),
        );
      }
      if (turn.role === 'assistant') {
        const node = h('div', { 'data-role': 'assistant', 'data-own-turn': '' });
        if (turn.reasoning) {
          node.appendChild(h('details', { class: 'hn-msg-reasoning' },
            h('summary', { text: 'Reasoning' }),
            h('div', { class: 'hn-msg-reasoningBody', text: turn.reasoning }),
          ));
        }
        if (turn.text) {
          node.appendChild(h('div', { class: 'hn-msg-assistant', text: turn.text }));
        }
        const tools = toolSummary(turn);
        if (tools) {
          node.appendChild(h('div', { class: 'hn-msg-tools', text: tools }));
        }
        return node;
      }
      return h('div', { 'data-role': 'system', 'data-own-turn': '' },
        h('div', { class: 'hn-msg-system', text: turn.text }),
      );
    };

    const draw = () => {
      for (const n of ownRows()) n.remove();
      const empty = state.turns.length === 0;
      hero.style.display = empty ? '' : 'none';
      setPhase(empty ? 'hero' : 'active');
      for (const turn of state.turns) stream.appendChild(messageNode(turn));
      scroll.scrollTop = scroll.scrollHeight;
    };

    const setTitle = (text) => {
      titleEl.textContent = text || 'New session';
      if (opts && opts.titleSetter) opts.titleSetter(text || '');
    };

    /** Show the session's token total, or nothing when none was reported. */
    const setUsage = async (agentId) => {
      if (!agentId) { usageEl.replaceChildren(); return; }
      const agents = await api.agents();
      const me = agents.find((a) => a.id === agentId);
      const u = me && me.usage;
      if (!u || !u.calls) {
        // A provider that reports nothing must not read as "0 tokens".
        usageEl.replaceChildren();
        return;
      }
      const parts = [u.input + ' in', u.output + ' out'];
      if (u.reasoning) parts.push(u.reasoning + ' reasoning');
      usageEl.replaceChildren(h('span', {
        class: 'hn-conv-usageText',
        text: parts.join(' · '),
        title: `${u.calls} model call(s)`,
      }));
    };

    // ── opening an existing session ─────────────────────────────────────────
    // `session` is the whole row, not just an id, because a *stored* session
    // needs work before it can be read or sent to: there is no agent behind it
    // yet, so `transcript` would fail until it is resumed. Handling that here
    // keeps the distinction out of the sidebar, which only picks rows.
    const openSession = async (session) => {
      const id = typeof session === 'string' ? session : session && session.id;
      if (!id) return;
      // A stored row has no driver; put one behind it. Resuming is idempotent,
      // so doing it whenever the row says `live === false` is safe even if the
      // sidebar's view is a poll behind.
      const wasStored = typeof session === 'object' && session && session.live === false;
      if (wasStored) {
        const ok = await api.resume(id);
        if (ok === null) {
          // Could not resume: still show the history so the session is not
          // invisible, but say why it cannot be continued rather than offering
          // a composer that will fail on send.
          state.agentId = null;
          setLocked(true);
        } else {
          state.agentId = id;
          setLocked(false);
        }
      } else {
        state.agentId = id;
        setLocked(false);
      }
      const transcript = await api.transcript(id);
      state.turns = transcript.map((m) => ({
        role: m.role,
        text: m.text || '',
        reasoning: m.reasoning || '',
        tool_calls: m.tool_calls || [],
      }));
      // The title comes from the first user message, same as the sidebar's.
      const firstUser = state.turns.find((t) => t.role === 'user');
      setTitle(firstUser ? firstUser.text.slice(0, 60) : 'Session');
      draw();
      setUsage(state.agentId);
      if (opts && opts.onSessionChanged) opts.onSessionChanged();
    };

    // ── sending ─────────────────────────────────────────────────────────────
    const submit = async () => {
      const text = ta.value.trim();
      if (!text || state.busy) return;
      if (state.locked) return;
      state.busy = true;
      sendBtn.disabled = true;
      state.turns.push({ role: 'user', text });
      if (!state.agentId || titleEl.textContent === 'New session') {
        setTitle(text.length > 60 ? text.slice(0, 60) + '…' : text);
      }
      ta.value = '';
      ta.style.height = '';
      draw();

      if (!state.agentId && !state.locked) {
        // Pick a **configured** provider, not `mock`: a real endpoint the user
        // set up should be used, and defaulting to mock would silently ignore
        // it while appearing to work.
        const provider = await api.pickProvider();
        if (!provider) {
          state.turns.push({
            role: 'system',
            text: 'No LLM provider is registered. Add one under extra.llm in studio.json, or use the mock route.',
          });
          state.busy = false;
          sendBtn.disabled = false;
          draw();
          return;
        }
        const model = opts && opts.modelFor ? opts.modelFor(provider) : (provider === 'mock' ? 'mock-1' : provider);
        const created = await api.createAgent(provider, model);
        state.agentId = typeof created === 'string' && created ? created : (created && created.id) || null;
        if (!state.agentId) {
          state.turns.push({ role: 'system', text: `Could not create an agent on provider “${provider}”.` });
          state.busy = false;
          sendBtn.disabled = false;
          draw();
          return;
        }
        if (opts && opts.onSessionCreated) opts.onSessionCreated(state.agentId);
      }

      const sent = await api.send(state.agentId, text, 'm' + state.turns.length);
      if (sent === null) {
        state.turns.push({ role: 'system', text: 'The turn failed to send.' });
        state.busy = false;
        sendBtn.disabled = false;
        draw();
        return;
      }

      // Poll until the assistant's reply for this turn lands. dsh has no
      // streaming-to-frontend channel here, so this is a short poll rather than
      // a subscription — deliberately bounded, so a stuck turn cannot spin
      // forever.
      const before = state.turns.filter((t) => t.role === 'assistant').length;
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const transcript = await api.transcript(state.agentId);
        const assistants = transcript.filter((m) => m.role === 'assistant');
        if (assistants.length > before) {
          state.turns = transcript.map((m) => ({
            role: m.role,
            text: m.text || '',
            reasoning: m.reasoning || '',
            tool_calls: m.tool_calls || [],
          }));
          draw();
          break;
        }
      }
      state.busy = false;
      sendBtn.disabled = false;
      setUsage(state.agentId);
      if (opts && opts.onSessionChanged) opts.onSessionChanged();
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

    // ── wiring the frame's controls into this panel ─────────────────────────
    if (opts && opts.registerControls) {
      opts.registerControls({
        /** Start a fresh session: clear the view, keep nothing from the old one. */
        newSession: () => {
          state.agentId = null;
          state.turns = [];
          setTitle('');
          setLocked(false);
          usageEl.replaceChildren();
          setUsage(null);
          draw();
          ta.focus();
        },
        openSession,
      });
    }

    // Tell the user when there is no backend at all, so the empty state is
    // honest: "no sessions yet" and "backend unreachable" are different facts.
    // `available()` is synchronous, so this is a plain branch.
    if (!api.available()) {
      const body = hero.querySelector('[data-hero-body]');
      if (body) body.textContent = 'The backend is not reachable from this window.';
    }

    draw();
    el.appendChild(root);
    return undefined;
  };

  return { render };
})();
