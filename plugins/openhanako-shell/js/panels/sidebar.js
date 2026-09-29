// DOM ported verbatim from openhanako (Apache-2.0):
// desktop/src/react/components/app/ChatSidebar.tsx + components/SessionList.tsx
return (function () {
  const { h, svg, clear } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const api = studio.require('lib/api');
  const adapter = studio.require('lib/hana-adapter');
  const { t } = studio.require('lib/i18n');

  // Upstream icon markup, copied unchanged.
  const ICON = {
    newChat: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
    settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    collapse: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"></polyline></svg>',
    bridge: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
    activity: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>',
    automation: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
    skills: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  };

  function render(options) {
    const view = { archived: false, query: '', searchVersion: 0 };
    const add = h('button', { class: 'sidebar-action-btn', title: t('sidebar.newChat') }, svg(ICON.newChat));
    const settings = h('button', { class: 'sidebar-action-btn', title: t('settings.title') }, svg(ICON.settings));
    const collapse = h('button', { class: 'sidebar-action-btn', title: t('sidebar.collapse') }, svg(ICON.collapse));
    add.onclick = options.onNew;
    collapse.onclick = options.onCollapse;

    const actions = h('div', { class: 'sidebar-header-actions' }, add, settings, collapse);
    slots.mount('openhanako.sidebar.header', actions);

    const header = h('div', { class: 'sidebar-header' },
      h('span', { class: 'sidebar-title' }, t('sidebar.title')), actions);

    // Upstream renders the activity bars as flat siblings (no wrapper div).
    const bridgeStatus = h('span', { class: 'sidebar-bridge-status' }, '');
    const bridgeDot = h('span', { class: 'sidebar-bridge-dot connected' });
    const bridge = h('button', { class: 'sidebar-activity-bar sidebar-bridge-card', type: 'button' },
      svg(ICON.bridge), h('span', {}, t('sidebar.bridgeShort')),
      bridgeStatus, bridgeDot);
    bridge.title = 'Refresh agent runtime state';
    const activity = h('button', { class: 'sidebar-activity-bar', type: 'button' },
      svg(ICON.activity), h('span', {}, t('sidebar.activity')));
    const automation = h('button', { class: 'sidebar-activity-bar', type: 'button' },
      svg(ICON.automation), h('span', {}, t('automation.title')),
      h('span', { class: 'automation-count-badge' }, ''));
    const skills = h('button', { class: 'sidebar-activity-bar', type: 'button' },
      svg(ICON.skills), h('span', {}, t('skills.panel.title')));

    const activities = h('div', { class: 'hana-slot sidebar-activities-slot' });
    slots.mount('openhanako.sidebar.activities', activities);

    const search = h('input', {
      class: 'sessionSearchInput', type: 'search', placeholder: 'Search sessions…', 'aria-label': 'Search sessions',
    });
    const activeView = h('button', { class: 'sessionViewBtn active', type: 'button' }, 'Active');
    const archivedView = h('button', { class: 'sessionViewBtn', type: 'button' }, 'Archived');
    const viewToggle = h('div', { class: 'sessionViewToggle' }, activeView, archivedView);
    const searchStatus = h('div', { class: 'sessionSearchStatus', 'aria-live': 'polite' }, '');
    const actionStatus = h('div', { class: 'sessionActionStatus', 'aria-live': 'polite' }, '');
    const sessionControls = h('div', { class: 'sessionListControls' }, search, viewToggle, searchStatus, actionStatus);
    let actionStatusTimer = null;
    const reportAction = (message, isError = false) => {
      if (actionStatusTimer) clearTimeout(actionStatusTimer);
      actionStatus.textContent = message || '';
      actionStatus.className = 'sessionActionStatus' + (isError ? ' error' : '');
      if (message) {
        actionStatusTimer = setTimeout(() => {
          actionStatus.textContent = '';
          actionStatus.className = 'sessionActionStatus';
        }, 2600);
      }
    };

    // Upstream: <div className="session-list"><SessionList /><SidebarNoticeSlot /></div>
    const scroller = h('div', { class: 'sessionListScroller' });
    const notice = h('div', { class: 'hana-slot sidebar-notice-slot' });
    slots.mount('openhanako.sidebar.notice', notice);
    const list = h('div', { class: 'session-list' }, sessionControls, scroller, notice);
    slots.mount('openhanako.sidebar.sessions', list);

    const footer = h('div', { class: 'hana-slot sidebar-footer-slot' });
    slots.mount('openhanako.sidebar.footer', footer);

    const content = h('div', { class: 'sidebar-chat-content' },
      header, bridge, activity, automation, skills, activities, list, footer);

    const root = h('aside', { class: 'sidebar', id: 'sidebar' },
      h('div', { class: 'sidebar-inner' }, content),
      h('div', { class: 'resize-handle resize-handle-right', id: 'sidebarResizeHandle' }));

    async function draw(selected) {
      const [activeRows, archivedRows, runtime] = await Promise.all([
        adapter.http('GET', '/api/sessions').catch(async () => (await api.sessions()).map((row) => ({
          sessionId: row.id, title: row.title, busy: row.busy, live: row.live,
          status: row.status, error: row.error, pinnedAt: null, pinOrder: null,
        }))),
        view.archived ? adapter.http('GET', '/api/sessions/archived').catch(() => []) : Promise.resolve([]),
        adapter.http('GET', '/api/runtime-state').catch(() => ({ mode: api.mode(), sessions: [] })),
      ]);
      const rawQuery = view.query.trim();
      const query = rawQuery.toLocaleLowerCase();
      const allRows = (view.archived ? archivedRows : activeRows).map((row) => ({
        ...row, id: row.sessionId || row.id,
      }));
      allRows.sort((a, b) => {
        if (view.archived) return String(b.archivedAt || '').localeCompare(String(a.archivedAt || ''));
        const ap = !!a.pinnedAt;
        const bp = !!b.pinnedAt;
        if (ap !== bp) return ap ? -1 : 1;
        if (ap && bp) {
          const ao = Number.isFinite(a.pinOrder) ? a.pinOrder : Number.MAX_SAFE_INTEGER;
          const bo = Number.isFinite(b.pinOrder) ? b.pinOrder : Number.MAX_SAFE_INTEGER;
          if (ao !== bo) return ao - bo;
        }
        return String(b.modified || b.updated_at || '').localeCompare(String(a.modified || a.updated_at || ''));
      });
      let rows = allRows.filter((row) => !query
        || `${row.title || ''} ${row.sessionId || row.id || ''}`.toLocaleLowerCase().includes(query));
      if (query && !view.archived) {
        const mySearchVersion = ++view.searchVersion;
        searchStatus.textContent = 'Searching titles and messages…';
        try {
          const encoded = encodeURIComponent(rawQuery);
          const [titleData, contentData] = await Promise.all([
            adapter.http('GET', `/api/sessions/search?q=${encoded}&phase=title&limit=20`),
            adapter.http('GET', `/api/sessions/search?q=${encoded}&phase=content&limit=20`),
          ]);
          if (mySearchVersion !== view.searchVersion) return;
          const merged = new Map();
          for (const result of [...(titleData?.results || []), ...(contentData?.results || [])]) {
            const id = result.sessionId || result.id;
            if (!id) continue;
            const existing = merged.get(id);
            merged.set(id, {
              ...(existing || result),
              ...result,
              id,
              title: result.title || existing?.title || null,
              searchSnippet: result.matchKind === 'content' && result.snippet
                ? result.snippet
                : existing?.searchSnippet || '',
              searchMatchKind: result.matchKind || existing?.searchMatchKind || null,
            });
          }
          rows = Array.from(merged.values());
          searchStatus.textContent = rows.length
            ? `${rows.length} result${rows.length === 1 ? '' : 's'} · title + message search`
            : 'No title or message matches';
        } catch {
          searchStatus.textContent = 'Message search unavailable · showing local title matches';
        }
      } else {
        view.searchVersion += 1;
        searchStatus.textContent = query && view.archived
          ? 'Archived search matches title and session ID'
          : '';
      }

      const runtimeById = new Map((runtime.sessions || []).map((state) => [state.sessionId, state]));
      const runtimeRows = Array.from(runtimeById.values());
      const errorCount = runtimeRows.filter((state) => state.status === 'error').length;
      const runningCount = runtimeRows.filter((state) => state.status === 'running' || state.isStreaming).length;
      bridgeStatus.textContent = errorCount
        ? `${errorCount} error${errorCount === 1 ? '' : 's'}`
        : runningCount ? `${runningCount} running` : (runtime.mode === 'mock' ? 'Mock' : 'Connected');
      bridgeDot.className = 'sidebar-bridge-dot' + (errorCount ? ' error' : runningCount ? ' running' : ' connected');
      activeView.className = 'sessionViewBtn' + (view.archived ? '' : ' active');
      archivedView.className = 'sessionViewBtn' + (view.archived ? ' active' : '');

      clear(scroller);
      if (!rows.length) {
        scroller.appendChild(h('div', { class: 'sessionEmpty' },
          query ? 'No matching sessions' : view.archived ? 'No archived sessions' : t('sidebar.empty')));
        return;
      }

      const pinnedIds = allRows.filter((row) => !!row.pinnedAt).map((row) => row.id);
      rows.forEach((s) => {
        const state = runtimeById.get(s.id) || null;
        const isRunning = !view.archived && !!(s.busy || state?.isStreaming || state?.status === 'running');
        const isError = !view.archived && (state?.status === 'error' || !!state?.error);
        const toolCount = Number(state?.activeToolCount) || 0;
        const statusNode = toolCount > 0
          ? h('span', { class: 'sessionToolCount', title: `${toolCount} active tool${toolCount === 1 ? '' : 's'}` }, String(toolCount))
          : isError ? h('span', { class: 'sessionErrorDot', title: state?.error || 'Session error' }) : null;
        const runtimeAction = isRunning
          ? h('button', { class: 'sessionStopBtn', type: 'button', title: 'Stop session' }, '■')
          : isError ? h('button', { class: 'sessionRetryBtn', type: 'button', title: 'Retry session' }, '↻') : null;
        const rowActions = h('span', { class: 'sessionItemActions' });

        if (view.archived) {
          const restore = h('button', { class: 'sessionRestoreBtn', type: 'button', title: 'Restore session' }, '↩');
          restore.onclick = async (event) => {
            event?.stopPropagation?.();
            reportAction('Restoring session…');
            try {
              const result = await adapter.http('POST', '/api/sessions/restore', { sessionId: s.id, path: s.path });
              if (!result || result.ok === false || result.error) {
                reportAction(result?.error || 'Restore failed', true);
                return;
              }
              reportAction('Session restored');
              view.archived = false;
              view.query = '';
              search.value = '';
              await draw(result.sessionId || selected);
            } catch (err) {
              reportAction(err?.message || 'Restore failed', true);
            }
          };
          rowActions.appendChild(restore);
        } else {
          const pin = h('button', {
            class: 'sessionPinBtn' + (s.pinnedAt ? ' active' : ''),
            type: 'button', title: s.pinnedAt ? 'Unpin session' : 'Pin session',
          }, s.pinnedAt ? '★' : '☆');
          pin.onclick = async (event) => {
            event?.stopPropagation?.();
            const nextPinned = !s.pinnedAt;
            reportAction(nextPinned ? 'Pinning session…' : 'Unpinning session…');
            try {
              const result = await adapter.http('POST', '/api/sessions/pin', { sessionId: s.id, pinned: nextPinned });
              if (!result || result.ok === false || result.error) {
                reportAction(result?.error || 'Pin update failed', true);
                return;
              }
              reportAction(nextPinned ? 'Session pinned' : 'Session unpinned');
              await draw(selected);
            } catch (err) {
              reportAction(err?.message || 'Pin update failed', true);
            }
          };
          rowActions.appendChild(pin);

          if (s.pinnedAt && pinnedIds.length > 1) {
            const index = pinnedIds.indexOf(s.id);
            const up = h('button', { class: 'sessionPinMoveBtn', type: 'button', title: 'Move pinned session up' }, '↑');
            const down = h('button', { class: 'sessionPinMoveBtn', type: 'button', title: 'Move pinned session down' }, '↓');
            up.disabled = index <= 0;
            down.disabled = index < 0 || index >= pinnedIds.length - 1;
            const move = async (delta, event) => {
              event?.stopPropagation?.();
              const next = pinnedIds.slice();
              const target = index + delta;
              if (target < 0 || target >= next.length) return;
              [next[index], next[target]] = [next[target], next[index]];
              reportAction('Updating pinned order…');
              const result = await adapter.http('POST', '/api/sessions/pin-order', { sessionIds: next });
              if (!result || result.ok === false || result.error) {
                reportAction(result?.error || 'Pinned order update failed', true);
                return;
              }
              reportAction('Pinned order updated');
              await draw(selected);
            };
            up.onclick = (event) => move(-1, event);
            down.onclick = (event) => move(1, event);
            rowActions.appendChild(up);
            rowActions.appendChild(down);
          }

          const archive = h('button', { class: 'sessionArchiveBtn', type: 'button', title: 'Archive session' }, '×');
          archive.onclick = async (event) => {
            event?.stopPropagation?.();
            reportAction('Archiving session…');
            try {
              const result = await adapter.http('POST', '/api/sessions/archive', { sessionId: s.id });
              if (!result || result.ok === false || result.error) {
                reportAction(result?.error || 'Archive failed', true);
                return;
              }
              reportAction('Session archived');
              if (selected === s.id) options.onNew();
              else await draw(selected);
            } catch (err) {
              reportAction(err?.message || 'Archive failed', true);
            }
          };
          rowActions.appendChild(archive);
        }

        const row = h('div', {
          class: 'sessionItem sessionItemSingleLine' + (selected === s.id ? ' sessionItemActive' : ''),
          role: 'button', tabindex: '0',
          ...(s.pinnedAt ? { 'data-pinned': 'true' } : {}),
          ...(view.archived ? { 'data-archived': 'true' } : {}),
          ...(isError ? { 'data-runtime-state': 'error' } : isRunning ? { 'data-runtime-state': 'running' } : {}),
        }, h('div', { class: 'sessionItemHeader' },
          isRunning ? h('span', { class: 'sessionStreamingDot', 'data-state': 'running' }) : null,
          h('span', { class: 'sessionItemTitle' }, s.title || t('session.untitled')),
          statusNode, runtimeAction, rowActions));
        const details = [];
        if (view.archived) details.push('Archived');
        else if (isRunning) details.push('Running');
        else if (isError) details.push('Error');
        else details.push('Idle');
        const messageCount = Number(s.messageCount ?? s.messages);
        if (Number.isFinite(messageCount) && messageCount > 0) {
          details.push(`${messageCount} message${messageCount === 1 ? '' : 's'}`);
        }
        if (s.modelId) details.push(String(s.modelId));
        row.appendChild(h('div', { class: 'sessionItemMeta' }, details.join(' · ')));
        if (s.searchSnippet) {
          row.appendChild(h('div', { class: 'sessionSearchSnippet' }, s.searchSnippet));
        }

        if (runtimeAction) {
          runtimeAction.onclick = async (event) => {
            event?.stopPropagation?.();
            if (isRunning) {
              reportAction('Stopping session…');
              try {
                await api.cancel(s.id);
                reportAction('Stop requested');
                await draw(selected);
              } catch (err) {
                reportAction(err?.message || 'Stop failed', true);
              }
            } else if (typeof options.onRetry === 'function') options.onRetry(s);
            else options.onSelect(s);
          };
        }
        if (!view.archived) row.onclick = () => options.onSelect(s);
        scroller.appendChild(row);
      });
    }
    search.oninput = (event) => {
      view.query = event?.target?.value || '';
      draw(options.selected);
    };
    activeView.onclick = () => {
      view.archived = false;
      draw(options.selected);
    };
    archivedView.onclick = () => {
      view.archived = true;
      draw(options.selected);
    };
    draw(options.selected);
    bridge.onclick = () => draw(options.selected);
    return { root, refresh: draw };
  }
  return { render };
})();
