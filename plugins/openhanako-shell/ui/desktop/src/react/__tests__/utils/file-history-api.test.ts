import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hanaFetch: vi.fn() }));
vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.hanaFetch }));

import { restoreHistorySnapshot } from '../../utils/file-history-api';

describe('file-history restore API', () => {
  beforeEach(() => { mocks.hanaFetch.mockReset(); });

  it('accepts an acknowledged restore', async () => {
    mocks.hanaFetch.mockResolvedValue(new Response(
      JSON.stringify({ ok: true, relPath: 'notes/a.md' }),
      { status: 200 },
    ));
    await expect(restoreHistorySnapshot('hana', 7)).resolves.toEqual({
      ok: true, relPath: 'notes/a.md',
    });
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/file-history/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'hana', snapshotId: 7 }),
      throwOnHttpError: false,
    });
  });

  it('includes the observed editor version when issuing a guarded restore', async () => {
    mocks.hanaFetch.mockResolvedValue(new Response(
      JSON.stringify({ ok: true, relPath: 'notes/a.md' }), { status: 200 },
    ));
    const expectedVersion = { mtimeMs: 123, size: 3, sha256: 'a'.repeat(64) };
    await restoreHistorySnapshot('hana', 7, expectedVersion);
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/file-history/restore', expect.objectContaining({
      body: JSON.stringify({ agentId: 'hana', snapshotId: 7, expectedVersion }),
    }));
  });

  it('classifies an actual HTTP 409 version conflict without treating it as generic failure', async () => {
    mocks.hanaFetch.mockResolvedValue(new Response(
      JSON.stringify({ error: 'Resource write conflict', conflict: true }), { status: 409 },
    ));
    await expect(restoreHistorySnapshot('hana', 7)).rejects.toMatchObject({
      name: 'FileHistoryRestoreConflictError',
    });
  });

  it('keeps a non-conflict HTTP failure generic', async () => {
    mocks.hanaFetch.mockResolvedValue(new Response(
      JSON.stringify({ error: 'Resource write failed' }), { status: 500 },
    ));
    await expect(restoreHistorySnapshot('hana', 7)).rejects.toThrow('Resource write failed');
  });

  it('rejects a success-status response when restore was not acknowledged', async () => {
    mocks.hanaFetch.mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: 'Resource write failed' }),
      { status: 200 },
    ));
    await expect(restoreHistorySnapshot('hana', 7)).rejects.toThrow('Resource write failed');
  });

  it('rejects responses without a restored path', async () => {
    mocks.hanaFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(restoreHistorySnapshot('hana', 7)).rejects.toThrow('not acknowledged');
  });
});
