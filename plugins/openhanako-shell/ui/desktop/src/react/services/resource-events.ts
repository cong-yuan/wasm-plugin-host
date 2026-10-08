import { hanaFetch } from '../hooks/use-hana-fetch';

export type ResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string };

type WatchEntry = {
  ref: ResourceRef;
  refCount: number;
  subscriptionId: string | null;
  subscriptionGeneration: number;
  subscribing: boolean;
  disposed: boolean;
  released: boolean;
  ready: Promise<void>;
};

const watches = new Map<string, WatchEntry>();

type ResourceEvent = {
  type?: string;
  sequence?: number;
  [key: string]: unknown;
};

type ResourceEventFetch = (
  path: string,
  opts?: RequestInit & { timeout?: number; throwOnHttpError?: boolean },
) => Promise<{ ok?: boolean; status?: number; json: () => Promise<any> }>;

type ResourceEventClientOptions = {
  fetchImpl?: ResourceEventFetch;
  applyEvent?: (event: ResourceEvent) => void;
  resubscribeWatches?: () => Promise<void> | void;
  ensureWatches?: () => Promise<void> | void;
};

type ForegroundCatchUpOptions = {
  windowObj?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  documentObj?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
  catchUp?: () => Promise<unknown> | unknown;
  minIntervalMs?: number;
  now?: () => number;
};

export function createResourceEventClient({
  fetchImpl = hanaFetch,
  applyEvent,
  resubscribeWatches,
  ensureWatches,
}: ResourceEventClientOptions = {}) {
  let lastSeenSequence = 0;
  let catchUpInFlight: Promise<any> | null = null;

  const handleEvent = (event: ResourceEvent | null | undefined): void => {
    if (!isResourceEvent(event)) return;
    if (Number.isSafeInteger(event.sequence) && Number(event.sequence) >= 0 && Number(event.sequence) > lastSeenSequence) {
      lastSeenSequence = Number(event.sequence);
    }
  };

  const catchUpAfterReconnect = (options: { applyEvent?: (event: ResourceEvent) => void } = {}) => {
    // Focus, visibility and websocket recovery can overlap. Share one request
    // and dispatch its events only once; a failure must still permit a retry.
    if (catchUpInFlight) return catchUpInFlight;
    const pending = (async () => {
      // Restore missing subscriptions before fetching events; otherwise a
      // freshly recovered watch could miss changes between replay and reattach.
      if (ensureWatches) await ensureWatches();
      const cursorAtStart = lastSeenSequence;
      const res = await fetchImpl(`/api/resource-io/events?since=${lastSeenSequence}`, {
        method: 'GET',
        throwOnHttpError: false,
      });
      if (res.ok === false) {
        throw new Error(`Resource catch-up failed (HTTP ${res.status || 'unknown'})`);
      }
      const data = await res.json();
      if (!data || typeof data.stale !== 'boolean'
        || !Number.isSafeInteger(data.latestSequence) || data.latestSequence < 0
        || !Array.isArray(data.events)) {
        throw new Error('Resource catch-up returned an invalid event batch');
      }
      if (!data.stale && data.latestSequence < cursorAtStart) {
        throw new Error('Resource catch-up returned an older event sequence');
      }
      if (data.stale) {
        await resubscribeWatches?.();
        // Server restart may reset its event sequence to a smaller value.
        // Once watches are reattached, adopt that new epoch rather than
        // requesting the permanently stale old cursor on every reconnect.
        if (lastSeenSequence === cursorAtStart || data.latestSequence >= lastSeenSequence) {
          lastSeenSequence = data.latestSequence;
        }
        return data;
      }

      // Validate the entire response before dispatching anything. A malformed
      // or out-of-order batch must not partially mutate editor state.
      let prior = cursorAtStart;
      for (const event of data.events) {
        if (!isResourceEvent(event)
          || !Number.isSafeInteger(event.sequence)
          || event.sequence! <= prior
          || event.sequence! > data.latestSequence) {
          throw new Error('Resource catch-up returned an invalid event batch');
        }
        prior = event.sequence!;
      }
      const handler = options.applyEvent || applyEvent;
      for (const event of data.events) {
        // Newer live events may have arrived while catch-up was in flight.
        // Never replay an older event on top of a newer editor projection.
        if (event.sequence! <= lastSeenSequence) continue;
        handler?.(event);
        handleEvent(event);
      }
      if (data.latestSequence > lastSeenSequence) {
        lastSeenSequence = data.latestSequence;
      }
      return data;
    })();
    catchUpInFlight = pending;
    void pending.then(
      () => { if (catchUpInFlight === pending) catchUpInFlight = null; },
      () => { if (catchUpInFlight === pending) catchUpInFlight = null; },
    );
    return pending;
  };

  return {
    handleEvent,
    catchUpAfterReconnect,
    lastSeenSequence: () => lastSeenSequence,
  };
}

