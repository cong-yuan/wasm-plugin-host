/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const hanaFetch = vi.hoisted(() => vi.fn(async (path: string) => ({
  json: async () => (path.endsWith('/subscribe') ? { ok: true, subscriptionId: 'sub-1' } : { ok: true }),
})));

vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch }));

describe('resource-events', () => {
  afterEach(() => {
    vi.resetModules();
    hanaFetch.mockReset();
    hanaFetch.mockImplementation(async (path: string) => ({
      json: async () => (path.endsWith('/subscribe') ? { ok: true, subscriptionId: 'sub-1' } : { ok: true }),
    }));
  });

  it('shares one backend resource subscription per local file and releases it after the last subscriber leaves', async () => {
    const { retainLocalFileResourceWatch } = await import('../../services/resource-events');

    const releaseFirst = retainLocalFileResourceWatch('/tmp/note.md');
    const releaseSecond = retainLocalFileResourceWatch('/tmp/note.md');
    await Promise.resolve();

    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/subscribe', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        purpose: 'resource-watch',
        resources: [{ kind: 'local-file', path: '/tmp/note.md' }],
      }),
    }));

    releaseFirst();
    await Promise.resolve();
    expect(hanaFetch).toHaveBeenCalledTimes(1);

    releaseSecond();
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-1', expect.objectContaining({
        method: 'DELETE',
      }));
    });
  });

  it('dedupes mount ResourceRefs without materializing native paths in the renderer', async () => {
    const { retainResourceWatch } = await import('../../services/resource-events');

    const releaseFirst = retainResourceWatch({ kind: 'mount', mountId: 'mount_docs', path: 'notes' });
    const releaseSecond = retainResourceWatch({ kind: 'mount', mountId: 'mount_docs', path: 'notes/' });
    await Promise.resolve();

    expect(hanaFetch).toHaveBeenCalledTimes(1);
    expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/subscribe', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        purpose: 'resource-watch',
        resources: [{ kind: 'mount', mountId: 'mount_docs', path: 'notes' }],
      }),
    }));

    releaseFirst();
    releaseSecond();
  });

  it('releases superseded subscriptions when a pending subscribe completes after reconnect', async () => {
    let acknowledgeInitial!: (response: any) => void;
    let subscribeCalls = 0;
    hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/resource-io/subscribe') {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          return new Promise(resolve => { acknowledgeInitial = resolve; });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, subscriptionId: 'sub-current' }) });
      }
      if (path.startsWith('/api/resource-io/events?')) {
        return Promise.resolve({ ok: true, json: async () => ({ stale: true, latestSequence: 1, events: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    const { retainLocalFileResourceWatch, catchUpResourceEventsAfterReconnect } = await import('../../services/resource-events');
    const release = retainLocalFileResourceWatch('/tmp/reconnect.md');

    await catchUpResourceEventsAfterReconnect();
    expect(subscribeCalls).toBe(2);
    expect(hanaFetch).not.toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-current', expect.anything());

    acknowledgeInitial({ ok: true, json: async () => ({ ok: true, subscriptionId: 'sub-late' }) });
    await vi.waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-late', expect.objectContaining({ method: 'DELETE' }));
    });
    expect(hanaFetch).not.toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-current', expect.anything());
    release();
    await vi.waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-current', expect.objectContaining({ method: 'DELETE' }));
    });
  });

  it('releases a late subscription acknowledgement after the last watcher is disposed', async () => {
    let acknowledge!: (response: any) => void;
    hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/resource-io/subscribe') {
        return new Promise(resolve => { acknowledge = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    const { retainLocalFileResourceWatch } = await import('../../services/resource-events');
    const release = retainLocalFileResourceWatch('/tmp/disposed.md');
    release();
    acknowledge({ ok: true, json: async () => ({ ok: true, subscriptionId: 'sub-disposed' }) });
    await vi.waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-disposed', expect.objectContaining({ method: 'DELETE' }));
    });
  });

  it('repairs failed active watches before replay without resubscribing healthy leases', async () => {
    let subscribeCalls = 0;
    hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/resource-io/subscribe') {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          return { ok: false, status: 503, json: async () => ({ error: 'offline' }) };
        }
        return { ok: true, json: async () => ({ ok: true, subscriptionId: 'sub-recovered' }) };
      }
      if (path.startsWith('/api/resource-io/events?')) {
        return { ok: true, json: async () => ({ stale: false, latestSequence: 2, events: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { retainLocalFileResourceWatch, catchUpResourceEventsAfterReconnect } = await import('../../services/resource-events');
      const release = retainLocalFileResourceWatch('/tmp/recover.md');
      // Let the first attempt fail before reconnect; an in-flight subscribe
      // is deliberately not preempted by watch recovery.
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 0));
      await catchUpResourceEventsAfterReconnect();
      expect(subscribeCalls).toBe(2);
      const calls = hanaFetch.mock.calls.map(([url]) => url);
      expect(calls.indexOf('/api/resource-io/subscribe', 1)).toBeLessThan(
        calls.findIndex(url => url.startsWith('/api/resource-io/events?')),
      );
      await catchUpResourceEventsAfterReconnect();
      expect(subscribeCalls).toBe(2);
      release();
      await vi.waitFor(() => expect(hanaFetch).toHaveBeenCalledWith(
        '/api/resource-io/subscriptions/sub-recovered', expect.objectContaining({ method: 'DELETE' }),
      ));
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects catch-up while watch recovery fails, then retries on the next attempt', async () => {
    let subscribeCalls = 0;
    let eventFetches = 0;
    hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/resource-io/subscribe') {
        subscribeCalls++;
        return subscribeCalls < 3
          ? { ok: false, status: 503, json: async () => ({ error: 'offline' }) }
          : { ok: true, json: async () => ({ ok: true, subscriptionId: 'sub-ready' }) };
      }
      if (path.startsWith('/api/resource-io/events?')) {
        eventFetches++;
        return { ok: true, json: async () => ({ stale: false, latestSequence: 1, events: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { retainLocalFileResourceWatch, catchUpResourceEventsAfterReconnect } = await import('../../services/resource-events');
      const release = retainLocalFileResourceWatch('/tmp/transient.md');
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 0));
      await expect(catchUpResourceEventsAfterReconnect()).rejects.toThrow('watch recovery was not acknowledged');
      expect(eventFetches).toBe(0);
      await expect(catchUpResourceEventsAfterReconnect()).resolves.toMatchObject({ latestSequence: 1 });
      expect(subscribeCalls).toBe(3);
      expect(eventFetches).toBe(1);
      release();
    } finally {
      warn.mockRestore();
    }
  });

  it('makes each release callback idempotent and keeps a newer watcher for the same path', async () => {
    let subscribeCalls = 0;
    hanaFetch.mockImplementation(async (path: string) => {
      if (path === '/api/resource-io/subscribe') {
        subscribeCalls++;
        return { ok: true, json: async () => ({ ok: true, subscriptionId: `sub-${subscribeCalls}` }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const { retainLocalFileResourceWatch } = await import('../../services/resource-events');
    const releaseOld = retainLocalFileResourceWatch('/tmp/reused.md');
    await Promise.resolve();
    releaseOld();
    const releaseNew = retainLocalFileResourceWatch('/tmp/reused.md');
    await Promise.resolve();
    releaseOld(); // stale cleanup from a previous mount
    expect(subscribeCalls).toBe(2);
    expect(hanaFetch).not.toHaveBeenCalledWith('/api/resource-io/subscriptions/sub-2', expect.anything());
    releaseNew();
    releaseNew(); // duplicated cleanup must also be harmless
    await vi.waitFor(() => expect(hanaFetch).toHaveBeenCalledWith(
      '/api/resource-io/subscriptions/sub-2', expect.objectContaining({ method: 'DELETE' }),
    ));
    expect(hanaFetch.mock.calls.filter(([url]) => url === '/api/resource-io/subscriptions/sub-2')).toHaveLength(1);
  });

  it('requests catch-up after reconnect with the last seen resource event sequence', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ stale: false, latestSequence: 5, events: [] }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl });

    client.handleEvent({
      type: 'resource.changed',
      sequence: 4,
      resourceKey: 'local_fs:/tmp/a.md',
      resource: { kind: 'local-file', path: '/tmp/a.md' },
      changeType: 'modified',
      source: 'api',
      occurredAt: '2026-06-22T00:00:00.000Z',
    });
    await client.catchUpAfterReconnect();

    expect(fetchImpl).toHaveBeenCalledWith('/api/resource-io/events?since=4', expect.objectContaining({
      method: 'GET',
      throwOnHttpError: false,
    }));
  });

  it('applies caught-up resource events through the same event handler', async () => {
    const event = {
      type: 'resource.changed',
      sequence: 6,
      resourceKey: 'local_fs:/tmp/b.md',
      resource: { kind: 'local-file', path: '/tmp/b.md' },
      changeType: 'modified',
      source: 'provider_watch',
      occurredAt: '2026-06-22T00:00:01.000Z',
    };
    const applyEvent = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ stale: false, latestSequence: 6, events: [event] }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl, applyEvent });

    await client.catchUpAfterReconnect();

    expect(applyEvent).toHaveBeenCalledWith(event);
    expect(client.lastSeenSequence()).toBe(6);
  });

  it('rejects failed catch-up HTTP responses instead of treating them as empty event batches', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'resource_unavailable' }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl });
    client.handleEvent({ type: 'resource.changed', sequence: 9 });

    await expect(client.catchUpAfterReconnect()).rejects.toThrow('HTTP 503');
    expect(client.lastSeenSequence()).toBe(9);
  });

  it('rejects malformed/unsafe cursor values in catch-up responses', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ stale: false, latestSequence: Number.MAX_SAFE_INTEGER + 1, events: [] }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl });
    client.handleEvent({ type: 'resource.changed', sequence: 8 });

    await expect(client.catchUpAfterReconnect()).rejects.toThrow('invalid event batch');
    client.handleEvent({ type: 'resource.changed', sequence: Number.MAX_SAFE_INTEGER + 1 });
    expect(client.lastSeenSequence()).toBe(8);
  });

  it('coalesces overlapping catch-ups and applies one batch once', async () => {
    let release!: (response: any) => void;
    const fetchImpl = vi.fn(() => new Promise<any>(resolve => { release = resolve; }));
    const applyEvent = vi.fn();
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl, applyEvent });
    client.handleEvent({ type: 'resource.changed', sequence: 4 });

    const first = client.catchUpAfterReconnect();
    const second = client.catchUpAfterReconnect();
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release({
      ok: true, json: async () => ({
        stale: false, latestSequence: 6,
        events: [
          { type: 'resource.changed', sequence: 5 },
          { type: 'resource.changed', sequence: 6 },
        ],
      }),
    });
    await Promise.all([first, second]);
    expect(applyEvent).toHaveBeenCalledTimes(2);
    expect(client.lastSeenSequence()).toBe(6);
  });

  it('validates a whole event batch before applying any events or advancing the cursor', async () => {
    const applyEvent = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        stale: false, latestSequence: 7,
        events: [
          { type: 'resource.changed', sequence: 5 },
          { type: 'resource.deleted', sequence: 5 },
        ],
      }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl, applyEvent });
    client.handleEvent({ type: 'resource.changed', sequence: 4 });

    await expect(client.catchUpAfterReconnect()).rejects.toThrow('invalid event batch');
    expect(applyEvent).not.toHaveBeenCalled();
    expect(client.lastSeenSequence()).toBe(4);
  });

  it('does not replay old catch-up events over a newer live resource event', async () => {
    let release!: (response: any) => void;
    const fetchImpl = vi.fn(() => new Promise<any>(resolve => { release = resolve; }));
    const applyEvent = vi.fn();
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl, applyEvent });

    client.handleEvent({ type: 'resource.changed', sequence: 4 });
    const pending = client.catchUpAfterReconnect();
    client.handleEvent({ type: 'resource.changed', sequence: 7 });
    release({
      ok: true, json: async () => ({
        stale: false, latestSequence: 7,
        events: [
          { type: 'resource.changed', sequence: 5 },
          { type: 'resource.changed', sequence: 6 },
          { type: 'resource.changed', sequence: 7 },
        ],
      }),
    });
    await pending;
    expect(applyEvent).not.toHaveBeenCalled();
    expect(client.lastSeenSequence()).toBe(7);
  });

  it('permits a new catch-up after an HTTP failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 503, json: async () => ({ error: 'unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true, json: async () => ({ stale: false, latestSequence: 2, events: [] }),
      });
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl });
    await expect(client.catchUpAfterReconnect()).rejects.toThrow('HTTP 503');
    await expect(client.catchUpAfterReconnect()).resolves.toMatchObject({ latestSequence: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not acknowledge an event if its application fails', async () => {
    const applyEvent = vi.fn(() => { throw new Error('projection failed'); });
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({
        stale: false, latestSequence: 6,
        events: [{ type: 'resource.changed', sequence: 6 }],
      }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl, applyEvent });
    client.handleEvent({ type: 'resource.changed', sequence: 5 });
    await expect(client.catchUpAfterReconnect()).rejects.toThrow('projection failed');
    expect(client.lastSeenSequence()).toBe(5);
  });

  it('adopts the new server sequence after an acknowledged stale-cursor resubscription', async () => {
    const resubscribeWatches = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({
        stale: true, latestSequence: 2, events: [],
      }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl, resubscribeWatches });
    client.handleEvent({ type: 'resource.changed', sequence: 99 });

    await client.catchUpAfterReconnect();
    expect(resubscribeWatches).toHaveBeenCalledOnce();
    expect(client.lastSeenSequence()).toBe(2);
    await client.catchUpAfterReconnect();
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/resource-io/events?since=2', expect.anything());
  });

  it('retains the old cursor if stale watcher resubscription fails', async () => {
    const resubscribeWatches = vi.fn(async () => { throw new Error('sub failed'); });
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({ stale: true, latestSequence: 2, events: [] }),
    }));
    const { createResourceEventClient } = await import('../../services/resource-events');
    const client = createResourceEventClient({ fetchImpl, resubscribeWatches });
    client.handleEvent({ type: 'resource.changed', sequence: 99 });
    await expect(client.catchUpAfterReconnect()).rejects.toThrow('sub failed');
    expect(client.lastSeenSequence()).toBe(99);
  });

  it('does not accept an HTTP failure merely because it contains a subscriptionId', async () => {
    hanaFetch.mockResolvedValueOnce({
      ok: false, status: 503,
      json: async () => ({ ok: true, subscriptionId: 'fake-sub' }),
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { retainLocalFileResourceWatch } = await import('../../services/resource-events');
      const release = retainLocalFileResourceWatch('/tmp/failed.md');
      await new Promise(resolve => setTimeout(resolve, 0));
      release();
      await Promise.resolve();
      expect(hanaFetch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[resource-events] watch failed:', expect.objectContaining({ message: 'Resource watch HTTP 503' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not accept an unacknowledged success-status resource subscription', async () => {
    hanaFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ ok: false, subscriptionId: 'fake-sub' }),
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { retainLocalFileResourceWatch } = await import('../../services/resource-events');
      const release = retainLocalFileResourceWatch('/tmp/missing-ack.md');
      await new Promise(resolve => setTimeout(resolve, 0));
      release();
      await Promise.resolve();
      expect(hanaFetch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[resource-events] watch failed:', expect.objectContaining({ message: 'Resource watch was not acknowledged' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('retries foreground catch-up immediately after a failed attempt even within the throttle window', async () => {
    const listeners = new Map<string, () => void>();
    const windowObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
      removeEventListener: vi.fn(),
    };
    const documentObj = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    };
    const catchUp = vi.fn()
      .mockImplementationOnce(() => { throw new Error('transport unavailable'); })
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { bindResourceEventForegroundCatchUp } = await import('../../services/resource-events');
      const dispose = bindResourceEventForegroundCatchUp(undefined, {
        windowObj: windowObj as never,
        documentObj: documentObj as never,
        catchUp,
        minIntervalMs: 10_000,
        now: () => 1000,
      });

      listeners.get('focus')?.();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        '[resource-events] foreground catch-up failed:', expect.objectContaining({ message: 'transport unavailable' }),
      ));
      listeners.get('focus')?.();
      await vi.waitFor(() => expect(catchUp).toHaveBeenCalledTimes(2));
      dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it('requests ResourceIO catch-up when the renderer returns to the foreground', async () => {
    const listeners = new Map<string, () => void>();
    const windowObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`window:${type}`, listener)),
      removeEventListener: vi.fn(),
    };
    let visibilityState: Document['visibilityState'] = 'hidden';
    const documentObj = {
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(`document:${type}`, listener)),
      removeEventListener: vi.fn(),
      get visibilityState() {
        return visibilityState;
      },
    };
    const catchUp = vi.fn(async () => undefined);
    const { bindResourceEventForegroundCatchUp } = await import('../../services/resource-events');

    const dispose = bindResourceEventForegroundCatchUp(undefined, {
      windowObj: windowObj as never,
      documentObj: documentObj as never,
      catchUp,
      minIntervalMs: 0,
      now: () => 100,
    });

    listeners.get('window:focus')?.();
    expect(catchUp).not.toHaveBeenCalled();

    visibilityState = 'visible';
    listeners.get('document:visibilitychange')?.();
    await Promise.resolve();

    expect(catchUp).toHaveBeenCalledTimes(1);
    dispose();
    expect(windowObj.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(documentObj.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
