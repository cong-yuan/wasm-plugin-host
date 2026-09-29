// DOM ported verbatim from openhanako (Apache-2.0):
// desktop/src/react/components/app/ChatSidebar.tsx + components/SessionList.tsx
return (function () {
  const { h, svg, clear } = studio.require('lib/dom');
  const slots = studio.require('lib/slots');
  const api = studio.require('lib/api');
  const adapter = studio.require('lib/hana-adapter');
  const sessionSearch = studio.require('lib/session-search');
  const sessionSearchController = studio.require('lib/session-search-controller');
  const sessionBulk = studio.require('lib/session-bulk');
  const sessionRuntime = studio.require('lib/session-runtime');
  const sessionRow = studio.require('lib/session-row');
  const sessionRowView = studio.require('lib/session-row-view');
  const sessionActionLock = studio.require('lib/session-action-lock');
  const sessionMutations = studio.require('lib/session-mutations');
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
    const view = { archived: false, query: '', searchVersion: 0, expanded: new Set(), selectedIds: new Set(), visibleIds: [], keyboardId: null, renamingId: null, deleteConfirmId: null, bulkDeleteArmed: false };
    const searchController = sessionSearchController.create({ adapter, ttlMs: 15000, maxEntries: 20 });
    const actionLock = sessionActionLock.create();
    const mutations = sessionMutations.create({ adapter, api });
    let searchTimer = null;
    let lastRuntimeSignature = '';
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
    const skills = h('button', {
      class: 'sidebar-activity-bar sidebar-skills-button',
      type: 'button',
      'aria-expanded': 'false',
    }, svg(ICON.skills), h('span', {}, t('skills.panel.title')));
    const skillsPanel = h('div', {
      class: 'sidebarSkillsPanel',
      role: 'region',
      'aria-label': t('skills.panel.title'),
    });
    skillsPanel.style.display = 'none';

    const activities = h('div', { class: 'hana-slot sidebar-activities-slot' });
    slots.mount('openhanako.sidebar.activities', activities);

    const search = h('input', {
      class: 'sessionSearchInput', type: 'search', placeholder: 'Search sessions…', 'aria-label': 'Search sessions',
    });
    const activeView = h('button', { class: 'sessionViewBtn active', type: 'button', 'aria-pressed': 'true' }, 'Active');
    const archivedView = h('button', { class: 'sessionViewBtn', type: 'button', 'aria-pressed': 'false' }, 'Archived');
    const viewToggle = h('div', { class: 'sessionViewToggle' }, activeView, archivedView);
    const searchStatus = h('div', { class: 'sessionSearchStatus', 'aria-live': 'polite' }, '');
    const actionStatusText = h('span', { class: 'sessionActionStatusText' }, '');
    const actionRetry = h('button', { class: 'sessionActionRetry', type: 'button' }, 'Retry');
    actionRetry.style.display = 'none';
    const actionStatus = h('div', { class: 'sessionActionStatus', 'aria-live': 'polite' }, actionStatusText, actionRetry);
    const bulkCount = h('span', { class: 'sessionBulkCount', 'aria-live': 'polite' }, '');
    const bulkSelectVisible = h('button', { class: 'sessionBulkSelectVisible', type: 'button' }, 'Select visible');
    const bulkPrimary = h('button', { class: 'sessionBulkPrimary', type: 'button' }, 'Archive selected');
    const bulkDelete = h('button', { class: 'sessionBulkDelete', type: 'button' }, 'Delete selected');
    const bulkClear = h('button', { class: 'sessionBulkClear', type: 'button' }, 'Clear');
    const bulkBar = h('div', { class: 'sessionBulkBar' }, bulkCount, bulkSelectVisible, bulkPrimary, bulkDelete, bulkClear);
    bulkBar.style.display = '';
    const sessionControls = h('div', { class: 'sessionListControls' }, search, viewToggle, searchStatus, actionStatus, bulkBar);
    let actionStatusTimer = null;
    const reportAction = (message, isError = false, retry = null) => {
      if (actionStatusTimer) clearTimeout(actionStatusTimer);
      actionStatusText.textContent = message || '';
      actionStatus.className = 'sessionActionStatus' + (isError ? ' error' : '');
      actionRetry.style.display = typeof retry === 'function' ? '' : 'none';
      actionRetry.onclick = typeof retry === 'function' ? retry : null;
      if (message && !retry) {
        actionStatusTimer = setTimeout(() => {
          actionStatusText.textContent = '';
          actionStatus.className = 'sessionActionStatus';
          actionRetry.style.display = 'none';
          actionRetry.onclick = null;
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
      header, bridge, activity, automation, skills, skillsPanel, activities, list, footer);

    const root = h('aside', { class: 'sidebar', id: 'sidebar' },
      h('div', { class: 'sidebar-inner' }, content),
      h('div', { class: 'resize-handle resize-handle-right', id: 'sidebarResizeHandle' }));

    let skillsLoaded = false;
    let skillsLoading = false;
    const renderSkillsPanel = (plugins, tools) => {
      clear(skillsPanel);
      const pluginRows = Array.from(plugins || []);
      const toolRows = Array.from(tools || []);
      const summary = h('div', { class: 'sidebarSkillsSummary' },
        `${pluginRows.length} plugin${pluginRows.length === 1 ? '' : 's'} · ${toolRows.length} tool${toolRows.length === 1 ? '' : 's'}`);
      skillsPanel.appendChild(summary);

      const appendSection = (title, rows, kind) => {
        const section = h('div', { class: 'sidebarSkillsSection' },
          h('div', { class: 'sidebarSkillsSectionTitle' }, title));
        if (!rows.length) {
          section.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, `No ${kind}s available`));
        } else {
          rows.forEach((row) => {
            const name = String(row?.name || row?.id || kind);
            const description = row?.description || row?.state || '';
            section.appendChild(h('div', { class: 'sidebarSkillsItem', 'data-kind': kind },
              h('span', { class: 'sidebarSkillsItemName' }, name),
              description ? h('span', { class: 'sidebarSkillsItemDescription' }, String(description)) : null));
          });
        }
        skillsPanel.appendChild(section);
      };

      appendSection('Plugins', pluginRows, 'plugin');
      appendSection('Tools', toolRows, 'tool');
    };

    const loadSkillsPanel = async () => {
      if (skillsLoading) return;
      skillsLoading = true;
      clear(skillsPanel);
      skillsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'Loading capabilities…'));
      try {
        const [plugins, tools] = await Promise.all([api.plugins(), api.tools()]);
        renderSkillsPanel(plugins, tools);
        skillsLoaded = true;
      } catch (err) {
        clear(skillsPanel);
        skillsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty error' },
          err?.message || 'Unable to load capabilities'));
      } finally {
        skillsLoading = false;
      }
    };

    skills.onclick = async () => {
      const opening = skillsPanel.style.display === 'none';
      skillsPanel.style.display = opening ? '' : 'none';
      skills.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening && !skillsLoaded) await loadSkillsPanel();
    };

    const updateBridgeStatus = (runtime) => {
      const summary = sessionRuntime.summarize(runtime);
      bridgeStatus.textContent = summary.text;
      bridgeDot.className = 'sidebar-bridge-dot ' + summary.state;
    };

    const refreshBulkBar = () => {
      const count = view.selectedIds.size;
      bulkBar.style.display = '';
      bulkCount.textContent = count ? `${count} selected` : `${view.visibleIds.length || 0} visible`;
      bulkPrimary.textContent = view.archived ? 'Restore selected' : 'Archive selected';
      bulkPrimary.style.display = count ? '' : 'none';
      bulkClear.style.display = count ? '' : 'none';
      bulkDelete.style.display = view.archived && count ? '' : 'none';
      bulkSelectVisible.textContent = view.visibleIds.length > 0
        && view.visibleIds.every((id) => view.selectedIds.has(id))
        ? 'Clear visible' : 'Select visible';
      bulkDelete.textContent = view.bulkDeleteArmed ? 'Confirm delete' : 'Delete selected';
    };

    bulkSelectVisible.onclick = () => {
      view.selectedIds = sessionBulk.toggleVisible(view.selectedIds, view.visibleIds);
      view.bulkDeleteArmed = false;
      refreshBulkBar();
      draw(options.selected);
    };

    bulkClear.onclick = () => {
      view.selectedIds.clear();
      view.bulkDeleteArmed = false;
      refreshBulkBar();
      draw(options.selected);
    };

    bulkPrimary.onclick = async () => actionLock.run('bulk:primary', async () => {
      const ids = Array.from(view.selectedIds);
      if (!ids.length) return;
      bulkPrimary.disabled = true;
      const operation = view.archived ? 'Restoring' : 'Archiving';
      reportAction(`${operation} ${ids.length} sessions…`);
      try {
        const { completed, failed } = await sessionBulk.runBatch(ids, (sessionId) =>
          adapter.http('POST', view.archived ? '/api/sessions/restore' : '/api/sessions/archive', { sessionId }));
        view.selectedIds = new Set(failed);
        refreshBulkBar();
        if (failed.length) {
          reportAction(`${completed} completed · ${failed.length} failed`, true, () => bulkPrimary.onclick());
        } else {
          reportAction(`${completed} sessions ${view.archived ? 'restored' : 'archived'}`);
        }
        await draw(options.selected);
      } finally {
        bulkPrimary.disabled = false;
      }
    });


    bulkDelete.onclick = async () => actionLock.run('bulk:delete', async () => {
      const ids = Array.from(view.selectedIds);
      if (!view.archived || !ids.length) return;
      if (!view.bulkDeleteArmed) {
        view.bulkDeleteArmed = true;
        refreshBulkBar();
        reportAction(`Confirm permanent deletion of ${ids.length} archived session${ids.length === 1 ? '' : 's'}`);
        return;
      }
      bulkDelete.disabled = true;
      reportAction(`Deleting ${ids.length} archived sessions…`);
      try {
        const { completed, failed } = await sessionBulk.runBatch(ids, (sessionId) =>
          adapter.http('POST', '/api/sessions/archived/delete', { sessionId }));
        view.selectedIds = new Set(failed);
        view.bulkDeleteArmed = false;
        refreshBulkBar();
        if (failed.length) {
          reportAction(`${completed} deleted · ${failed.length} failed`, true, () => bulkDelete.onclick());
        } else {
          reportAction(`${completed} archived sessions permanently deleted`);
        }
        await draw(options.selected);
      } finally {
        bulkDelete.disabled = false;
      }
    });

    async function draw(selected, runtimeOverride = null) {
      const [activeRows, archivedRows, runtime] = await Promise.all([
        adapter.http('GET', '/api/sessions').catch(async () => (await api.sessions()).map((row) => ({
          sessionId: row.id, title: row.title, busy: row.busy, live: row.live,
          status: row.status, error: row.error, pinnedAt: null, pinOrder: null,
        }))),
        view.archived ? adapter.http('GET', '/api/sessions/archived').catch(() => []) : Promise.resolve([]),
        runtimeOverride
          ? Promise.resolve(runtimeOverride)
          : adapter.http('GET', '/api/runtime-state').catch(() => ({ mode: api.mode(), sessions: [] })),
      ]);
      const rawQuery = view.query.trim();
      const query = rawQuery.toLocaleLowerCase();
      const allRows = sessionSearch.sortRows(view.archived ? archivedRows : activeRows, view.archived);
      let rows = sessionSearch.localFilter(allRows, query);
      if (query && !view.archived) {
        const mySearchVersion = ++view.searchVersion;
        searchStatus.textContent = 'Searching titles and messages…';
        try {
          const result = await searchController.search(rawQuery);
          if (mySearchVersion !== view.searchVersion) return;
          rows = result.rows;
          searchStatus.textContent = rows.length
            ? `${rows.length} result${rows.length === 1 ? '' : 's'} · ${result.cached ? 'cached ' : ''}title + message search`
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
      lastRuntimeSignature = sessionRuntime.signature(runtime);
      updateBridgeStatus(runtime);
      activeView.className = 'sessionViewBtn' + (view.archived ? '' : ' active');
      archivedView.className = 'sessionViewBtn' + (view.archived ? ' active' : '');
      activeView.setAttribute('aria-pressed', view.archived ? 'false' : 'true');
      archivedView.setAttribute('aria-pressed', view.archived ? 'true' : 'false');
      view.selectedIds = sessionBulk.pruneSelection(view.selectedIds, allRows.map((row) => row.id));
      refreshBulkBar();

      clear(scroller);
      if (!rows.length) {
        scroller.appendChild(h('div', { class: 'sessionEmpty' },
          query ? 'No matching sessions' : view.archived ? 'No archived sessions' : t('sidebar.empty')));
        return;
      }
      view.visibleIds = rows.map((row) => row.id);
      refreshBulkBar();

      const pinnedIds = allRows.filter((row) => !!row.pinnedAt).map((row) => row.id);
      rows.forEach((s) => {
        const state = runtimeById.get(s.id) || null;
        const rowRuntime = sessionRow.deriveRuntime(s, state, view.archived);
        const { running: isRunning, error: isError, toolCount } = rowRuntime;
        const statusNode = sessionRowView.status(rowRuntime, state);
        const runtimeAction = sessionRowView.runtimeButton(rowRuntime);
        const rowActions = h('span', { class: 'sessionItemActions' });
        const selectBox = sessionRowView.selectionBox(s, view.selectedIds.has(s.id));
        selectBox.onclick = (event) => {
          event?.stopPropagation?.();
          if (selectBox.checked) view.selectedIds.add(s.id);
          else view.selectedIds.delete(s.id);
          refreshBulkBar();
        };

        const rename = h('button', { class: 'sessionRenameBtn', type: 'button', title: 'Rename session' }, '✎');
        rename.onclick = (event) => {
          event?.stopPropagation?.();
          view.renamingId = s.id;
          draw(selected);
        };
        rowActions.appendChild(rename);

        if (view.archived) {
          const restore = h('button', { class: 'sessionRestoreBtn', type: 'button', title: 'Restore session' }, '↩');
          restore.onclick = async (event) => {
            event?.stopPropagation?.();
            await actionLock.run(`${s.id}:restore`, async () => {
              restore.disabled = true;
              reportAction('Restoring session…');
              try {
                const result = await mutations.restore(s);
                reportAction('Session restored');
                view.archived = false;
                view.query = '';
                search.value = '';
                await draw(result.sessionId || selected);
              } catch (err) {
                reportAction(err?.message || 'Restore failed', true, () => restore.onclick({ stopPropagation() {} }));
              } finally {
                restore.disabled = false;
              }
            });
          };
          rowActions.appendChild(restore);
          const deleting = view.deleteConfirmId === s.id;
          const remove = h('button', {
            class: 'sessionDeleteBtn' + (deleting ? ' confirm' : ''),
            type: 'button',
            title: deleting ? 'Click again to permanently delete' : 'Permanently delete archived session',
          }, deleting ? 'Delete' : '⌫');
          remove.onclick = async (event) => {
            event?.stopPropagation?.();
            if (!deleting) {
              view.deleteConfirmId = s.id;
              reportAction('Click Delete again to permanently remove this session');
              await draw(selected);
              return;
            }
            await actionLock.run(`${s.id}:delete`, async () => {
              remove.disabled = true;
              reportAction('Deleting archived session…');
              try {
                await mutations.deleteArchived(s);
                view.deleteConfirmId = null;
                view.expanded.delete(s.id);
                reportAction('Archived session permanently deleted');
                await draw(selected);
              } catch (err) {
                reportAction(err?.message || 'Delete failed', true, () => remove.onclick({ stopPropagation() {} }));
              } finally {
                remove.disabled = false;
              }
            });
          };
          rowActions.appendChild(remove);
        } else {
          const pin = h('button', {
            class: 'sessionPinBtn' + (s.pinnedAt ? ' active' : ''),
            type: 'button', title: s.pinnedAt ? 'Unpin session' : 'Pin session',
          }, s.pinnedAt ? '★' : '☆');
          pin.onclick = async (event) => {
            event?.stopPropagation?.();
            await actionLock.run(`${s.id}:pin`, async () => {
              pin.disabled = true;
              const nextPinned = !s.pinnedAt;
              reportAction(nextPinned ? 'Pinning session…' : 'Unpinning session…');
              try {
                await mutations.setPinned(s, nextPinned);
                reportAction(nextPinned ? 'Session pinned' : 'Session unpinned');
                await draw(selected);
              } catch (err) {
                reportAction(err?.message || 'Pin update failed', true, () => pin.onclick({ stopPropagation() {} }));
              } finally {
                pin.disabled = false;
              }
            });
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
              await actionLock.run(`${s.id}:pin-order`, async () => {
                up.disabled = true;
                down.disabled = true;
                try {
                  const next = pinnedIds.slice();
                  const target = index + delta;
                  if (target < 0 || target >= next.length) return;
                  [next[index], next[target]] = [next[target], next[index]];
                  reportAction('Updating pinned order…');
                  await mutations.reorderPinned(next);
                  reportAction('Pinned order updated');
                  await draw(selected);
                } finally {
                  up.disabled = index <= 0;
                  down.disabled = index < 0 || index >= pinnedIds.length - 1;
                }
              });
            };
            up.onclick = (event) => move(-1, event);
            down.onclick = (event) => move(1, event);
            rowActions.appendChild(up);
            rowActions.appendChild(down);
          }

          const archive = h('button', { class: 'sessionArchiveBtn', type: 'button', title: 'Archive session' }, '×');
          archive.onclick = async (event) => {
            event?.stopPropagation?.();
            await actionLock.run(`${s.id}:archive`, async () => {
              archive.disabled = true;
              reportAction('Archiving session…');
              try {
                await mutations.archive(s);
                reportAction('Session archived');
                if (selected === s.id) options.onNew();
                else await draw(selected);
              } catch (err) {
                reportAction(err?.message || 'Archive failed', true, () => archive.onclick({ stopPropagation() {} }));
              } finally {
                archive.disabled = false;
              }
            });
          };
          rowActions.appendChild(archive);
        }

        const detailsToggle = sessionRowView.detailsButton(view.expanded.has(s.id));
        rowActions.appendChild(detailsToggle);
        const renaming = view.renamingId === s.id;
        const titleNode = renaming
          ? h('span', { class: 'sessionRenameEditor' })
          : sessionRowView.title(s.title || t('session.untitled'), rawQuery);
        if (renaming) {
          const renameInput = h('input', { class: 'sessionRenameInput', type: 'text', 'aria-label': 'Session title' });
          renameInput.value = s.title || '';
          const saveRename = h('button', { class: 'sessionRenameSave', type: 'button' }, 'Save');
          const cancelRename = h('button', { class: 'sessionRenameCancel', type: 'button' }, 'Cancel');
          saveRename.onclick = async (event) => {
            event?.stopPropagation?.();
            const nextTitle = String(renameInput.value || '').trim();
            if (!nextTitle) {
              reportAction('Session title cannot be empty', true);
              return;
            }
            await actionLock.run(`${s.id}:rename`, async () => {
              saveRename.disabled = true;
              reportAction('Renaming session…');
              try {
                await mutations.rename(s, nextTitle);
                view.renamingId = null;
                searchController.clear();
                reportAction('Session renamed');
                await draw(selected);
              } catch (err) {
                reportAction(err?.message || 'Rename failed', true, () => saveRename.onclick({ stopPropagation() {} }));
              } finally {
                saveRename.disabled = false;
              }
            });
          };
          cancelRename.onclick = (event) => {
            event?.stopPropagation?.();
            view.renamingId = null;
            draw(selected);
          };
          renameInput.onkeydown = (event) => {
            if (event?.key === 'Enter') {
              event?.preventDefault?.();
              saveRename.onclick(event);
            } else if (event?.key === 'Escape') {
              event?.preventDefault?.();
              cancelRename.onclick(event);
            }
          };
          setTimeout(() => {
            renameInput.focus?.();
            renameInput.select?.();
          }, 0);
          titleNode.appendChild(renameInput);
          titleNode.appendChild(saveRename);
          titleNode.appendChild(cancelRename);
        }
        const row = sessionRowView.shell({
          session: s,
          selected,
          keyboardId: view.keyboardId,
          archived: view.archived,
          runtime: rowRuntime,
          expanded: view.expanded.has(s.id),
          selectBox,
          titleNode,
          statusNode,
          runtimeAction,
          rowActions,
        });
        sessionRowView.appendContext(
          row, s, state, rowRuntime, view.archived, view.expanded.has(s.id), rawQuery,
        );

        detailsToggle.onclick = (event) => {
          event?.stopPropagation?.();
          if (view.expanded.has(s.id)) view.expanded.delete(s.id);
          else view.expanded.add(s.id);
          draw(selected);
        };

        if (runtimeAction) {
          runtimeAction.onclick = async (event) => {
            event?.stopPropagation?.();
            if (isRunning) {
              await actionLock.run(`${s.id}:stop`, async () => {
                runtimeAction.disabled = true;
                reportAction('Stopping session…');
                try {
                  await mutations.stop(s);
                  reportAction('Stop requested');
                  await draw(selected);
                } catch (err) {
                  reportAction(err?.message || 'Stop failed', true);
                } finally {
                  runtimeAction.disabled = false;
                }
              });
            } else if (typeof options.onRetry === 'function') options.onRetry(s);
            else options.onSelect(s);
          };
        }
        if (!view.archived && !renaming) row.onclick = () => options.onSelect(s);
        if (!view.archived && !renaming) {
          row.onkeydown = (event) => {
            const key = event?.key;
            if (key === 'Enter' || key === ' ') {
              event?.preventDefault?.();
              options.onSelect(s);
              return;
            }
            if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
            event?.preventDefault?.();
            const nextId = sessionRow.nextKeyboardId(view.visibleIds, s.id, key);
            if (!nextId || nextId === s.id) return;
            view.keyboardId = nextId;
            draw(selected).then(() => {
              const nextRow = scroller.querySelector(`[data-session-id="${nextId}"]`);
              nextRow?.focus?.();
            });
          };
        }
        scroller.appendChild(row);
      });
    }
    search.oninput = (event) => {
      view.query = event?.target?.value || '';
      if (searchTimer) clearTimeout(searchTimer);
      searchStatus.textContent = view.query.trim() ? 'Waiting for typing…' : '';
      searchTimer = setTimeout(() => draw(options.selected), 180);
    };
    activeView.onclick = () => {
      view.archived = false;
      view.selectedIds.clear();
      view.bulkDeleteArmed = false;
      view.keyboardId = null;
      view.deleteConfirmId = null;
      view.renamingId = null;
      draw(options.selected);
    };
    archivedView.onclick = () => {
      view.archived = true;
      view.selectedIds.clear();
      view.bulkDeleteArmed = false;
      view.keyboardId = null;
      view.deleteConfirmId = null;
      view.renamingId = null;
      draw(options.selected);
    };
    draw(options.selected);
    bridge.onclick = () => draw(options.selected);
    const runtimeRefreshTimer = setInterval(async () => {
      if (view.archived || view.query.trim() || view.renamingId) return;
      try {
        const runtime = await adapter.http('GET', '/api/runtime-state');
        const nextSignature = sessionRuntime.signature(runtime);
        updateBridgeStatus(runtime);
        if (nextSignature !== lastRuntimeSignature) {
          lastRuntimeSignature = nextSignature;
          await draw(options.selected, runtime);
        }
      } catch {
        // Keep the last known runtime state; manual bridge refresh remains available.
      }
    }, 3000);
    runtimeRefreshTimer?.unref?.();
    return {
      root,
      refresh: draw,
      destroy() {
        clearInterval(runtimeRefreshTimer);
        if (searchTimer) clearTimeout(searchTimer);
        if (actionStatusTimer) clearTimeout(actionStatusTimer);
      },
    };
  }
  return { render };
})();
