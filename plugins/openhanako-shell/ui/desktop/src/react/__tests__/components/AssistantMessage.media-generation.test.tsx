// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../components/chat/AssistantMessage';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

vi.mock('../../utils/screenshot', () => ({
  takeScreenshot: vi.fn(),
}));

describe('AssistantMessage media generation placeholder', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    (window as any).platform = {
      getFileUrl: (filePath: string) => `file://${filePath}`,
      startDrag: vi.fn(),
    };
    useStore.setState({
      agents: [],
      agentName: 'Hanako',
      agentYuan: 'hanako',
      mediaViewer: null,
      streamingSessions: [],
      selectedMessageIdsBySession: {},
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a grey image placeholder with inline status text and cycling dot slot', () => {
    const { container } = render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'media_generation',
            taskId: 'task-img',
            kind: 'image',
            status: 'pending',
            prompt: 'Low-poly 3D illustration of a Chinese college student character sitting at the front row of a classroom',
          }],
        }}
      />,
    );

    expect(screen.getByLabelText('chat.media.generationInProgress...')).toBeInTheDocument();
    expect(container.querySelector('[class*="mediaGenerationDots"]')).toBeInTheDocument();
    expect(screen.getByText(/^Low-poly 3D illustration/)).toBeInTheDocument();
  });

  it('retries a failed image placeholder in place without sending a new agent turn', async () => {
    const resolveBlockByTaskId = vi.fn(() => true);
    useStore.setState({
      resolveBlockByTaskId,
    } as never);
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      taskId: 'task-img',
      placeholder: {
        type: 'media_generation',
        taskId: 'task-img',
        kind: 'image',
        status: 'pending',
        prompt: 'same prompt',
      },
    }), { status: 200 }));

    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'media_generation',
            taskId: 'task-img',
            kind: 'image',
            status: 'failed',
            reason: 'API returned no images',
            prompt: 'same prompt',
          }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.media.retryLabel' }));

    await waitFor(() => {
      expect(hanaFetch).toHaveBeenCalledWith('/api/media/tasks/task-img/retry', {
        method: 'POST',
        throwOnHttpError: false,
      });
    });
    expect(resolveBlockByTaskId).toHaveBeenCalledWith('/sessions/main.jsonl', 'task-img', expect.objectContaining({
      type: 'media_generation',
      taskId: 'task-img',
      kind: 'image',
      status: 'pending',
      prompt: 'same prompt',
    }));
  });

  it('keeps failed image retry visible on a false-success server response', async () => {
    const resolveBlockByTaskId = vi.fn(() => true);
    useStore.setState({ resolveBlockByTaskId } as never);
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 200 }));
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false} isSelected={false} showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{ id: 'retry-error', role: 'assistant', blocks: [{
          type: 'media_generation', taskId: 'task-img', kind: 'image', status: 'failed', reason: 'previous error',
        }] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'chat.media.retryLabel' }));
    expect(await screen.findByText('Media retry was not acknowledged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'chat.media.retryLabel' })).not.toBeDisabled();
    expect(resolveBlockByTaskId).not.toHaveBeenCalled();
  });

  it('refreshes a pending media placeholder from backend failure status without a new agent turn', async () => {
    const resolveBlockByTaskId = vi.fn(() => true);
    useStore.setState({ resolveBlockByTaskId } as never);
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      task: {
        taskId: 'task-video', type: 'video', status: 'failed',
        failReason: 'provider timed out', sessionPath: '/sessions/main.jsonl',
      },
    }), { status: 200 }));
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false} isSelected={false} showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{ id: 'refresh-pending', role: 'assistant', blocks: [{
          type: 'media_generation', taskId: 'task-video', kind: 'video', status: 'pending',
        }] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'chat.media.refreshStatus' }));
    await waitFor(() => {
      expect(resolveBlockByTaskId).toHaveBeenCalledWith('/sessions/main.jsonl', 'task-video', expect.objectContaining({
        type: 'media_generation', taskId: 'task-video', status: 'failed', reason: 'provider timed out',
      }));
    });
    expect(await screen.findByText('provider timed out')).toBeInTheDocument();
  });

  it('recovers a completed task into a registered file without rerunning generation', async () => {
    const resolveBlockByTaskId = vi.fn(() => true);
    useStore.setState({ resolveBlockByTaskId } as never);
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      task: {
        taskId: 'task-img', type: 'image', status: 'done',
        sessionPath: '/sessions/main.jsonl',
        sessionFiles: [{ fileId: 'sf-image', filePath: '/tmp/media/output.png', label: 'output.png' }],
      },
    }), { status: 200 }));

    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false} isSelected={false} showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{ id: 'recover-file', role: 'assistant', blocks: [{
          type: 'media_generation', taskId: 'task-img', kind: 'image', status: 'pending',
        }] }}
      />,
    );

    vi.mocked(hanaFetch).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'chat.media.refreshStatus' }));
    await waitFor(() => expect(resolveBlockByTaskId).toHaveBeenCalledWith(
      '/sessions/main.jsonl', 'task-img', expect.objectContaining({
        type: 'file', fileId: 'sf-image', filePath: '/tmp/media/output.png',
        label: 'output.png', ext: 'png', replacesTaskId: 'task-img',
      }),
    ));
    expect(hanaFetch).toHaveBeenCalledWith('/api/media/tasks/task-img', expect.objectContaining({
      throwOnHttpError: false,
    }));
    expect(hanaFetch).not.toHaveBeenCalledWith('/api/media/tasks/task-img/retry', expect.anything());
  });

  it('shows a refresh error for a pending task without pretending it failed or completed', async () => {
    const resolveBlockByTaskId = vi.fn(() => true);
    useStore.setState({ resolveBlockByTaskId } as never);
    vi.mocked(hanaFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
      status: 503,
    }));
    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false} isSelected={false} showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{ id: 'status-error', role: 'assistant', blocks: [{
          type: 'media_generation', taskId: 'task-img', kind: 'image', status: 'pending',
          prompt: 'draw a lake',
        }] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'chat.media.refreshStatus' }));
    expect(await screen.findByText('temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'chat.media.refreshStatus' })).not.toBeDisabled();
    expect(resolveBlockByTaskId).not.toHaveBeenCalled();
  });

  it('renders generated video files as media cards that open the media viewer and drag out the file', async () => {
    const startDrag = vi.fn();
    (window as any).platform = {
      getFileUrl: (filePath: string) => `file://${filePath}`,
      startDrag,
    };

    render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [{
            type: 'file',
            fileId: 'sf_video',
            filePath: '/tmp/generated/agnes.mp4',
            label: 'agnes.mp4',
            ext: 'mp4',
            mime: 'video/mp4',
            kind: 'video',
          }],
        }}
      />,
    );

    const card = await screen.findByTestId('video-output-card');
    expect(card.querySelector('video')).toBeInTheDocument();

    fireEvent.click(card);
    await waitFor(() => {
      expect(useStore.getState().mediaViewer?.currentId).toContain('/tmp/generated/agnes.mp4');
    });

    fireEvent.dragStart(card);
    expect(startDrag).toHaveBeenCalledWith('/tmp/generated/agnes.mp4');
  });

  it('isolates a malformed rich block without hiding sibling message blocks', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(
      <AssistantMessage
        agentDisplay={{ id: 'hana', displayName: 'Hana', avatarUrl: null, fallbackAvatar: null, yuan: 'hana', isUser: false }}
        isStreaming={false}
        isSelected={false}
        showAvatar={false}
        sessionPath="/sessions/main.jsonl"
        readOnly
        message={{
          id: 'a1',
          role: 'assistant',
          blocks: [
            { type: 'text', html: '<p>before bad block</p>' },
            { type: 'plugin_card' } as never,
            { type: 'text', html: '<p>after bad block</p>' },
          ],
        }}
      />,
    )).not.toThrow();

    expect(screen.getByText('before bad block')).toBeInTheDocument();
    expect(screen.getByText('after bad block')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });
});
