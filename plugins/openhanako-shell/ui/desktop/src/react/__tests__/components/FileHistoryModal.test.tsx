/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  FileHistoryRestoreConflictError: class FileHistoryRestoreConflictError extends Error {},
  fetchHistoryFiles: vi.fn(async (..._args: any[]): Promise<any> => [
    { relPath: 'notes/a.md', deletedAt: null, lastCapturedAt: 1000, snapshotCount: 2 },
    { relPath: 'gone.md', deletedAt: 2000, lastCapturedAt: 900, snapshotCount: 1 },
  ]),
  fetchHistoryVersions: vi.fn(async (..._args: any[]): Promise<any> => [
    { id: 7, capturedAt: 1000, origin: 'event', opContext: 'agent_tool', rawSize: 5 },
  ]),
  fetchHistorySnapshot: vi.fn(async (..._args: any[]): Promise<any> => ({
    relPath: 'notes/a.md', capturedAt: 1000, origin: 'event', content: 'old',
  })),
  restoreHistorySnapshot: vi.fn(async (..._args: any[]): Promise<any> => ({ ok: true, relPath: 'notes/a.md' })),
}));
vi.mock('../../utils/file-history-api', () => mocks);
const refreshMocks = vi.hoisted(() => ({ refreshOpenPreviewDocumentsForFilePath: vi.fn(async () => {}) }));
vi.mock('../../utils/preview-document-refresh', () => refreshMocks);

import { FileHistoryModal } from '../../components/file-history/FileHistoryModal';
import { useStore } from '../../stores';

beforeEach(() => {
  vi.resetAllMocks();
  refreshMocks.refreshOpenPreviewDocumentsForFilePath.mockResolvedValue(undefined);
  vi.stubGlobal('confirm', vi.fn(() => true));
  window.t = ((key: string) => key) as typeof window.t;
  useStore.setState({
    fileHistoryModal: { open: true, preselectRelPath: null },
    currentAgentId: 'hana',
    deskWorkspaceNativeRoot: '',
    deskBasePath: '',
  } as never);
  window.platform = {} as typeof window.platform;
});

afterEach(() => {
  cleanup();
  useStore.setState({ fileHistoryModal: { open: false, preselectRelPath: null } } as never);
});

