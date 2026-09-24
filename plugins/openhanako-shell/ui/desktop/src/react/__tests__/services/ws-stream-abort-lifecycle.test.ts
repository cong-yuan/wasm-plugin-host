import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/session-actions', () => ({
  loadSessions: vi.fn(),
}));

vi.mock('../../stores/desk-actions', () => ({
  loadDeskFiles: vi.fn(),
}));

vi.mock('../../stores/channel-actions', () => ({
  loadChannels: vi.fn(),
  openChannel: vi.fn(),
  appendChannelMessage: vi.fn(),
}));

vi.mock('../../stores/preview-actions', () => ({
  handleLegacyArtifactBlock: vi.fn(),
}));

vi.mock('../../services/app-event-actions', () => ({
  handleAppEvent: vi.fn(),
}));

vi.mock('../../services/stream-resume', () => ({
  replayStreamResume: vi.fn(),
  isStreamResumeRebuilding: () => null,
  isStreamScopedMessage: () => false,
  updateSessionStreamMeta: vi.fn(),
}));

vi.mock('../../services/stream-key-dispatcher', () => ({
  dispatchStreamKey: vi.fn(),
}));

import { streamBufferManager } from '../../hooks/use-stream-buffer';
import { handleServerMessage } from '../../services/ws-message-handler';
import { useStore } from '../../stores';
import type { ChatListItem, ChatMessage } from '../../stores/chat-types';

const PATH = '/session/abort-turn.jsonl';

function userItem(id: string, text: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'user',
      text,
      textHtml: text,
      timestamp: Date.now(),
    },
  };
}

function messageItems() {
  const messages: ChatMessage[] = [];
  for (const item of useStore.getState().chatSessions[PATH]?.items ?? []) {
    if (item.type === 'message') messages.push(item.data);
  }
  return messages;
}

function textBlockHtml(message: ChatMessage): string {
  return message.blocks?.find((block) => block.type === 'text')?.html ?? '';
}

describe('ws stream lifecycle after abort', () => {
  beforeEach(() => {
    streamBufferManager.clearAll();
    useStore.getState().clearSession(PATH);
    useStore.setState({
      currentSessionPath: PATH,
      pendingNewSession: false,
      sessions: [{
        path: PATH,
        title: null,
        firstMessage: '',
        modified: '2026-05-08T00:00:00.000Z',
        messageCount: 0,
        agentId: 'hana',
        agentName: 'Hana',
        cwd: null,
      }],
      streamingSessions: [PATH],
      activeSessionStreams: {},
      inlineErrors: {},
      chatSessions: {},
    } as never);
    useStore.getState().initSession(PATH, [userItem('u1', 'start project')], false);
  });

  it('status=false marks every still-running tool terminal', () => {
    handleServerMessage({
      type: 'tool_start',
      sessionPath: PATH,
      id: 'cancelled-read',
      name: 'read',
      startedAt: 1_000,
    });

    handleServerMessage({
      type: 'status',
      sessionPath: PATH,
      isStreaming: false,
    });

    const assistant = messageItems().find((message) => message.role === 'assistant');
    const group = assistant?.blocks?.find((block) => block.type === 'tool_group');
    expect(group?.type).toBe('tool_group');
    if (!group || group.type !== 'tool_group') throw new Error('expected tool group');
    expect(group.tools).toEqual([
      expect.objectContaining({
        id: 'cancelled-read',
        done: true,
        success: false,
        status: 'unknown',
      }),
    ]);
    expect(group.tools[0].finishedAt).toEqual(expect.any(Number));
  });

  it('aborted turn_end followed by status=false keeps tools cancelled', () => {
    handleServerMessage({
      type: 'tool_start',
      sessionPath: PATH,
      id: 'cancelled-in-real-order',
      name: 'bash',
      startedAt: 1_000,
    });

    handleServerMessage({ type: 'turn_end', sessionPath: PATH, aborted: true });
    handleServerMessage({ type: 'status', sessionPath: PATH, isStreaming: false });

    const assistant = messageItems().find((message) => message.role === 'assistant');
    const group = assistant?.blocks?.find((block) => block.type === 'tool_group');
    expect(group?.type).toBe('tool_group');
    if (!group || group.type !== 'tool_group') throw new Error('expected tool group');
    expect(group.tools[0]).toMatchObject({
      id: 'cancelled-in-real-order',
      done: true,
      success: false,
      status: 'cancelled',
    });
  });

  it('status=false ends the local turn binding so the next reply lands after the new user message', () => {
    handleServerMessage({
      type: 'text_delta',
      sessionPath: PATH,
      delta: 'old partial',
    });

    handleServerMessage({
      type: 'status',
      sessionPath: PATH,
      isStreaming: false,
    });

    handleServerMessage({
      type: 'session_user_message',
      sessionPath: PATH,
      message: { id: 'u2', text: 'new prompt', timestamp: Date.now() },
    });

    handleServerMessage({
      type: 'status',
      sessionPath: PATH,
      isStreaming: true,
    });
    handleServerMessage({
      type: 'text_delta',
      sessionPath: PATH,
      delta: 'new answer',
    });
    handleServerMessage({
      type: 'turn_end',
      sessionPath: PATH,
    });

    const items = messageItems();
    expect(items.map((item) => item.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(textBlockHtml(items[1])).toContain('old partial');
    expect(textBlockHtml(items[3])).toContain('new answer');
  });
});
