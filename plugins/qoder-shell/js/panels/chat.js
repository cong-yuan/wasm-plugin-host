// The main pane: a Qoder-flavoured chat over the dsh agent loop.
//
// It is genuinely live — it creates a real agent through the backend and streams
// its transcript — so the shell is a working front end, not a mock-up.
return (function () {
  const { h, sv, muted } = studio.require('lib/dom');
  const api = studio.require('lib/api');

  const render = (el) => {
    const state = { agentId: null, turns: [], busy: false };

    const wrap = h('div', { style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
    const stream = h('div', {
      style: 'flex:1;overflow-y:auto;padding:20px 26px;display:flex;flex-direction:column;gap:14px',
    });
    wrap.appendChild(stream);

    const draw = () => {
      stream.replaceChildren();
      if (!state.turns.length) {
        stream.appendChild(h('div', { style: 'margin:auto;text-align:center;max-width:44ch;color:' + sv('text-tertiary') },
          h('div', { style: 'font-size:15px;margin-bottom:6px;color:' + sv('text-secondary') },
            'Agent workbench'),
          h('div', { style: 'font-size:13px;line-height:1.6' },
            'Ask anything. The first message creates a real dsh agent and streams its reply here.'),
        ));
        return;
      }
      for (const t of state.turns) {
        const mine = t.role === 'user';
        stream.appendChild(h('div', {
          style: 'display:flex;gap:10px;' + (mine ? 'justify-content:flex-end' : ''),
        },
          h('div', {
            style:
              'max-width:76%;padding:9px 12px;border-radius:8px;font-size:13px;line-height:1.65;' +
              'white-space:pre-wrap;word-break:break-word;' +
              (mine
                ? 'background:' + sv('primary-bg') + ';border:1px solid ' + sv('primary-border') + ';'
                : 'background:' + sv('fill-secondary') + ';'),
          }, t.text),
        ));
      }
      stream.scrollTop = stream.scrollHeight;
    };

    const input = h('textarea', {
      rows: 1,
      placeholder: 'Ask a question…  (Enter to send, Shift+Enter for a newline)',
      style:
        'flex:1;resize:none;border:0;outline:none;background:transparent;font:inherit;' +
        'font-size:13px;line-height:1.5;color:' + sv('text') + ';max-height:180px',
    });
    const send = h('button', {
      text: 'Send',
      style:
        'padding:6px 14px;border-radius:6px;border:1px solid ' + sv('primary') + ';' +
        'background:' + sv('primary') + ';color:' + sv('text-on-primary') + ';' +
        'font:inherit;font-size:12px;cursor:pointer',
    });
    const composer = h('div', {
      style:
        'margin:0 20px 18px;padding:10px 12px;border:1px solid ' + sv('border') + ';' +
        'border-radius:10px;background:' + sv('bg-elevated') +
        ';display:flex;align-items:flex-end;gap:10px',
    }, input, send);
    wrap.appendChild(composer);

    const submit = async () => {
      const text = input.value.trim();
      if (!text || state.busy) return;
      state.busy = true;
      state.turns.push({ role: 'user', text });
      input.value = '';
      draw();

      if (!state.agentId) {
        // Returns the id as a plain string, or null if the call failed.
        const a = await api.createAgent('mock', 'mock-1');
        state.agentId = typeof a === 'string' && a ? a : (a && a.id) || null;
        if (!state.agentId) {
          state.turns.push({ role: 'agent', text: 'Could not create an agent. Is the harness online?' });
          state.busy = false; draw(); return;
        }
      }
      await api.send(state.agentId, text, 'm' + state.turns.length);
      // Poll the transcript: the backend streams turns, it does not push them
      // to a plugin that has not subscribed to events.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 350));
        const t = await api.transcript(state.agentId);
        const last = t && t[t.length - 1];
        // `ChatMessage` carries `text` (and separate `reasoning`/`tool_calls`);
        // there is no `content` field.
        if (last && last.role !== 'user') {
          state.turns = t.map((m) => ({ role: m.role, text: m.text ?? '' }));
          draw();
          break;
        }
      }
      state.busy = false;
    };
    send.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    };
    input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; };

    draw();
    el.appendChild(wrap);
  };

  return { render };
})();
