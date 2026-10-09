// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {render,cleanup,waitFor} from '@testing-library/react';
import {useNativeSessionTodos} from '../use-native-session-todos';
import {hanaFetch} from '../../../hooks/use-hana-fetch';
const store=vi.hoisted(()=>{
  const state={todosLiveVersionBySession:{} as Record<string,number>,todosBySession:{} as Record<string,unknown[]>};
  const setSessionTodosForPath=vi.fn((path:string,todos:unknown[])=>{state.todosBySession[path]=todos;});
  const bumpTodosLiveVersion=vi.fn((path:string)=>{state.todosLiveVersionBySession[path]=(state.todosLiveVersionBySession[path]||0)+1;});
  return {state,setSessionTodosForPath,bumpTodosLiveVersion};
});
vi.mock('../../../stores',()=>({useStore:{getState:()=>({...store.state,
  setSessionTodosForPath:store.setSessionTodosForPath,
  bumpTodosLiveVersion:store.bumpTodosLiveVersion})}}));
vi.mock('../../../hooks/use-hana-fetch',()=>({hanaFetch:vi.fn()}));
const ack=(path:string,revision:number,todos:unknown[])=>(
  new Response(JSON.stringify({ok:true,source:'session-event',revision,todos}),{status:200}));
function Probe({path}:{path:string}){useNativeSessionTodos(path,false);return <span>{path}</span>;}
beforeEach(()=>{
  store.state.todosLiveVersionBySession={};store.state.todosBySession={};
  store.setSessionTodosForPath.mockClear();store.bumpTodosLiveVersion.mockClear();
  vi.mocked(hanaFetch).mockReset();
});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('right-rail process native reconciliation',()=>{
  it('hydrates on session switch without mixing session A and B data',async()=>{
    vi.mocked(hanaFetch).mockImplementation(async(url)=>{
      const path=new URL(String(url),'http://localhost').searchParams.get('sessionId');
      return ack(path||'',path==='studio://a'?3:8,
        [{content:path==='studio://a'?'Task A':'Task B',status:'in_progress'}]);
    });
    const {rerender}=render(<Probe path="studio://a"/>);
    await waitFor(()=>expect(store.state.todosBySession['studio://a']).toEqual(
      [{content:'Task A',status:'in_progress'}]));
    rerender(<Probe path="studio://b"/>);
    await waitFor(()=>expect(store.state.todosBySession['studio://b']).toEqual(
      [{content:'Task B',status:'in_progress'}]));
    expect(store.state.todosBySession['studio://a']).toHaveLength(1);
  });
  it('ignores older response when live websocket todo progress arrives mid-flight',async()=>{
    let resolveResponse!:(res:Response)=>void;
    vi.mocked(hanaFetch).mockImplementation(()=>new Promise(resolve=>{resolveResponse=resolve;}));
    render(<Probe path="studio://a"/>);
    await waitFor(()=>expect(hanaFetch).toHaveBeenCalledTimes(1));
    store.state.todosLiveVersionBySession['studio://a']=1;
    resolveResponse(ack('studio://a',4,[{content:'Old',status:'pending'}]));
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(store.setSessionTodosForPath).not.toHaveBeenCalled();
  });
  it('keeps existing UI todos when the host has no native TodoWrite event',async()=>{
    vi.mocked(hanaFetch).mockResolvedValue(new Response(JSON.stringify({ok:true,source:'no-event',revision:null,todos:[]}),{status:200}));
    render(<Probe path="studio://a"/>);
    await waitFor(()=>expect(hanaFetch).toHaveBeenCalled());
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(store.setSessionTodosForPath).not.toHaveBeenCalled();
  });
});
