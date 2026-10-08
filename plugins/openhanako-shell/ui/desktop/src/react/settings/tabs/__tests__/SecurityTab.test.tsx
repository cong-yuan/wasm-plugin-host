// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../store';

const autoSaveConfigMock = vi.fn();
const loadSettingsConfigMock = vi.fn();

vi.mock('../../helpers', () => ({
  autoSaveConfig: (...args: unknown[]) => autoSaveConfigMock(...args),
  t: (key: string) => ({
    'settings.security.sandbox': 'Sandbox',
    'settings.security.sandboxDesc': 'Run commands inside a sandbox.',
    'settings.security.sandboxNetwork': 'Sandbox network',
    'settings.security.sandboxNetworkDesc': 'Block network access when disabled.',
    'settings.security.sandboxNetworkDisabledDesc': 'Enable the command sandbox first.',
    'settings.security.sandboxNetworkWin32Unsupported': 'Windows command sandbox keeps network access and only isolates writes.',
    'settings.security.fileBackup': 'File backup',
    'settings.security.fileBackupDesc': 'Keep edit checkpoints.',
    'settings.security.archivedChats': 'Archived conversations',
    'settings.security.archivedChatsDesc': 'Review archived conversations.',
    'settings.security.viewArchivedChats': 'View archived conversations',
  } as Record<string, string>)[key] || key,
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: () => loadSettingsConfigMock(),
}));

vi.mock('../../api', () => ({
  hanaFetch: vi.fn(),
}));
vi.mock('../../../utils/preview-document-refresh', () => ({
  refreshOpenPreviewDocumentsForFilePath: vi.fn(async () => {}),
}));

vi.mock('../../../hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'session.archived.title': 'Archived conversations window',
      'session.archived.stats': '0 conversations',
      'session.archived.cleanup30': 'Clean 30 days',
      'session.archived.cleanup90': 'Clean 90 days',
      'session.archived.empty': 'No archived conversations',
      'common.loading': 'Loading',
    } as Record<string, string>)[key] || key,
  }),
}));

vi.mock('../../../stores/session-actions', () => ({
  listArchivedSessions: vi.fn(async () => []),
  restoreSession: vi.fn(),
  deleteArchivedSession: vi.fn(),
  cleanupArchivedSessions: vi.fn(),
  showSidebarToast: vi.fn(),
  loadSessions: vi.fn(),
}));

import { hanaFetch } from '../../api';
import { refreshOpenPreviewDocumentsForFilePath } from '../../../utils/preview-document-refresh';

import { SecurityTab } from '../SecurityTab';

