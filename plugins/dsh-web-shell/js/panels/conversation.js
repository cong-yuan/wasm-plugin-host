// The centre column: session header, message stream, composer.
//
// Every region carries a slot, so a later plugin can add a header button, an
// overlay on the stream, something beside the send button, or a panel around
// the composer — without this file changing.
return (function () {
  const { h, sv, region } = studio.require('lib/dom');
  const S = studio.require('lib/slots');
  const api = studio.require('lib/api');

  const render = (el) => {
    const state = { agentId: null, turns: [], busy: false };

    const root = h('main', {
      'data-slot': 'main.conversation',
      style: 'flex:1;min-width:0;display:flex;flex-direction:column;min-height:0',
    });

    // ── session header ───────────────────────────────────────────────────────
    const header = h('header', {
      'data-slot': 'conversation.session.header',
      style:
        'display:flex;align-items:center;gap:10px;padding:9px 16px;min-height:44px;' +
        'border-bottom:1px solid ' + sv('border-secondary'),
    },
      h('span', { style: 'font-size:13px;font-weight:500', text: 'New session' }),
      h('span', { style: 'font-size:11px;color:' + sv('text-quaternary'), text: 'dsh agent loop' }),
    );
    const headerActions = h('div', {
      'data-slot': 'conversation.session.header.actions',
      style: 'margin-left:auto;display:flex;align-items:center;gap:6px',
    });
    S.mount('dsh-web.conversation.header.actions', headerActions);
    header.appendChild(headerActions);
    root.appendChild(header);

    // ── message stream (the scroll port) ─────────────────────────────────────
    const stream = h('div', {
      'data-slot': 'conversation',
      style: 'flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px;position:relative',
    });
    const hero = h('div', {
      'data-slot': 'conversation.hero',
      style: 'margin:auto;text-align:center;max-width:46ch;color:' + sv('text-tertiary'),
    },
      h('div', { style: 'font-size:15px;margin-bottom:6px;color:' + sv('text-secondary'),
        text: 'What should we build?' }),
      h('div', { style: 'font-size:12px;line-height:1.7',
        text: 'Your first message creates a dsh agent and streams its reply here.' }),
    );
    const heroSlot = h('div', { style: 'margin-top:14px' });
    S.mount('dsh-web.conversation.hero', heroSlot);
    hero.appendChild(heroSlot);
    stream.appendChild(hero);

    const overlay = h('div', {
      'data-slot': 'conversation.overlay',
      style: 'position:absolute;top:0;right:0;pointer-events:none;display:flex;flex-direction:column;gap:6px;padding:10px',
    });
    S.mount('dsh-web.conversation.overlay', overlay);
    stream.appendChild(overlay);
    root.appendChild(stream);

    const draw = () => {
      // Keep hero + overlay; replace only the message rows.
      for (const n of [...stream.children]) {
        if (n !== hero && n !== overlay) n.remove();
      }
      hero.style.display = state.turns.length ? 'none' : '';
      for (const t of state.turns) {
        const mine = t.role === 'user';
        stream.appendChild(h('div', {
          'data-chat-message': t.role,
          style: 'display:flex;gap:10px;' + (mine ? 'justify-content:flex-end' : ''),
        },
          h('div', {
            style:
              'max-width:78%;padding:9px 12px;border-radius:8px;font-size:13px;line-height:1.65;' +
              'white-space:pre-wrap;word-break:break-word;' +
              (mine
                ? 'background:' + sv('primary-bg') + ';border:1px solid ' + sv('primary-border')
                : 'background:' + sv('fill-secondary')),
          }, t.text),
        ));
      }
      stream.scrollTop = stream.scrollHeight;
    };

    // ── composer ─────────────────────────────────────────────────────────────
    const dock = h('div', {
      'data-slot': 'conversation.input.dock',
      style: 'padding:0 16px 14px;display:flex;flex-direction:column;gap:6px',
    });
    const dockSlotTop = h('div', { style: 'display:flex;gap:6px;align-items:center' });
    S.mount('dsh-web.conversation.input.dock', dockSlotTop);
    dock.appendChild(dockSlotTop);

    const input = h('textarea', {
      rows: 1,
      placeholder: 'Message the agent…  (Enter to send, Shift+Enter for newline)',
      style:
        'flex:1;resize:none;border:0;outline:none;background:transparent;font:inherit;' +
        'font-size:13px;line-height:1.55;color:' + sv('text') + ';max-height:170px',
    });
    const sendBtn = h('button', {
      text: 'Send',
      style:
        'padding:6px 14px;border-radius:6px;border:1px solid ' + sv('primary') + ';font:inherit;' +
        'font-size:12px;cursor:pointer;background:' + sv('primary') + ';color:' + sv('text-on-primary'),
    });
    // Slot *inside* the composer, right of the send button.
    const rightSlot = h('div', { style: 'display:flex;align-items:center;gap:6px' });
    S.mount('dsh-web.conversation.input.right', rightSlot);
    const composer = h('div', {
      'data-slot': 'conversation.composer',
      style:
        'display:flex;align-items:flex-end;gap:10px;padding:10px 12px;border-radius:10px;' +
        'border:1px solid ' + sv('border') + ';background:' + sv('bg-elevated'),
    }, input, sendBtn, rightSlot);
    dock.appendChild(composer);
    root.appendChild(dock);

    const submit = async () => {
      const text = input.value.trim();
      if (!text || state.busy) return;
      state.busy = true;
      state.turns.push({ role: 'user', text });
      input.value = '';
      draw();
      if (!state.agentId) {
        const a = await api.createAgent('mock', 'mock-1');
        state.agentId = typeof a === 'string' && a ? a : (a && a.id) || null;
        if (!state.agentId) {
          state.turns.push({ role: 'system', text: 'Could not create an agent — is the harness online?' });
          state.busy = false; draw(); return;
        }
      }
      await api.send(state.agentId, text, 'm' + state.turns.length);
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const t = await api.transcript(state.agentId);
        const last = t && t[t.length - 1];
        if (last && last.role !== 'user') {
          state.turns = t.map((m) => ({ role: m.role, text: m.text ?? '' }));
          draw(); break;
        }
      }
      state.busy = false;
    };
    sendBtn.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
    input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 170) + 'px'; };

    draw();
    el.appendChild(root);
    return undefined;
  };
  return { render };
})();
