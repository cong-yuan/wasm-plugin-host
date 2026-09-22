import { useStore } from '../../stores';
import { InputArea, type InputAreaProps } from '../InputArea';
import { WelcomeScreen } from '../WelcomeScreen';
import { ChatArea } from '../chat/ChatArea';
import { RegionalErrorBoundary } from '../RegionalErrorBoundary';

function WelcomeContainer() {
  const visible = useStore(s => s.welcomeVisible);
  return (
    <div className={`welcome${visible ? '' : ' hidden'}`} id="welcome" data-ohk-slot="openhanako.conversation.hero">
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

  return (
    <>
      <div className={`chat-area${hasPanels ? ' has-panels' : ''}`} data-ohk-slot="openhanako.conversation.stream">
        <WelcomeContainer />
        <RegionalErrorBoundary region={`${regionPrefix}chat`} resetKeys={[currentSessionPath]}>
          <ChatArea />
        </RegionalErrorBoundary>
      </div>
      <div className="input-area" data-ohk-slot="openhanako.conversation.input.dock">
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