describe('SecurityTab Windows sandbox network control', () => {
  beforeEach(() => {
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(refreshOpenPreviewDocumentsForFilePath).mockClear();
    autoSaveConfigMock.mockResolvedValue(true);
    loadSettingsConfigMock.mockResolvedValue(undefined);
    useSettingsStore.setState({
      settingsConfig: {
        sandbox: true,
        sandbox_network: false,
        file_backup: { enabled: false, retention_days: 1, max_file_size_kb: 1024 },
      },
      platformName: 'win32',
      currentAgentId: 'hana',
      settingsAgentId: 'hana',
    } as never);
  });

  afterEach(() => {
    cleanup();
    autoSaveConfigMock.mockReset();
    loadSettingsConfigMock.mockReset();
    useSettingsStore.setState({
      settingsConfig: null,
      platformName: null,
      currentAgentId: null,
      settingsAgentId: null,
      toastMessage: '',
      toastType: '',
      toastVisible: false,
    } as never);
  });

  it('requires confirmation and refreshes the restored file only after an acknowledged checkpoint restore', async () => {
    useSettingsStore.setState({
      settingsConfig: {
        sandbox: true,
        sandbox_network: true,
        file_backup: { enabled: true, retention_days: 1, max_file_size_kb: 1024 },
      },
    } as never);
    vi.mocked(hanaFetch).mockImplementation(async (url: string) => new Response(
      JSON.stringify(url === '/api/checkpoints'
        ? { checkpoints: [{ id: 'checkpoint123', ts: Date.now(), tool: 'edit', path: '/tmp/note.md', size: 4 }] }
        : { ok: true, restoredTo: '/tmp/note.md' }),
      { status: 200 },
    ));
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(React.createElement(SecurityTab));
    fireEvent.click(screen.getByText('settings.security.viewBackups'));
    const restore = await screen.findByRole('button', { name: 'settings.security.restoreBtn' });
    fireEvent.click(restore);
    expect(confirmMock).toHaveBeenCalledWith('settings.security.restoreConfirm');
    expect(vi.mocked(hanaFetch).mock.calls.some(([url]) => url.includes('/restore'))).toBe(false);

    confirmMock.mockReturnValue(true);
    fireEvent.click(restore);
    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toBe('settings.security.restoreSuccess'));
    expect(vi.mocked(hanaFetch)).toHaveBeenCalledWith('/api/checkpoints/checkpoint123/restore', { method: 'POST' });
    expect(vi.mocked(refreshOpenPreviewDocumentsForFilePath)).toHaveBeenCalledWith('/tmp/note.md');
    confirmMock.mockRestore();
  });

  it('rejects a checkpoint restore that was not acknowledged for the selected target', async () => {
    useSettingsStore.setState({
      settingsConfig: {
        sandbox: true,
        sandbox_network: true,
        file_backup: { enabled: true, retention_days: 1, max_file_size_kb: 1024 },
      },
    } as never);
    vi.mocked(hanaFetch).mockImplementation(async (url: string) => new Response(
      JSON.stringify(url === '/api/checkpoints'
        ? { checkpoints: [{ id: 'checkpoint123', ts: Date.now(), tool: 'edit', path: '/tmp/note.md', size: 4 }] }
        : { ok: true, restoredTo: '/tmp/other.md' }),
      { status: 200 },
    ));
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(React.createElement(SecurityTab));
    fireEvent.click(screen.getByText('settings.security.viewBackups'));
    fireEvent.click(await screen.findByRole('button', { name: 'settings.security.restoreBtn' }));

    await waitFor(() => expect(useSettingsStore.getState().toastMessage).toBe('settings.security.restoreFailed'));
    expect(vi.mocked(refreshOpenPreviewDocumentsForFilePath)).not.toHaveBeenCalled();
    confirmMock.mockRestore();
  });

  it('disables the sandbox network switch on Windows and keeps it visually on', () => {
    render(React.createElement(SecurityTab));

    expect(screen.getByText('Windows command sandbox keeps network access and only isolates writes.')).toBeTruthy();

    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    const networkSwitch = switches[1];
    expect(networkSwitch.disabled).toBe(true);
    expect(networkSwitch.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(networkSwitch);
    expect(autoSaveConfigMock).not.toHaveBeenCalledWith({ sandbox_network: false }, expect.anything());
    expect(loadSettingsConfigMock).not.toHaveBeenCalled();
  });

  it('opens archived conversations from the security tab', async () => {
    render(React.createElement(SecurityTab));

    fireEvent.click(screen.getByText('View archived conversations'));

    expect(await screen.findByText('Archived conversations window')).toBeTruthy();
    expect(screen.getByText('No archived conversations')).toBeTruthy();
  });

  it('does not render optimistic sandbox or backup states before settings config is ready', () => {
    useSettingsStore.setState({
      settingsConfig: null,
      platformName: 'darwin',
    } as never);

    render(React.createElement(SecurityTab));

    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches).toHaveLength(3);
    for (const item of switches) {
      expect(item.getAttribute('aria-checked')).toBe('mixed');
      expect(item.getAttribute('aria-busy')).toBe('true');
      expect(item.disabled).toBe(true);
      fireEvent.click(item);
    }
    expect(autoSaveConfigMock).not.toHaveBeenCalled();
    expect(loadSettingsConfigMock).not.toHaveBeenCalled();
  });
});
