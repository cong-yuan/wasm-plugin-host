import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mocks.hanaFetch,
}));

import { requestUserEditCheckpoint } from '../../utils/checkpoints';

describe('requestUserEditCheckpoint', () => {
  beforeEach(() => { mocks.hanaFetch.mockReset(); mocks.hanaFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })); });

  it('rejects 200 responses without confirmed checkpoint acknowledgement', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'not saved' }), { status: 200 }));
    await expect(requestUserEditCheckpoint('/tmp/note.md', 'edit-start')).rejects.toThrow('not saved');
  });

  it('rejects malformed successful responses rather than marking a checkpoint as saved', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(requestUserEditCheckpoint('/tmp/note.md', 'edit-start')).rejects.toThrow('not acknowledged');
  });

  it('posts explicit user-edit checkpoint requests', async () => {
    await requestUserEditCheckpoint('/tmp/note.md', 'edit-start');

    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/checkpoints/user-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/tmp/note.md', reason: 'edit-start' }),
    });
  });
});
