import { hanaFetch } from '../hooks/use-hana-fetch';

export type UserEditCheckpointReason = 'edit-start' | 'autosave-interval';

export async function requestUserEditCheckpoint(
  filePath: string,
  reason: UserEditCheckpointReason,
): Promise<void> {
  const res = await hanaFetch('/api/checkpoints/user-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, reason }),
  });
  const data = await res.json();
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error || 'Checkpoint creation was not acknowledged');
  }
}
