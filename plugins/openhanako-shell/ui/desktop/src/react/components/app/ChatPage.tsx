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
      <div className={`chat-area${hasPanels ? ' has-panels' : ''}`}>
        <WelcomeContainer />
        {hasPanels && <nav aria-label="会话视图" role="tablist" className={trajectoryStyles.chatTabs}>
          <button type="button" role="tab" className={trajectoryStyles.chatTab}
            aria-selected={view==='chat'} onClick={()=>setView('chat')}>Chat · 对话</button>
          <button type="button" role="tab" className={trajectoryStyles.chatTab}
            aria-selected={view==='trajectory'} onClick={()=>setView('trajectory')}>Trajectory · 轨迹</button>
        </nav>}
        <div style={{display:view==='chat'?'contents':'none'}}>
          <RegionalErrorBoundary region={`${regionPrefix}chat`} resetKeys={[currentSessionPath]}>
            <ChatArea />
          </RegionalErrorBoundary>
        </div>
        {hasPanels && view==='trajectory' && currentSessionPath &&
          <RegionalErrorBoundary region={`${regionPrefix}trajectory`} resetKeys={[currentSessionPath]}>
            <div style={{flex:1,minHeight:0,display:'flex',overflow:'hidden'}}>
              <TrajectoryView sessionPath={currentSessionPath} active={view==='trajectory'} />
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
