import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stopped = Object.freeze({ running: false, url: null, thumbnail: null, collapsed: false });
  const state = {
    browserBySession: {} as Record<string, any>,
    sessionLocatorsById: {} as Record<string, { path: string }>,
    currentSessionPath: null as string | null,
  };
  return {
    state,
    stopped,
    fetch: vi.fn(),
    apply: vi.fn((path: string, next: any) => {
      state.browserBySession = { ...state.browserBySession, [path]: next };
    }),
  };
});

vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.fetch }));
vi.mock('../../stores', () => ({
  useStore: { getState: () => mocks.state },
}));
vi.mock('../../stores/browser-slice', () => ({
  browserStateForPath: (state: typeof mocks.state, path: string) => state.browserBySession[path] || mocks.stopped,
  setBrowserStateForPath: mocks.apply,
}));

import { reconcileBrowserSessionsAfterReconnect } from '../../services/browser-reconnect';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('browser reconnect reconciliation', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.apply.mockClear();
    mocks.state.browserBySession = {};
    mocks.state.sessionLocatorsById = {};
    mocks.state.currentSessionPath = null;
  });

  it('clears stopped sessions and replaces navigated thumbnails, preserving user collapse on active pages', async () => {
    mocks.state.browserBySession = {
      '/session/closed.jsonl': {
        running: true, url: 'https://closed.test', thumbnail: 'SECRET_IMAGE', collapsed: true,
      },
      '/session/nav.jsonl': {
        running: true, url: 'https://old.test', thumbnail: 'WRONG_PAGE', collapsed: true,
      },
      '/session/same.jsonl': {
        running: true, url: 'https://same.test', thumbnail: 'SAME_PAGE', collapsed: true,
      },
    };
    mocks.fetch.mockResolvedValue(ok({
      '/session/nav.jsonl': { running: true, url: 'https://new.test', resumable: true, unavailableReason: null },
      '/session/same.jsonl': { running: true, url: 'https://same.test', resumable: true, unavailableReason: null },
    }));

    await reconcileBrowserSessionsAfterReconnect();

    expect(mocks.fetch).toHaveBeenCalledWith('/api/browser/session-states', expect.objectContaining({
      method: 'GET', throwOnHttpError: false,
    }));
    expect(mocks.state.browserBySession['/session/closed.jsonl']).toMatchObject({
      running: false, url: null, thumbnail: null, collapsed: true,
    });
    expect(mocks.state.browserBySession['/session/nav.jsonl']).toMatchObject({
      running: true, url: 'https://new.test', thumbnail: null, collapsed: true,
    });
    expect(mocks.state.browserBySession['/session/same.jsonl']).toMatchObject({
      running: true, url: 'https://same.test', thumbnail: 'SAME_PAGE', thumbnailFresh: false,
    });
  });

  it('restores running state and expands a browser that restarted during disconnect', async () => {
    mocks.state.currentSessionPath = '/session/a.jsonl';
    mocks.state.browserBySession = {
      '/session/a.jsonl': { running: false, url: null, thumbnail: null, collapsed: true },
    };
    mocks.fetch.mockResolvedValue(ok({
      '/session/a.jsonl': { running: true, url: 'https://restored.test' },
    }));
    await reconcileBrowserSessionsAfterReconnect();
    expect(mocks.state.browserBySession['/session/a.jsonl']).toMatchObject({
      running: true, url: 'https://restored.test', thumbnail: null, collapsed: false,
    });
  });

  it('never overwrites a live event that arrives during the HTTP request', async () => {
    let respond!: (value: unknown) => void;
    mocks.state.browserBySession = {
      '/session/a.jsonl': { running: true, url: 'https://initial.test', thumbnail: 'INITIAL', collapsed: false },
    };
    mocks.fetch.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    const pending = reconcileBrowserSessionsAfterReconnect();

    const realtime = { running: true, url: 'https://live.test', thumbnail: 'LIVE', collapsed: true };
    mocks.state.browserBySession = { '/session/a.jsonl': realtime };
    respond(ok({ '/session/a.jsonl': { running: false, url: null } }));
    await pending;
    expect(mocks.state.browserBySession['/session/a.jsonl']).toBe(realtime);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('ignores a snapshot belonging to a superseded websocket', async () => {
    mocks.state.currentSessionPath = '/session/a.jsonl';
    mocks.fetch.mockResolvedValue(ok({
      '/session/a.jsonl': { running: true, url: 'https://old.test' },
    }));
    await reconcileBrowserSessionsAfterReconnect(() => false);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('rejects failed and malformed responses without changing existing states', async () => {
    mocks.state.browserBySession = {
      '/session/a.jsonl': { running: true, url: 'https://keep.test', thumbnail: 'KEEP' },
    };
    mocks.fetch.mockResolvedValueOnce({
      ok: false, status: 503, json: async () => ({ error: 'offline' }),
    });
    await expect(reconcileBrowserSessionsAfterReconnect()).rejects.toThrow('HTTP 503');

    mocks.fetch.mockResolvedValueOnce(ok({
      '/session/a.jsonl': { running: 'false', url: null },
    }));
    await expect(reconcileBrowserSessionsAfterReconnect()).rejects.toThrow('Invalid browser status snapshot');
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
