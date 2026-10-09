/**
 * ChatArea — 聊天消息列表
 *
 * 每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { selectIsStreamingSession } from '../../stores/session-selectors';
import { manualReconnect } from '../../services/websocket';
import { ChatMessageSurface, type ChatScrollButtonState } from './ChatMessageSurface';
import { ChatFindBar } from './ChatFindBar';
import {
  getStudioBridgeStatus,
  subscribeStudioBridgeStatus,
  retryStudioBackendBridge,
} from '../../studio-backend/studio-backend-bridge';
import styles from './Chat.module.css';

const MAX_ALIVE = 5;

export function ChatArea() {
  return (
    <>
      <PanelHost />
      <ChatFindBar />
      <ScrollToBottomBtn />
    </>
  );
}

export function resolveChatRuntimeStatus({
  bridge,
  streaming,
  inlineError,
  wsState = 'connected',
}: {
  bridge: ReturnType<typeof getStudioBridgeStatus>;
  streaming: boolean;
  inlineError?: { text: string } | null;
  wsState?: 'connected' | 'reconnecting' | 'disconnected';
}): { state: 'connected' | 'pending' | 'streaming' | 'error'; label: string } | null {
  if (inlineError?.text) return { state: 'error', label: inlineError.text };
  if (bridge.state === 'error') return { state: 'error', label: `Studio connection issue: ${bridge.message}` };
  if (bridge.state === 'standalone' && wsState === 'disconnected') return { state: 'error', label: 'Disconnected' };
  if (bridge.state === 'standalone' && wsState === 'reconnecting') return { state: 'pending', label: 'Reconnecting…' };
  if (streaming) return { state: 'streaming', label: 'Hanako is responding…' };
  if (bridge.state === 'pending') return { state: 'pending', label: 'Connecting to Studio…' };
  if (bridge.state === 'connected') return { state: 'connected', label: 'Studio connected' };
  return null;
}

/** Short, accessible connection indicator in the global Chat / Channel titlebar. */
export function ChatRuntimeStatusIndicator() {
  const bridge = useSyncExternalStore(
    subscribeStudioBridgeStatus,
    getStudioBridgeStatus,
    getStudioBridgeStatus,
  );
  const currentPath = useStore(s => s.currentSessionPath);
  const streaming = useStore(s => selectIsStreamingSession(s, currentPath));
  const wsState = useStore(s => s.wsState);
  const inlineError = useStore(s => currentPath
    ? sessionScopedValue(s, s.inlineErrors, currentPath) ?? null
    : null);
  const status = resolveChatRuntimeStatus({ bridge, streaming, inlineError, wsState });
  const handleErrorAction = () => {
    if (inlineError && currentPath) {
      useStore.getState().clearInlineError(currentPath);
      return;
    }
    if (bridge.state === 'error') retryStudioBackendBridge();
    else if (bridge.state === 'standalone' && wsState === 'disconnected') manualReconnect();
  };
  const errorActionLabel = inlineError
    ? window.t('common.dismiss')
    : bridge.state === 'error'
      ? window.t('common.retry')
      : bridge.state === 'standalone' && wsState === 'disconnected'
        ? window.t('status.reconnect')
        : null;
  if (!status) return null;

  return (
    <div
      className={`${styles.bridgeStatus} ${styles[`bridgeStatus-${status.state}`]}`}
      role={status.state === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      data-chat-runtime-state={status.state}
    >
      <span className={styles.bridgeStatusDot} aria-hidden="true" />
      <span className={styles.bridgeStatusLabel} title={status.label}>{status.state === 'connected' ? 'Studio' : status.state === 'streaming' ? '响应中' : status.state === 'pending' ? '连接中' : status.state === 'error' ? '错误' : status.label}</span>
      {status.state === 'error' && errorActionLabel && (
        <button
          type="button"
          className={styles.bridgeStatusAction}
          onClick={handleErrorAction}
          data-chat-runtime-action=""
        >
          {errorActionLabel}
        </button>
      )}
    </div>
  );
}

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  useEffect(() => {
    if (!currentPath) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev;
      if (prev.length >= MAX_ALIVE) {
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath]);

  if (welcomeVisible || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <ChatMessageSurface
          key={path}
          sessionPath={path}
          active={path === currentPath}
          onScrollButtonChange={setScrollButton}
        />
      ))}
    </>
  );
}

const _scrollBtn = {
  el: null as HTMLElement | null,
  visible: false,
  scrollToBottom: null as (() => void) | null,
  listeners: [] as (() => void)[],
};

function setScrollButton(state: ChatScrollButtonState) {
  _scrollBtn.el = state.el;
  _scrollBtn.visible = state.visible;
  _scrollBtn.scrollToBottom = state.scrollToBottom;
  _scrollBtn.listeners.forEach(listener => listener());
}

function ScrollToBottomBtn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(_scrollBtn.visible);
    _scrollBtn.listeners.push(update);
    return () => { _scrollBtn.listeners = _scrollBtn.listeners.filter(f => f !== update); };
  }, []);

  if (!visible) return null;
  return (
    <button className={styles.scrollToBottomFab} onClick={() => {
      _scrollBtn.scrollToBottom?.();
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
