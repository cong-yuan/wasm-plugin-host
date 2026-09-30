return (function () {
  const { h, clear } = studio.require('lib/dom');

  function create({ api, adapter, labels = {}, onOpenSession = null }) {
    const settingsPanel = h('div', {
      class: 'sidebarSettingsPanel',
      role: 'region',
      'aria-label': labels.settings || 'Settings',
    });
    const activityPanel = h('div', {
      class: 'sidebarActivityPanel',
      role: 'region',
      'aria-label': labels.activity || 'Activity',
    });
    const skillsPanel = h('div', {
      class: 'sidebarSkillsPanel',
      role: 'region',
      'aria-label': labels.skills || 'Skills',
    });
    [settingsPanel, activityPanel, skillsPanel].forEach((panel) => { panel.style.display = 'none'; });
    const requestVersion = { settings: 0, activity: 0, skills: 0 };
    const panelKey = (panel) => (
      panel === settingsPanel ? 'settings'
        : panel === activityPanel ? 'activity'
          : panel === skillsPanel ? 'skills' : null
    );

    const close = (panel, button) => {
      const key = panelKey(panel);
      if (key) requestVersion[key] += 1;
      panel.style.display = 'none';
      button?.setAttribute?.('aria-expanded', 'false');
    };

    const renderSettings = (summaryData, status, llm) => {
      clear(settingsPanel);
      const providers = summaryData?.providers && typeof summaryData.providers === 'object'
        ? Object.entries(summaryData.providers)
        : [];
      const activeProvider = status?.provider || status?.providers?.[0] || '';
      const activeModel = status?.model || '';
      const defaultProvider = typeof llm?.default === 'string' ? llm.default : '';
      const currentProvider = typeof llm?.current?.provider === 'string' ? llm.current.provider : '';
      const newChatProvider = currentProvider || defaultProvider;
      const settingsMessage = h('div', { class: 'sidebarSettingsMessage', 'aria-live': 'polite' }, '');
      const refresh = h('button', { class: 'sidebarSettingsRefresh', type: 'button' }, 'Refresh');
      refresh.onclick = () => loadSettings();
      settingsPanel.appendChild(h('div', { class: 'sidebarSettingsSummary' },
        h('span', {}, activeModel
          ? `Active: ${activeProvider ? activeProvider + ' / ' : ''}${activeModel}`
          : 'Provider configuration'),
        refresh));
      if (!providers.length) {
        settingsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'No providers configured'));
        return;
      }
      providers.forEach(([name, provider]) => {
        const builtIn = !!provider?.is_builtin || name === 'mock';
        const configured = builtIn || !!provider?.has_credentials || !!provider?.is_configured;
        const row = h('div', {
          class: 'sidebarSettingsProvider',
          'data-configured': configured ? 'true' : 'false',
        }, h('div', { class: 'sidebarSettingsProviderHeader' },
          h('span', { class: 'sidebarSettingsProviderName' }, provider?.display_name || name),
          h('span', { class: 'sidebarSettingsProviderState' }, builtIn ? 'Built in' : configured ? 'Configured' : 'Needs credentials')));
        const models = Array.isArray(provider?.models) ? provider.models : [];
        if (models.length) {
          row.appendChild(h('div', { class: 'sidebarSettingsProviderMeta' },
            `${models.length} model${models.length === 1 ? '' : 's'} · ${models.slice(0, 3).join(', ')}${models.length > 3 ? '…' : ''}`));
        }
        if (provider?.base_url) {
          row.appendChild(h('div', { class: 'sidebarSettingsProviderMeta' }, String(provider.base_url)));
        }
        const actions = h('div', { class: 'sidebarSettingsProviderActions' });
        if (name === newChatProvider) {
          actions.appendChild(h('span', { class: 'sidebarSettingsDefaultBadge' }, 'New chats'));
        } else if (configured && models.length) {
          const useForNewChats = h('button', {
            class: 'sidebarSettingsSetDefault',
            type: 'button',
          }, 'Use for new chats');
          useForNewChats.onclick = async () => {
            useForNewChats.disabled = true;
            settingsMessage.textContent = `Using ${name} for new chats…`;
            settingsMessage.className = 'sidebarSettingsMessage';
            const configuredModel = llm?.providers?.[name]?.model;
            const model = configuredModel || models[0];
            try {
              const result = await api.setLlmConfig({
                default: name,
                current: { provider: name, model },
              });
              if (result && result.ok === false) throw new Error(result.error || 'Provider update failed');
              const pendingResult = await adapter.http('POST', '/api/models/set', {
                provider: name,
                modelId: model,
              });
              if (pendingResult && pendingResult.ok === false) {
                throw new Error(pendingResult.error || 'Unable to update new-chat model');
              }
              await loadSettings();
            } catch (err) {
              settingsMessage.textContent = err?.message || 'Unable to update new-chat provider';
              settingsMessage.className = 'sidebarSettingsMessage error';
              useForNewChats.disabled = false;
            }
          };
          actions.appendChild(useForNewChats);
        }
        if (actions.children?.length) row.appendChild(actions);
        settingsPanel.appendChild(row);
      });
      settingsPanel.appendChild(settingsMessage);
    };

    const loadSettings = async () => {
      const version = ++requestVersion.settings;
      clear(settingsPanel);
      settingsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'Loading providers…'));
      try {
        const [summaryData, status, llm] = await Promise.all([
          adapter.http('GET', '/api/providers/summary'),
          api.status(),
          api.getLlmConfig(),
        ]);
        if (version !== requestVersion.settings) return;
        renderSettings(summaryData, status, llm);
      } catch (err) {
        if (version !== requestVersion.settings) return;
        clear(settingsPanel);
        settingsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty error' },
          err?.message || 'Unable to load provider settings'));
      }
    };

    const renderActivityContent = (runtime) => {
      clear(activityPanel);
      const rows = Array.from(runtime?.sessions || []);
      const running = rows.filter((row) => row.status === 'running' || row.isStreaming);
      const errors = rows.filter((row) => row.status === 'error' || row.error);
      const refresh = h('button', { class: 'sidebarActivityRefresh', type: 'button' }, 'Refresh');
      refresh.onclick = () => loadActivity();
      activityPanel.appendChild(h('div', { class: 'sidebarActivitySummary' },
        h('span', {}, `${rows.length} session${rows.length === 1 ? '' : 's'} · ${running.length} running · ${errors.length} error${errors.length === 1 ? '' : 's'}`),
        refresh));
      if (!rows.length) {
        activityPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'No runtime sessions'));
        return;
      }
      rows.forEach((row) => {
        const state = row.status === 'error' || row.error
          ? 'error'
          : row.status === 'running' || row.isStreaming ? 'running' : 'idle';
        const itemHeader = h('div', { class: 'sidebarActivityItemHeader' },
          h('span', { class: 'sidebarActivityStateDot', 'data-state': state }),
          h('span', { class: 'sidebarActivityItemTitle' }, row.title || row.sessionId || 'Session'),
          h('span', { class: 'sidebarActivityItemState' }, state));
        const item = h('div', { class: 'sidebarActivityItem', 'data-state': state }, itemHeader);
        if (row.sessionId && typeof onOpenSession === 'function') {
          const open = h('button', {
            class: 'sidebarActivityOpen',
            type: 'button',
            title: 'Open session',
          }, 'Open');
          open.onclick = async () => {
            open.disabled = true;
            try {
              const opened = await onOpenSession({ ...row, id: row.sessionId });
              if (opened === false) {
                item.appendChild(h('div', { class: 'sidebarActivityItemError' },
                  'Unable to open session'));
              }
            } catch (err) {
              item.appendChild(h('div', { class: 'sidebarActivityItemError' },
                err?.message || 'Unable to open session'));
            } finally {
              open.disabled = false;
            }
          };
          itemHeader.appendChild(open);
        }
        if (state === 'running' && row.sessionId) {
          const stop = h('button', {
            class: 'sidebarActivityStop',
            type: 'button',
            title: 'Stop running session',
          }, 'Stop');
          stop.onclick = async () => {
            stop.disabled = true;
            try {
              await api.cancel(row.sessionId);
              await loadActivity();
            } catch (err) {
              stop.disabled = false;
              item.appendChild(h('div', { class: 'sidebarActivityItemError' },
                err?.message || 'Unable to stop session'));
            }
          };
          itemHeader.appendChild(stop);
        }
        const toolNames = (row.activeTools || []).map((tool) => tool?.name).filter(Boolean);
        if (toolNames.length) {
          item.appendChild(h('div', { class: 'sidebarActivityItemMeta' }, `Tools: ${toolNames.join(', ')}`));
        }
        if (row.error) item.appendChild(h('div', { class: 'sidebarActivityItemError' }, String(row.error)));
        activityPanel.appendChild(item);
      });
    };

    const renderActivity = (runtime) => {
      requestVersion.activity += 1;
      renderActivityContent(runtime);
    };

    const loadActivity = async () => {
      const version = ++requestVersion.activity;
      clear(activityPanel);
      activityPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'Loading runtime…'));
      try {
        const runtime = await adapter.http('GET', '/api/runtime-state');
        if (version !== requestVersion.activity) return;
        renderActivityContent(runtime);
      } catch (err) {
        if (version !== requestVersion.activity) return;
        clear(activityPanel);
        activityPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty error' },
          err?.message || 'Unable to load runtime activity'));
      }
    };

    const renderSkills = (plugins, tools) => {
      clear(skillsPanel);
      const pluginRows = Array.from(plugins || []);
      const toolRows = Array.from(tools || []);
      const refresh = h('button', { class: 'sidebarSkillsRefresh', type: 'button' }, 'Refresh');
      refresh.onclick = () => loadSkills();
      skillsPanel.appendChild(h('div', { class: 'sidebarSkillsSummary' },
        h('span', {}, `${pluginRows.length} plugin${pluginRows.length === 1 ? '' : 's'} · ${toolRows.length} tool${toolRows.length === 1 ? '' : 's'}`),
        refresh));

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

    const loadSkills = async () => {
      const version = ++requestVersion.skills;
      clear(skillsPanel);
      skillsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'Loading capabilities…'));
      try {
        const [plugins, tools] = await Promise.all([api.plugins(), api.tools()]);
        if (version !== requestVersion.skills) return;
        renderSkills(plugins, tools);
      } catch (err) {
        if (version !== requestVersion.skills) return;
        clear(skillsPanel);
        skillsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty error' },
          err?.message || 'Unable to load capabilities'));
      }
    };

    return {
      settingsPanel,
      activityPanel,
      skillsPanel,
      close,
      renderActivity,
      loadSettings,
      loadActivity,
      loadSkills,
    };
  }

  return { create };
})();