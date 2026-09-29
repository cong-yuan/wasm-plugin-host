return (function () {
  const { h } = studio.require('lib/dom');
  const sessionSearch = studio.require('lib/session-search');
  const sessionRow = studio.require('lib/session-row');

  const highlighted = (tag, className, text, query) => {
    const parts = sessionSearch.highlightParts(text, query);
    if (!parts.match) return h(tag, { class: className }, parts.before);
    return h(tag, { class: className },
      parts.before,
      h('mark', { class: 'sessionSearchHighlight' }, parts.match),
      parts.after);
  };

  const title = (text, query) => highlighted('span', 'sessionItemTitle', text, query);
  const snippet = (text, query) => highlighted('div', 'sessionSearchSnippet', text, query);

  const status = (runtime, state) => {
    if (runtime.toolCount > 0) {
      return h('span', {
        class: 'sessionToolCount',
        title: `${runtime.toolCount} active tool${runtime.toolCount === 1 ? '' : 's'}`,
      }, String(runtime.toolCount));
    }
    return runtime.error
      ? h('span', { class: 'sessionErrorDot', title: state?.error || 'Session error' })
      : null;
  };

  const runtimeButton = (runtime) => runtime.running
    ? h('button', { class: 'sessionStopBtn', type: 'button', title: 'Stop session' }, '■')
    : runtime.error
      ? h('button', { class: 'sessionRetryBtn', type: 'button', title: 'Retry session' }, '↻')
      : null;

  const detailsButton = (expanded) => h('button', {
    class: 'sessionDetailsBtn',
    type: 'button',
    title: expanded ? 'Hide session details' : 'Show session details',
    'aria-expanded': expanded ? 'true' : 'false',
    'aria-label': expanded ? 'Hide session details' : 'Show session details',
  }, expanded ? '⌃' : '…');

  const selectionBox = (session, checked) => {
    const node = h('input', {
      class: 'sessionSelectBox',
      type: 'checkbox',
      'aria-label': `Select ${session.title || 'session'}`,
    });
    node.checked = !!checked;
    return node;
  };

  const shell = ({
    session,
    selected,
    keyboardId,
    archived,
    runtime,
    expanded,
    selectBox,
    titleNode,
    statusNode,
    runtimeAction,
    rowActions,
  }) => h('div', {
    class: 'sessionItem sessionItemSingleLine'
      + (selected === session.id ? ' sessionItemActive' : '')
      + (keyboardId === session.id ? ' sessionItemKeyboard' : ''),
    role: 'button',
    tabindex: '0',
    'aria-selected': selected === session.id ? 'true' : 'false',
    'aria-expanded': expanded ? 'true' : 'false',
    ...(session.pinnedAt ? { 'data-pinned': 'true' } : {}),
    'data-session-id': session.id,
    ...(archived ? { 'data-archived': 'true' } : {}),
    ...(runtime.error ? { 'data-runtime-state': 'error' } : runtime.running ? { 'data-runtime-state': 'running' } : {}),
  }, h('div', { class: 'sessionItemHeader' },
    selectBox,
    runtime.running ? h('span', { class: 'sessionStreamingDot', 'data-state': 'running' }) : null,
    titleNode,
    statusNode,
    runtimeAction,
    rowActions));

  const appendContext = (row, session, state, runtime, archived, expanded, query) => {
    row.appendChild(h('div', { class: 'sessionItemMeta' },
      sessionRow.metaText(session, runtime, archived)));
    if (expanded) {
      const panel = h('div', { class: 'sessionDetailsPanel' });
      for (const [label, value] of sessionRow.detailEntries(session, state, runtime, archived)) {
        panel.appendChild(h('div', { class: 'sessionDetailsLine' },
          h('span', { class: 'sessionDetailsLabel' }, label),
          h('span', { class: 'sessionDetailsValue' }, String(value))));
      }
      row.appendChild(panel);
    }
    if (session.searchSnippet) row.appendChild(snippet(session.searchSnippet, query));
  };

  return {
    title,
    snippet,
    status,
    runtimeButton,
    detailsButton,
    selectionBox,
    shell,
    appendContext,
  };
})();