const resourceEventClient = createResourceEventClient({
  fetchImpl: hanaFetch,
  resubscribeWatches: resubscribeActiveWatches,
  ensureWatches: ensureActiveResourceWatches,
});

function normalizeResourceRef(ref: ResourceRef): ResourceRef {
  if (ref.kind === 'local-file') {
    return { kind: 'local-file', path: ref.path };
  }
  return {
    kind: 'mount',
    mountId: ref.mountId,
    path: String(ref.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  };
}

export function resourceWatchKey(ref: ResourceRef): string {
  const normalized = normalizeResourceRef(ref);
  if (normalized.kind === 'local-file') {
    const slashed = normalized.path.replace(/\\/g, '/').replace(/\/+$/g, '');
    return `local-file:${/^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed}`;
  }
  return `mount:${normalized.mountId}:${normalized.path}`;
}

export function retainResourceWatch(ref: ResourceRef): () => void {
  const normalizedRef = normalizeResourceRef(ref);
  const key = resourceWatchKey(normalizedRef);
  const existing = watches.get(key);
  if (existing) {
    existing.refCount += 1;
    return releaseHandle(key, existing);
  }

  const entry: WatchEntry = {
    ref: normalizedRef,
    refCount: 1,
    subscriptionId: null,
    subscriptionGeneration: 0,
    subscribing: false,
    disposed: false,
    released: false,
    ready: Promise.resolve(),
  };
  entry.ready = subscribeEntry(entry);
  watches.set(key, entry);
  return releaseHandle(key, entry);
}

function releaseHandle(key: string, entry: WatchEntry): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseResourceWatch(key, entry);
  };
}

function subscribeEntry(entry: WatchEntry): Promise<void> {
  const generation = ++entry.subscriptionGeneration;
  entry.released = false;
  entry.subscribing = true;
  return hanaFetch('/api/resource-io/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'resource-watch', resources: [entry.ref] }),
    throwOnHttpError: false,
  })
    .then(async res => {
      if (res.ok === false) throw new Error(`Resource watch HTTP ${res.status ?? 'unknown'}`);
      const data = await res.json();
      if (data?.ok !== true || typeof data.subscriptionId !== 'string' || !data.subscriptionId) {
        throw new Error('Resource watch was not acknowledged');
      }
      if (entry.disposed || generation !== entry.subscriptionGeneration) {
        // A late acknowledgement belongs to an obsolete request. Do not
        // overwrite the current subscription or leak the superseded lease.
        releaseSubscriptionId(data.subscriptionId);
        return;
      }
      entry.subscriptionId = data.subscriptionId;
    })
    .catch((err) => {
      if (!entry.disposed && generation === entry.subscriptionGeneration) console.warn('[resource-events] watch failed:', err);
    })
    .finally(() => {
      if (generation === entry.subscriptionGeneration) entry.subscribing = false;
    });
}

export function retainLocalFileResourceWatch(filePath: string): () => void {
  return retainResourceWatch({ kind: 'local-file', path: filePath });
}

function releaseResourceWatch(key: string, entry: WatchEntry): void {
  // A stale React effect must never release a newly mounted watcher for the
  // same path, nor may a callback run more than once.
  if (watches.get(key) !== entry || entry.disposed) return;
  if (entry.refCount > 1) {
    entry.refCount -= 1;
    return;
  }
  watches.delete(key);
  entry.disposed = true;
  void entry.ready.then(() => releaseEntry(entry));
}

