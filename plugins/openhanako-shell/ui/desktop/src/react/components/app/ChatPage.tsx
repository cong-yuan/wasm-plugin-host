import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { TrajectoryView } from '../chat/TrajectoryView';
import trajectoryStyles from '../chat/TrajectoryView.module.css';
import { InputArea, type InputAreaProps } from '../InputArea';
import { WelcomeScreen } from '../WelcomeScreen';
import { ChatArea } from '../chat/ChatArea';
import { RegionalErrorBoundary } from '../RegionalErrorBoundary';

function WelcomeContainer() {
  const visible = useStore(s => s.welcomeVisible);
  return (
    <div className={`welcome${visible ? '' : ' hidden'}`} id="welcome">
      <WelcomeScreen />
    </div>
  );
}

export function ChatPage({
  inputSurface = 'desktop',
  regionPrefix = '',
}: {
  inputSurface?: NonNullable<InputAreaProps['surface']>;
  regionPrefix?: string;
} = {}) {
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const hasPanels = !welcomeVisible && !!currentSessionPath;
  const [view,setView] = useState<'chat'|'trajectory'>('chat');
  useEffect(()=>setView('chat'),[currentSessionPath]);

  return (
    <>
      <div className={`chat-area${hasPanels ? ' has-panels' : ''}`}
        data-conversation-views={hasPanels ? 'true' : undefined}>
        <WelcomeContainer />
        {hasPanels && <div className={trajectoryStyles.chatHeaderBackdrop} aria-hidden="true" />}
        {hasPanels && (
          <nav aria-label="会话视图" role="tablist" className={trajectoryStyles.chatTabs}>
            <span className={trajectoryStyles.chatTabSlider} aria-hidden="true"
              data-selected-view={view}/>
            <button type="button" role="tab" id="chat-view-tab"
              className={trajectoryStyles.chatTab}
              aria-controls="chat-view-panel" aria-selected={view === 'chat'}
              tabIndex={view === 'chat' ? 0 : -1}
              onKeyDown={event => {
                if (event.key === 'ArrowRight') {setView('trajectory');event.preventDefault();}
              }} onClick={() => setView('chat')}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 11.5a8 8 0 0 1-8 8 9.6 9.6 0 0 1-3.6-.7L4 20l1.2-4.4A8 8 0 1 1 20 11.5z"/>
              </svg>
              对话
            </button>
            <button type="button" role="tab" id="trajectory-view-tab"
              className={trajectoryStyles.chatTab}
              aria-controls="trajectory-view-panel" aria-selected={view === 'trajectory'}
              tabIndex={view === 'trajectory' ? 0 : -1}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') {setView('chat');event.preventDefault();}
              }} onClick={() => setView('trajectory')}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 17 9 11 13 14 21 5"/>
                <polyline points="16 5 21 5 21 10"/>
              </svg>
              轨迹
            </button>
          </nav>
        )}
        <div id="chat-view-panel" role="tabpanel" aria-labelledby="chat-view-tab"
          className={trajectoryStyles.chatPanel} hidden={view !== 'chat'}>
          <RegionalErrorBoundary region={`${regionPrefix}chat`} resetKeys={[currentSessionPath]}>
            <ChatArea />
          </RegionalErrorBoundary>
        </div>
        {hasPanels && view==='trajectory' && currentSessionPath &&
          <RegionalErrorBoundary region={`${regionPrefix}trajectory`} resetKeys={[currentSessionPath]}>
            <div id="trajectory-view-panel" role="tabpanel" aria-labelledby="trajectory-view-tab"
              className={trajectoryStyles.trajectoryPanel}>
              <TrajectoryView sessionPath={currentSessionPath} active={view === 'trajectory'} />
            </div>
          </RegionalErrorBoundary>}
      </div>
      <div className="input-area" data-ohk-slot="openhanako.conversation.input.dock"
        style={{display:view==='trajectory'?'none':undefined}}>
        <RegionalErrorBoundary
          region={`${regionPrefix}input`}
          resetKeys={[currentSessionPath]}
          autoRetry={{ attempts: 2, delayMs: 120 }}
        >
          <InputArea key={currentSessionPath || '__new'} surface={inputSurface} />
        </RegionalErrorBoundary>
      </div>
    </>
  );
}
