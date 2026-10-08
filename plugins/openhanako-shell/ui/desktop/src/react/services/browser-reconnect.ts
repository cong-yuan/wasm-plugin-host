import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';
import {
  browserStateForPath,
  setBrowserStateForPath,
} from '../stores/browser-slice';

type BrowserRuntimeStatus = {
  running: boolean;
  url: string | null;
};

/**
 * The websocket can disconnect without delivering the final browser_status.
 * Reconcile the server's authoritative running/stopped sessions after reconnect.
 * Keep a browser event received while the HTTP request was pending authoritative
 * over the older snapshot, and never reuse a previous page's screenshot.
 */
export async function reconcileBrowserSessionsAfterReconnect(
  isCurrentConnection: () => boolean = () => true,
): Promise<void> {
  const initial = useStore.getState();
  // Capture the per-session values at request start. An in-flight status fetch
  // must not compare against a later mutation of the same store object.
  const before = { ...initial, browserBySession: { ...(initial.browserBySession || {}) } };
  const response = await hanaFetch('/api/browser/session-states', {
    method: 'GET',
    throwOnHttpError: false,
  });
  if (!response.ok) throw new Error(`Browser status refresh failed (HTTP ${response.status})`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid browser status snapshot');
  }

  const statuses: Record<string, BrowserRuntimeStatus> = {};
  for (const [sessionPath, raw] of Object.entries(data)) {
    if (!sessionPath || !raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof (raw as any).running !== 'boolean'
      || !((raw as any).url === null || typeof (raw as any).url === 'string')) {
      throw new Error('Invalid browser status snapshot');
    }
    statuses[sessionPath] = {
      running: (raw as any).running,
      url: (raw as any).url,
    };
  }
  if (!isCurrentConnection()) return;

  const paths = new Set<string>(
    Object.entries(statuses).filter(([, status]) => status.running).map(([path]) => path),
  );
  for (const key of Object.keys(before.browserBySession || {})) {
    const resolvedPath = before.sessionLocatorsById?.[key]?.path;
    if (typeof resolvedPath === 'string' && resolvedPath) paths.add(resolvedPath);
    else if (key.startsWith('/') || /^[A-Za-z]:[\\/]/.test(key)) paths.add(key);
  }
  if (before.currentSessionPath) paths.add(before.currentSessionPath);

  for (const path of paths) {
    if (!isCurrentConnection()) return;
    const original = browserStateForPath(before, path);
    const current = browserStateForPath(useStore.getState(), path);
    if (current !== original) continue; // A live websocket event already updated it.
    const remote = statuses[path];
    if (!remote?.running) {
      if (!current.running) continue;
      setBrowserStateForPath(path, {
        running: false, url: null, thumbnail: null,
        thumbnailCapturedAt: null, thumbnailUrl: null, thumbnailFresh: false,
        collapsed: current.collapsed ?? false,
      });
      continue;
    }
    const samePage = current.running && current.url === remote.url;
    setBrowserStateForPath(path, {
      running: true, url: remote.url,
      thumbnail: samePage ? current.thumbnail : null,
      thumbnailCapturedAt: samePage ? current.thumbnailCapturedAt ?? null : null,
      thumbnailUrl: samePage ? current.thumbnailUrl ?? null : null,
      thumbnailFresh: false,
      collapsed: current.running ? (current.collapsed ?? false) : false,
    });
  }
}
