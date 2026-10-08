import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hanaFetch: vi.fn() }));
vi.mock('../../hooks/use-hana-fetch', () => ({ hanaFetch: mocks.hanaFetch }));
import { retryFailedImageTask, refreshMediaTask } from '../../services/media-generation-tasks';

const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

describe('media task recovery', () => {
  beforeEach(() => mocks.hanaFetch.mockReset());

  it('retries only when the backend confirms the same image task is pending', async () => {
    const placeholder = { type: 'media_generation', kind: 'image', taskId: 'task-1', status: 'pending' };
    mocks.hanaFetch.mockResolvedValue(response({ ok: true, taskId: 'task-1', placeholder }));
    await expect(retryFailedImageTask('task-1')).resolves.toEqual(placeholder);
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/media/tasks/task-1/retry',
      expect.objectContaining({ method: 'POST', throwOnHttpError: false }));
  });

  it('rejects false success, wrong task identity, and invalid pending placeholder', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: false, taskId: 'task-1' }));
    await expect(retryFailedImageTask('task-1')).rejects.toThrow('not acknowledged');
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: true, taskId: 'another', placeholder: { taskId: 'another', status: 'pending' } }));
    await expect(retryFailedImageTask('task-1')).rejects.toThrow('not acknowledged');
    mocks.hanaFetch.mockResolvedValueOnce(response({ ok: true, taskId: 'task-1', placeholder: { taskId: 'task-1', status: 'done' } }));
    await expect(retryFailedImageTask('task-1')).rejects.toThrow('not acknowledged');
    mocks.hanaFetch.mockResolvedValueOnce(response({ error: 'task already running' }, 409));
    await expect(retryFailedImageTask('task-1')).rejects.toThrow('task already running');
  });

  it('refreshes a pending or failed task into a real media placeholder', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(response({
      task: { taskId: 'task-1', type: 'video', status: 'pending', prompt: 'Scene', sessionPath: '/sessions/a' },
    }));
    await expect(refreshMediaTask('task-1', '/sessions/a')).resolves.toMatchObject({
      type: 'media_generation', status: 'pending', kind: 'video',
    });
    mocks.hanaFetch.mockResolvedValueOnce(response({
      task: { taskId: 'task-1', type: 'image', status: 'failed', failReason: 'provider error', sessionPath: '/sessions/a' },
    }));
    await expect(refreshMediaTask('task-1', '/sessions/a')).resolves.toMatchObject({
      type: 'media_generation', status: 'failed', reason: 'provider error',
    });
  });

  it('recovers real registered generated files from completed tasks', async () => {
    mocks.hanaFetch.mockResolvedValue(response({ task: {
      taskId: 'task-1', type: 'image', status: 'done', sessionPath: '/sessions/a',
      sessionFiles: [{ fileId: 'file-1', filePath: '/outputs/image.png', label: 'image.png' }],
    } }));
    await expect(refreshMediaTask('task-1', '/sessions/a')).resolves.toEqual({
      type: 'file', fileId: 'file-1', filePath: '/outputs/image.png', label: 'image.png',
      ext: 'png', kind: 'image', replacesTaskId: 'task-1',
    });
  });

  it('rejects completed tasks without registered output and another session task', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(response({
      task: { taskId: 'task-1', type: 'image', status: 'done', sessionFiles: [] },
    }));
    await expect(refreshMediaTask('task-1', '/sessions/a')).rejects.toThrow('no registered output');
    mocks.hanaFetch.mockResolvedValueOnce(response({
      task: { taskId: 'task-1', type: 'image', status: 'pending', sessionPath: '/sessions/other' },
    }));
    await expect(refreshMediaTask('task-1', '/sessions/a')).rejects.toThrow('identity');
  });
});
