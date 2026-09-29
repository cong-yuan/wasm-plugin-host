import { describe, expect, it } from 'vitest';
import { resolveChatRuntimeStatus } from '../ChatArea';

describe('resolveChatRuntimeStatus', () => {
  it('prioritizes session errors over bridge and streaming state', () => {
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'error', message: 'bridge down' },
      streaming: true,
      inlineError: { text: 'Model request failed' },
    })).toEqual({ state: 'error', label: 'Model request failed' });
  });

  it('shows bridge errors before ordinary streaming activity', () => {
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'error', message: 'timeout' },
      streaming: true,
      inlineError: null,
    })).toEqual({ state: 'error', label: 'Studio connection issue: timeout' });
  });

  it('shows streaming activity when the bridge is healthy or standalone', () => {
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'connected' },
      streaming: true,
      inlineError: null,
    })).toEqual({ state: 'streaming', label: 'Hanako is responding…' });
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'standalone' },
      streaming: true,
      inlineError: null,
    })).toEqual({ state: 'streaming', label: 'Hanako is responding…' });
  });

  it('surfaces standalone websocket reconnect and disconnected states', () => {
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'standalone' },
      streaming: false,
      inlineError: null,
      wsState: 'reconnecting',
    })).toEqual({ state: 'pending', label: 'Reconnecting…' });
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'standalone' },
      streaming: false,
      inlineError: null,
      wsState: 'disconnected',
    })).toEqual({ state: 'error', label: 'Disconnected' });
  });

  it('shows handshake progress and otherwise hides standalone idle state', () => {
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'pending' },
      streaming: false,
      inlineError: null,
    })).toEqual({ state: 'pending', label: 'Connecting to Studio…' });
    expect(resolveChatRuntimeStatus({
      bridge: { state: 'standalone' },
      streaming: false,
      inlineError: null,
    })).toBeNull();
  });
});