function releaseSubscriptionId(subscriptionId: string): void {
  void hanaFetch(`/api/resource-io/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    throwOnHttpError: false,
  }).then((response) => {
    if (response.ok === false) {
      console.warn('[resource-events] unwatch failed:', `HTTP ${response.status ?? 'unknown'}`);
    }
  }).catch((err) => {
    console.warn('[resource-events] unwatch failed:', err);
  });
}

function releaseEntry(entry: WatchEntry): void {
  if (entry.released || !entry.subscriptionId) return;
  entry.released = true;
  const id = entry.subscriptionId;
  entry.subscriptionId = null;
  releaseSubscriptionId(id);
}

async function ensureActiveResourceWatches(): Promise<void> {
  const entries = [...watches.values()].filter(entry => !entry.disposed);
  await Promise.all(entries.map(async entry => {
    // Do not block reconnect on an unresolved original subscribe; the next
    // foreground/reconnect recovery will retry it if it eventually fails.
    if (entry.disposed || entry.subscriptionId || entry.subscribing) return;
    entry.ready = subscribeEntry(entry);
    await entry.ready;
    if (!entry.disposed && !entry.subscriptionId) {
      throw new Error('Resource watch recovery was not acknowledged');
    }
  }));
}

async function resubscribeActiveWatches(): Promise<void> {
  const entries = [...watches.values()].filter(entry => !entry.disposed);
  await Promise.all(entries.map(async (entry) => {
    // Invalidate outstanding subscribe acknowledgements BEFORE awaiting any
    // transport operation. This prevents the old response from overwriting
    // a newer subscription while the reconnect cleanup is in progress.
    ++entry.subscriptionGeneration;
    const previousSubscriptionId = entry.subscriptionId;
    entry.subscriptionId = null;
    if (previousSubscriptionId) {
      releaseSubscriptionId(previousSubscriptionId);
    }
    if (!entry.disposed) entry.ready = subscribeEntry(entry);
    await entry.ready;
    // subscribeEntry logs a failure for ordinary mounting; reconnect
    // must additionally fail closed rather than pretending watches exist.
    if (!entry.disposed && !entry.subscriptionId) {
      throw new Error('Resource watch resubscription was not acknowledged');
    }
  }));
}

function isResourceEvent(event: ResourceEvent | null | undefined): event is ResourceEvent {
  return event?.type === 'resource.changed' || event?.type === 'resource.deleted' || event?.type === 'resource.renamed';
}

export function recordResourceEventCursor(event: ResourceEvent | null | undefined): void {
  resourceEventClient.handleEvent(event);
}

/**
 * Process a WebSocket frame before acknowledging its resource cursor.
 * If projection fails synchronously, leave the cursor unchanged so reconnect
 * catch-up can replay the event. Non-resource frames leave the cursor alone.
 */
export function dispatchServerMessageAndRecordResourceCursor(
  event: ResourceEvent,
  dispatch: (message: ResourceEvent) => void,
): void {
  dispatch(event);
  recordResourceEventCursor(event);
}

export function catchUpResourceEventsAfterReconnect(applyEvent?: (event: ResourceEvent) => void): Promise<unknown> {
  return resourceEventClient.catchUpAfterReconnect({ applyEvent });
}

export function bindResourceEventForegroundCatchUp(
  applyEvent?: (event: ResourceEvent) => void,
  options: ForegroundCatchUpOptions = {},
): () => void {
  const windowObj = options.windowObj ?? (typeof window !== 'undefined' ? window : null);
  const documentObj = options.documentObj ?? (typeof document !== 'undefined' ? document : null);
  if (!windowObj || !documentObj) return () => {};

  const minIntervalMs = Math.max(0, Math.floor(Number(options.minIntervalMs ?? 1000) || 0));
  const now = options.now ?? (() => Date.now());
  const catchUp = options.catchUp ?? (() => catchUpResourceEventsAfterReconnect(applyEvent));
  let inFlight = false;
  let lastStartedAt = 0;

  const run = () => {
    if (documentObj.visibilityState === 'hidden') return;
    const startedAt = now();
    if (inFlight || (lastStartedAt && startedAt - lastStartedAt < minIntervalMs)) return;
    inFlight = true;
    lastStartedAt = startedAt;
    Promise.resolve().then(() => catchUp())
      .catch((err) => {
        // A failed catch-up must not hold the foreground throttle until the
        // next interval; allow the user to retry immediately on focus.
        lastStartedAt = 0;
        console.warn('[resource-events] foreground catch-up failed:', err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const onVisibilityChange = () => {
    if (documentObj.visibilityState === 'visible') run();
  };

  windowObj.addEventListener('focus', run);
  documentObj.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    windowObj.removeEventListener('focus', run);
    documentObj.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
