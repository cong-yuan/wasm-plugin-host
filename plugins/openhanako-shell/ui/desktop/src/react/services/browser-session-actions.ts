import { hanaFetch } from '../hooks/use-hana-fetch';

function requireSessionPath(sessionPath: string): void {
  if (typeof sessionPath !== 'string' || !sessionPath.trim()) {
    throw new Error('Browser action requires a session path');
  }
}

async function requestBrowserAction(url: string, sessionPath: string): Promise<any> {
  requireSessionPath(sessionPath);
  const res = await hanaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath }),
    throwOnHttpError: false,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.ok !== true) {
    throw new Error(payload?.error || 'Browser action was not acknowledged');
  }
  return payload;
}

/** Never open a viewer unless the backend successfully selected its session. */
export async function openSessionBrowser(sessionPath: string): Promise<void> {
  await requestBrowserAction('/api/browser/open-session', sessionPath);
}

/** Close is authoritative only after the server returns its session snapshot. */
export async function closeSessionBrowser(sessionPath: string): Promise<Record<string, unknown>> {
  const payload = await requestBrowserAction('/api/browser/close-session', sessionPath);
  if (!payload.sessions || typeof payload.sessions !== 'object' || Array.isArray(payload.sessions)) {
    throw new Error('Browser close returned no authoritative session state');
  }
  const target = payload.sessions[sessionPath];
  if (target && (typeof target === 'string'
    || typeof target !== 'object' || target.running === true)) {
    throw new Error('Browser session is still running after close');
  }
  return payload.sessions;
}
