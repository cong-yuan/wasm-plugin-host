import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hanaFetchMock = vi.fn();
const setStateMock = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (...args: unknown[]) => hanaFetchMock(...args),
}));

vi.mock('../../stores', () => ({
  useStore: {
    setState: (...args: unknown[]) => setStateMock(...args),
    getState: () => ({ setSessionProjectCatalog: vi.fn() }),
  },
}));

import { setSessionProjectAssignmentForSession } from '../../stores/session-project-actions';

function response(data: unknown, ok = true) {
  return {
    ok,
    json: async () => data,
  };
}

describe('setSessionProjectAssignmentForSession', () => {
  beforeEach(() => {
    hanaFetchMock.mockReset();
    setStateMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not update local session state when the assignment API rejects', async () => {
    hanaFetchMock.mockResolvedValue(response({ ok: false, error: 'project not found' }, false));

    await expect(setSessionProjectAssignmentForSession('/session/a', 'missing-project'))
      .rejects.toThrow('project not found');

    expect(setStateMock).not.toHaveBeenCalled();
  });

  it('updates local session state only after a successful assignment response', async () => {
    hanaFetchMock.mockResolvedValue(response({ ok: true, assignment: { sessionPath: '/session/a', projectId: 'project-a' } }));

    await setSessionProjectAssignmentForSession('/session/a', 'project-a');

    expect(hanaFetchMock).toHaveBeenCalledWith('/api/session-projects/session-assignment', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionPath: '/session/a', projectId: 'project-a' }),
      throwOnHttpError: false,
    }));
    expect(setStateMock).toHaveBeenCalledTimes(1);
  });
});