describe('FileHistoryModal', () => {
  it('loads and renders the tracked file list with a deleted group', async () => {
    render(<FileHistoryModal />);
    await waitFor(() => expect(screen.getByText('notes/a.md')).toBeTruthy());
    expect(screen.getByText('gone.md')).toBeTruthy();
  });

  it('does not restore when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    render(<FileHistoryModal />);
    await waitFor(() => expect(screen.getByText('notes/a.md')).toBeTruthy());
    fireEvent.click(screen.getByText('notes/a.md'));
    await waitFor(() => expect(mocks.fetchHistoryVersions).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('fh-version-7'));
    await waitFor(() => expect(mocks.fetchHistorySnapshot).toHaveBeenCalledWith('hana', 7));
    fireEvent.click(screen.getByTestId('fh-restore'));
    expect(confirm).toHaveBeenCalledWith('fileHistory.restoreConfirm');
    expect(mocks.restoreHistorySnapshot).not.toHaveBeenCalled();
  });

  it('does not display a late file list from a previously selected agent', async () => {
    let resolveOld!: (files: any[]) => void;
    mocks.fetchHistoryFiles.mockImplementation((agent: string) =>
      agent === 'hana'
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve([{ relPath: 'other.md', deletedAt: null, lastCapturedAt: 50, snapshotCount: 1 }]),
    );

    render(<FileHistoryModal />);
    await waitFor(() => expect(mocks.fetchHistoryFiles).toHaveBeenCalledWith('hana'));
    act(() => { useStore.setState({ currentAgentId: 'other' }); });
    expect(await screen.findByText('other.md')).toBeInTheDocument();

    await act(async () => {
      resolveOld([{ relPath: 'private-hana.md', deletedAt: null, lastCapturedAt: 100, snapshotCount: 1 }]);
    });
    expect(screen.getByText('other.md')).toBeInTheDocument();
    expect(screen.queryByText('private-hana.md')).not.toBeInTheDocument();
  });

  it('ignores a slow version list from a file that is no longer selected', async () => {
    let resolveOld!: (list: any[]) => void;
    mocks.fetchHistoryVersions.mockImplementation((_agent: string, relPath: string) =>
      relPath === 'notes/a.md'
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve([{ id: 8, capturedAt: 2000, origin: 'event', opContext: null, rawSize: 4 }]),
    );
    mocks.fetchHistorySnapshot.mockImplementation(async () => ({
      relPath: 'gone.md', capturedAt: 2000, origin: 'event', content: 'gone',
    }));
    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(mocks.fetchHistoryVersions).toHaveBeenCalledWith('hana', 'notes/a.md'));
    fireEvent.click(screen.getByText('gone.md'));
    expect(await screen.findByTestId('fh-version-8')).toBeInTheDocument();

    await act(async () => {
      resolveOld([{ id: 7, capturedAt: 1000, origin: 'event', opContext: null, rawSize: 3 }]);
    });
    expect(screen.getByTestId('fh-version-8')).toBeInTheDocument();
    expect(screen.queryByTestId('fh-version-7')).not.toBeInTheDocument();
  });

  it('does not display or restore a stale snapshot after switching files', async () => {
    let resolveOld!: (snapshot: any) => void;
    mocks.fetchHistoryVersions.mockImplementation(async (_agent: string, path: string) => [
      { id: path === 'notes/a.md' ? 7 : 8, capturedAt: 1000, origin: 'event', opContext: null, rawSize: 5 },
    ]);
    mocks.fetchHistorySnapshot.mockImplementation((_agent: string, id: number) =>
      id === 7
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve({ relPath: 'gone.md', capturedAt: 2000, origin: 'event', content: 'new-gone' }),
    );
    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(mocks.fetchHistorySnapshot).toHaveBeenCalledWith('hana', 7));
    expect(screen.getByTestId('fh-restore')).toBeDisabled();

    fireEvent.click(screen.getByText('gone.md'));
    await waitFor(() => expect(screen.getByText('new-gone')).toBeInTheDocument());
    await act(async () => {
      resolveOld({ relPath: 'notes/a.md', capturedAt: 1000, origin: 'event', content: 'stale-a' });
    });

    expect(screen.getByText('new-gone')).toBeInTheDocument();
    expect(screen.queryByText('stale-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('fh-restore')).not.toBeDisabled();
  });

  it('blocks restore when the backend returns a snapshot for the wrong file', async () => {
    mocks.fetchHistorySnapshot.mockResolvedValueOnce({
      relPath: 'another.md', capturedAt: 1000, origin: 'event', content: 'wrong',
    });
    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(screen.getByText('fileHistory.error')).toBeInTheDocument());
    expect(screen.getByTestId('fh-restore')).toBeDisabled();
    expect(mocks.restoreHistorySnapshot).not.toHaveBeenCalled();
  });

  it('keeps successful restore status if subsequent history hydration fails and refreshes open previews', async () => {
    useStore.setState({ deskWorkspaceNativeRoot: '/tmp/workspace', deskBasePath: '/tmp/workspace' } as never);
    mocks.fetchHistoryVersions
      .mockResolvedValueOnce([{ id: 7, capturedAt: 1000, origin: 'event', opContext: 'agent_tool', rawSize: 5 }])
      .mockRejectedValueOnce(new Error('history refresh unavailable'));
    mocks.restoreHistorySnapshot.mockResolvedValueOnce({ ok: true, relPath: 'notes/a.md' });
    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(screen.getByTestId('fh-restore')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('fh-restore'));
    await waitFor(() => expect(screen.getByText('fileHistory.restoreDone')).toBeInTheDocument());
    expect(screen.queryByText('fileHistory.error')).not.toBeInTheDocument();
    expect(refreshMocks.refreshOpenPreviewDocumentsForFilePath).toHaveBeenCalledWith('/tmp/workspace/notes/a.md');
  });

  it('sends observed file versions and blocks duplicate restores or selection during write', async () => {
    useStore.setState({ deskWorkspaceNativeRoot: '/tmp/workspace' } as never);
    window.platform = {
      readFileSnapshot: vi.fn(async () => ({
        content: 'current', version: { mtimeMs: 12, size: 7, sha256: 'a'.repeat(64) },
      })),
    } as unknown as typeof window.platform;
    let finish!: (result: any) => void;
    mocks.restoreHistorySnapshot.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(screen.getByTestId('fh-restore')).not.toBeDisabled());

    fireEvent.click(screen.getByTestId('fh-restore'));
    expect(mocks.restoreHistorySnapshot).toHaveBeenCalledWith('hana', 7, {
      mtimeMs: 12, size: 7, sha256: 'a'.repeat(64),
    });
    expect(screen.getByTestId('fh-restore')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'gone.md' })).toBeDisabled();
    expect(screen.getByTestId('fh-version-7')).toBeDisabled();
    fireEvent.click(screen.getByTestId('fh-restore'));
    expect(mocks.restoreHistorySnapshot).toHaveBeenCalledTimes(1);

    await act(async () => { finish({ ok: true, relPath: 'notes/a.md' }); });
    expect(screen.getByText('fileHistory.restoreDone')).toBeInTheDocument();
  });

  it('ignores completion from a restore whose agent changed while writing', async () => {
    let finish!: (result: any) => void;
    mocks.restoreHistorySnapshot.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(screen.getByTestId('fh-restore')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('fh-restore'));
    act(() => { useStore.setState({ currentAgentId: 'other' }); });

    await act(async () => { finish({ ok: true, relPath: 'notes/a.md' }); });
    expect(screen.queryByText('fileHistory.restoreDone')).not.toBeInTheDocument();
  });

  it('shows an explicit conflict and refreshes the current file version without auto-retrying', async () => {
    useStore.setState({ deskWorkspaceNativeRoot: '/tmp/workspace' } as never);
    const readFileSnapshot = vi.fn()
      .mockResolvedValueOnce({
        content: 'before', version: { mtimeMs: 12, size: 6, sha256: 'a'.repeat(64) },
      })
      .mockResolvedValueOnce({
        content: 'changed externally', version: { mtimeMs: 15, size: 18, sha256: 'b'.repeat(64) },
      });
    window.platform = { readFileSnapshot } as unknown as typeof window.platform;
    mocks.restoreHistorySnapshot.mockRejectedValueOnce(new mocks.FileHistoryRestoreConflictError());

    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(screen.getByTestId('fh-restore')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('fh-restore'));

    await waitFor(() => expect(screen.getByText('fileHistory.restoreConflict')).toBeInTheDocument());
    expect(mocks.restoreHistorySnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.restoreHistorySnapshot).toHaveBeenCalledWith('hana', 7, {
      mtimeMs: 12, size: 6, sha256: 'a'.repeat(64),
    });
    expect(readFileSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByText('changed externally')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('fh-restore')).not.toBeDisabled());

    fireEvent.click(screen.getByTestId('fh-restore'));
    expect(mocks.restoreHistorySnapshot).toHaveBeenLastCalledWith('hana', 7, {
      mtimeMs: 15, size: 18, sha256: 'b'.repeat(64),
    });
  });

  it('blocks a conflict retry if the updated file version cannot be fetched', async () => {
    useStore.setState({ deskWorkspaceNativeRoot: '/tmp/workspace' } as never);
    window.platform = {
      readFileSnapshot: vi.fn()
        .mockResolvedValueOnce({ content: 'before', version: { mtimeMs: 12, size: 6 } })
        .mockResolvedValueOnce(null),
    } as unknown as typeof window.platform;
    mocks.restoreHistorySnapshot.mockRejectedValueOnce(new mocks.FileHistoryRestoreConflictError());

    render(<FileHistoryModal />);
    fireEvent.click(await screen.findByText('notes/a.md'));
    await waitFor(() => expect(screen.getByTestId('fh-restore')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('fh-restore'));
    await waitFor(() => expect(screen.getByText('fileHistory.restoreConflict')).toBeInTheDocument());
    expect(screen.getByTestId('fh-restore')).toBeDisabled();
    expect(mocks.restoreHistorySnapshot).toHaveBeenCalledTimes(1);
  });

  it('loads versions when a file is selected and restores on confirm', async () => {
    render(<FileHistoryModal />);
    await waitFor(() => expect(screen.getByText('notes/a.md')).toBeTruthy());
    fireEvent.click(screen.getByText('notes/a.md'));
    await waitFor(() => expect(mocks.fetchHistoryVersions).toHaveBeenCalled());
    const versionRow = await screen.findByTestId('fh-version-7');
    fireEvent.click(versionRow);
    await waitFor(() => expect(mocks.fetchHistorySnapshot).toHaveBeenCalledWith('hana', 7));
    await waitFor(() => expect(screen.getByTestId('fh-restore')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('fh-restore'));
    await waitFor(() => expect(mocks.restoreHistorySnapshot).toHaveBeenCalledWith('hana', 7, undefined));
    expect(confirm).toHaveBeenCalledWith('fileHistory.restoreConfirm');
  });
});
