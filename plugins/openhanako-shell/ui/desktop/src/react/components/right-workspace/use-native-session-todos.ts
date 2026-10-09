/** Keep the single right-rail 进程 card in sync with durable Studio TodoWrite.
 * Backwards compatible: absent native capabilities never erase legacy todos. */
import {useEffect,useRef} from 'react';
import {useStore} from '../../stores';
import {sessionScopedValue} from '../../stores/session-slice';
import {hanaFetch} from '../../hooks/use-hana-fetch';
import type {TodoItem} from '../../types';

interface NativeTodoSnapshot {
  ok?:boolean;
  source?:string;
  revision?:number|null;
  todos?:TodoItem[];
}

export function useNativeSessionTodos(sessionPath:string|null,streaming:boolean){
  const lastRevision=useRef(new Map<string,number>());
  useEffect(()=>{
    if(!sessionPath || typeof useStore.getState !== 'function')return;
    let disposed=false;
    let inFlight=false;
    async function refresh(){
      if(inFlight||disposed)return;
      inFlight=true;
      const beforeState=useStore.getState();
      const beforeVersion=sessionScopedValue(beforeState,beforeState.todosLiveVersionBySession,sessionPath)??0;
      try{
        const query=new URLSearchParams({sessionId:sessionPath!});
        const response=await hanaFetch(`/api/sessions/todos?${query}`,{throwOnHttpError:false,timeout:6500});
        if(!response.ok)return;
        const snapshot=await response.json() as NativeTodoSnapshot;
        if(disposed||snapshot.ok!==true||snapshot.source!=='session-event'
          ||!Array.isArray(snapshot.todos)||!Number.isSafeInteger(snapshot.revision))return;
        const revision=snapshot.revision as number;
        const previous=lastRevision.current.get(sessionPath!);
        if(previous!==undefined&&revision<=previous)return;
        const state=useStore.getState();
        // A newer live WS todo_update or an explicit user completion beats a
        // request started before that update. Recheck on the next poll.
        if((sessionScopedValue(state,state.todosLiveVersionBySession,sessionPath)??0)!==beforeVersion)return;
        lastRevision.current.set(sessionPath!,revision);
        if(typeof state.setSessionTodosForPath==='function'){
          state.setSessionTodosForPath(sessionPath!,snapshot.todos);
          state.bumpTodosLiveVersion(sessionPath!);
        }
      }catch(_error){ /* Old Studio / standalone server: keep live and cached todos. */ }
      finally{inFlight=false;}
    }
    void refresh();
    const interval=window.setInterval(()=>void refresh(),streaming?1800:6500);
    return()=>{disposed=true;window.clearInterval(interval);};
  },[sessionPath,streaming]);
}
