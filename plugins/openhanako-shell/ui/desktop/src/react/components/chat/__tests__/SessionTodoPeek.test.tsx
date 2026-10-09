// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {SessionTodoPeek} from '../SessionTodoPeek';

const completeSessionTodos=vi.fn(async(_sessionPath?:unknown)=>true);
let state:Record<string,unknown>={};
vi.mock('../../../stores',()=>({useStore:(selector:(state:unknown)=>unknown)=>selector(state)}));
vi.mock('../../../stores/session-actions',()=>({completeSessionTodos:(...args:unknown[])=>completeSessionTodos(args[0])}));
const todo=(content:string,status:'pending'|'in_progress'|'completed'='pending')=>({content,activeForm:content,status});
beforeEach(()=>{
  completeSessionTodos.mockClear();
  state={currentSessionPath:'studio://session-a',todosBySession:{},streamingSessions:[]};
});
afterEach(cleanup);
describe('top-right conversation checklist',()=>{
  it('only appears for real current-session todos and automatically reveals them',async()=>{
    const {rerender}=render(<SessionTodoPeek/>);
    expect(screen.queryByRole('button',{name:/^清单[0-9]/})).not.toBeInTheDocument();
    state={...state,todosBySession:{'studio://session-a':[todo('读取源代码'),todo('运行测试','in_progress')]}};
    rerender(<SessionTodoPeek/>);
    expect(await screen.findByRole('region',{name:'清单列表详情'})).toHaveTextContent('读取源代码');
    expect(screen.getByRole('button',{name:/^清单[0-9]/})).toHaveAttribute('aria-expanded','true');
    expect(screen.getAllByText('0/2')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button',{name:'收起清单'}));
    expect(screen.queryByRole('region',{name:'清单列表详情'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:/^清单[0-9]/}));
    expect(screen.getByRole('region',{name:'清单列表详情'})).toBeInTheDocument();
  });
  it('uses the native existing completion action and disables while streaming',async()=>{
    state={...state,todosBySession:{'studio://session-a':[todo('Finish')]} };
    const {rerender}=render(<SessionTodoPeek/>);
    fireEvent.click(screen.getByRole('button',{name:'全部标记完成'}));
    await waitFor(()=>expect(completeSessionTodos).toHaveBeenCalledWith('studio://session-a'));
    state={...state,streamingSessions:['studio://session-a']};
    rerender(<SessionTodoPeek/>);
    expect(screen.getByRole('button',{name:'全部标记完成'})).toBeDisabled();
  });
  it('never displays a different session\'s tasks',()=>{
    state={...state,currentSessionPath:'studio://session-b',todosBySession:{'studio://session-a':[todo('Private A')]}};
    render(<SessionTodoPeek/>);
    expect(screen.queryByText('Private A')).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/^清单[0-9]/})).not.toBeInTheDocument();
  });
});
