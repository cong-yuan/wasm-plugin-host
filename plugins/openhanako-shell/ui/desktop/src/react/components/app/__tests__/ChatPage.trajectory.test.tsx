// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {ChatPage} from '../ChatPage';
vi.mock('../../../stores',()=>({useStore:(selector:(state:unknown)=>unknown)=>selector({welcomeVisible:false,currentSessionPath:'studio://abc123'})}));
vi.mock('../../chat/ChatArea',()=>({ChatArea:()=> <div data-testid="chat-messages">Chat panel</div>}));
vi.mock('../../chat/TrajectoryView',()=>({TrajectoryView:({sessionPath}:{sessionPath:string})=><div data-testid="trajectory-view">{sessionPath}</div>}));
vi.mock('../../InputArea',()=>({InputArea:()=> <div data-testid="composer">Composer</div>}));
vi.mock('../../WelcomeScreen',()=>({WelcomeScreen:()=> <div>Welcome</div>}));
vi.mock('../../RegionalErrorBoundary',()=>({RegionalErrorBoundary:({children}:{children:React.ReactNode})=><>{children}</>}));
afterEach(cleanup);
describe('ChatPage in-column Trajectory tab',()=>{
  it('switches between chat and trajectory in the same column, without another window',()=>{
    render(<ChatPage/>);
    expect(screen.getByRole('tab',{name:'Chat · 对话'})).toHaveAttribute('aria-selected','true');
    expect(screen.queryByTestId('trajectory-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab',{name:'Trajectory · 轨迹'}));
    expect(screen.getByRole('tab',{name:'Trajectory · 轨迹'})).toHaveAttribute('aria-selected','true');
    expect(screen.getByTestId('trajectory-view')).toHaveTextContent('studio://abc123');
    const composer=screen.getByTestId('composer').parentElement;
    expect(composer).toHaveStyle({display:'none'});
    fireEvent.click(screen.getByRole('tab',{name:'Chat · 对话'}));
    expect(screen.queryByTestId('trajectory-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-messages')).toBeInTheDocument();
  });
});
