import { hanaFetch } from '../hooks/use-hana-fetch';
import type { ContentBlock } from '../stores/chat-types';

async function readMediaTaskResponse(path: string, opts?: RequestInit): Promise<any> {
  const response = await hanaFetch(path, { ...opts, throwOnHttpError: false });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== 'object') {
    throw new Error(data?.error || 'Media task request failed');
  }
  return data;
}

export async function retryFailedImageTask(taskId: string): Promise<ContentBlock> {
  if (!taskId) throw new Error('Missing media task');
  const data = await readMediaTaskResponse(
    `/api/media/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' },
  );
  const block = data.placeholder;
  if (data.ok !== true || data.taskId !== taskId || !block
    || block.type !== 'media_generation' || block.taskId !== taskId
    || block.kind !== 'image' || block.status !== 'pending') {
    throw new Error('Media retry was not acknowledged');
  }
  return block as ContentBlock;
}

/**
 * Manually reconcile a placeholder after reconnect or a long-running job.
 * Only show a completed artifact if the backend registered a real SessionFile;
 * an empty or malformed "done" result is never fabricated into a file.
 */
export async function refreshMediaTask(taskId: string, sessionPath: string): Promise<ContentBlock> {
  if (!taskId || !sessionPath) throw new Error('Missing media task or session');
  const data = await readMediaTaskResponse(`/api/media/tasks/${encodeURIComponent(taskId)}`);
  const task = data.task;
  if (!task || task.taskId !== taskId
    || (typeof task.sessionPath === 'string' && task.sessionPath !== sessionPath)) {
    throw new Error('Media task identity does not match the current session');
  }
  const kind = task.type === 'video' ? 'video' : 'image';
  if (task.status === 'failed' || task.status === 'aborted') {
    return {
      type: 'media_generation', taskId, kind, status: task.status,
      ...(typeof task.prompt === 'string' ? { prompt: task.prompt } : {}),
      reason: typeof task.failReason === 'string' ? task.failReason : '',
    };
  }
  if (task.status === 'done') {
    const files = Array.isArray(task.sessionFiles) ? task.sessionFiles : [];
    const registered = files.find((item: any) =>
      item && typeof (item.filePath || item.path) === 'string'
      && (item.filePath || item.path).length > 0,
    );
    if (!registered) throw new Error('Completed media task has no registered output file');
    const filePath = registered.filePath || registered.path;
    const label = typeof registered.label === 'string' && registered.label
      ? registered.label : filePath.split(/[\\/]/).pop() || filePath;
    const ext = label.includes('.') ? label.split('.').pop()?.toLowerCase() || '' : '';
    return {
      type: 'file', fileId: registered.fileId,
      filePath, label, ext, kind,
      replacesTaskId: taskId,
    };
  }
  if (task.status === 'pending' || task.status === 'running' || task.status === 'submitting') {
    return {
      type: 'media_generation', taskId, kind, status: 'pending',
      ...(typeof task.prompt === 'string' ? { prompt: task.prompt } : {}),
    };
  }
  throw new Error('Unknown media task state');
}
