import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hanaFetch: vi.fn() }));
vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.hanaFetch }));
import { openSessionBrowser, closeSessionBrowser } from '../../services/browser-session-actions';

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('session browser actions', () => {
  beforeEach(() => mocks.hanaFetch.mockReset());

  it('opens only after explicit backend acknowledgement', async () => {
    mocks.hanaFetch.mockResolvedValue(response({ ok: true, resume: { running: true } }));
    await expect(openSessionBrowser('/sessions/a.jsonl')).resolves.toBeUndefined();
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/browser/open-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionPath: '/sessions/a.jsonl' }),
      throwOnHttpError: false,
    });
  });

  it('rejects HTTP failure, JSON acknowledgement failure, and missing session path', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: true }, 503));
    await expect(openSessionBrowser('/sessions/a.jsonl')).rejects.toThrow('not acknowledged');
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: false, error: 'not resumable' }));
    await expect(openSessionBrowser('/sessions/a.jsonl')).rejects.toThrow('not resumable');
    await expect(openSessionBrowser('')).rejects.toThrow('session path');
  });

  it('returns only an acknowledged, authoritative close snapshot', async () => {
    const sessions = { '/sessions/b.jsonl': { running: true, url: 'https://example.test' } };
    mocks.hanaFetch.mockResolvedValue(response({ ok: true, sessions }));
    await expect(closeSessionBrowser('/sessions/a.jsonl')).resolves.toEqual(sessions);
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/browser/close-session', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionPath: '/sessions/a.jsonl' }),
    }));
  });

  it('rejects a purported close when the authoritative snapshot is still running', async () => {
    mocks.hanaFetch.mockResolvedValue(response({
      ok: true,
      sessions: { '/sessions/a.jsonl': { running: true, url: 'https://still-running.test' } },
    }));
    await expect(closeSessionBrowser('/sessions/a.jsonl')).rejects.toThrow('still running');
  });

  it('never claims close on unacknowledged or malformed responses', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: false, sessions: {} }));
    await expect(closeSessionBrowser('/sessions/a.jsonl')).rejects.toThrow('not acknowledged');
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: true }));
    await expect(closeSessionBrowser('/sessions/a.jsonl')).rejects.toThrow('authoritative');
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: true, sessions: [] }));
    await expect(closeSessionBrowser('/sessions/a.jsonl')).rejects.toThrow('authoritative');
  });
});
