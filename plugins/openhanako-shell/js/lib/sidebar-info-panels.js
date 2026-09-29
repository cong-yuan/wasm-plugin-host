return (function () {
  const { h, clear } = studio.require('lib/dom');

  function create({ api, adapter, labels = {} }) {
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

    const close = (panel, button) => {
      panel.style.display = 'none';
      button?.setAttribute?.('aria-expanded', 'false');
    };

    const renderSettings = (summaryData, status) => {
      clear(settingsPanel);
      const providers = summaryData?.providers && typeof summaryData.providers === 'object'
        ? Object.entries(summaryData.providers)
        : [];
      const activeProvider = status?.providers?.[0] || '';
      const activeModel = status?.model || '';
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
        const configured = !!provider?.has_credentials || !!provider?.is_configured;
        const row = h('div', {
          class: 'sidebarSettingsProvider',
          'data-configured': configured ? 'true' : 'false',
        }, h('div', { class: 'sidebarSettingsProviderHeader' },
          h('span', { class: 'sidebarSettingsProviderName' }, provider?.display_name || name),
          h('span', { class: 'sidebarSettingsProviderState' }, configured ? 'Configured' : 'Needs credentials')));
        const models = Array.isArray(provider?.models) ? provider.models : [];
        if (models.length) {
          row.appendChild(h('div', { class: 'sidebarSettingsProviderMeta' },
            `${models.length} model${models.length === 1 ? '' : 's'} · ${models.slice(0, 3).join(', ')}${models.length > 3 ? '…' : ''}`));
        }
        if (provider?.base_url) {
          row.appendChild(h('div', { class: 'sidebarSettingsProviderMeta' }, String(provider.base_url)));
        }
        settingsPanel.appendChild(row);
      });
    };

    const loadSettings = async () => {
      clear(settingsPanel);
      settingsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'Loading providers…'));
      try {
        const [summaryData, status] = await Promise.all([
          adapter.http('GET', '/api/providers/summary'),
          api.status(),
        ]);
        renderSettings(summaryData, status);
      } catch (err) {
        clear(settingsPanel);
        settingsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty error' },
          err?.message || 'Unable to load provider settings'));
      }
    };

    const renderActivity = (runtime) => {
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
        const item = h('div', { class: 'sidebarActivityItem', 'data-state': state },
          h('div', { class: 'sidebarActivityItemHeader' },
            h('span', { class: 'sidebarActivityStateDot', 'data-state': state }),
            h('span', { class: 'sidebarActivityItemTitle' }, row.title || row.sessionId || 'Session'),
            h('span', { class: 'sidebarActivityItemState' }, state)));
        const toolNames = (row.activeTools || []).map((tool) => tool?.name).filter(Boolean);
        if (toolNames.length) {
          item.appendChild(h('div', { class: 'sidebarActivityItemMeta' }, `Tools: ${toolNames.join(', ')}`));
        }
        if (row.error) item.appendChild(h('div', { class: 'sidebarActivityItemError' }, String(row.error)));
        activityPanel.appendChild(item);
      });
    };

    const loadActivity = async () => {
      clear(activityPanel);
      activityPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'Loading runtime…'));
      try {
        renderActivity(await adapter.http('GET', '/api/runtime-state'));
      } catch (err) {
        clear(activityPanel);
        activityPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty error' },
          err?.message || 'Unable to load runtime activity'));
      }
    };

    let skillsLoading = false;
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
      if (skillsLoading) return;
      skillsLoading = true;
      clear(skillsPanel);
      skillsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty' }, 'Loading capabilities…'));
      try {
        const [plugins, tools] = await Promise.all([api.plugins(), api.tools()]);
        renderSkills(plugins, tools);
      } catch (err) {
        clear(skillsPanel);
        skillsPanel.appendChild(h('div', { class: 'sidebarSkillsEmpty error' },
          err?.message || 'Unable to load capabilities'));
      } finally {
        skillsLoading = false;
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