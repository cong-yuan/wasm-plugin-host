/** A discoverable top-right session checklist, backed by the same keyed state
 * as the existing right-workspace todo card. Never keeps a second todo copy. */
import {useEffect,useMemo,useState} from 'react';
import {useStore} from '../../stores';
import {sessionScopedListIncludes,sessionScopedValue} from '../../stores/session-slice';
import {completeSessionTodos} from '../../stores/session-actions';
import type {TodoItem} from '../../types';
import styles from './SessionTodoPeek.module.css';

const EMPTY:TodoItem[]=[];
export function SessionTodoPeek(){
  const sessionPath=useStore(s=>s.currentSessionPath);
  const todos=useStore(s=>s.currentSessionPath
    ?sessionScopedValue(s,s.todosBySession,s.currentSessionPath)??EMPTY:EMPTY);
  const streaming=useStore(s=>s.currentSessionPath
    ?sessionScopedListIncludes(s,s.streamingSessions,s.currentSessionPath):false);
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [dismissedRevision,setDismissedRevision]=useState<string|null>(null);
  const [seenRevision,setSeenRevision]=useState('');
  const summary=useMemo(()=>{
    const complete=todos.filter(item=>item.status==='completed').length;
    return {complete,total:todos.length};
  },[todos]);
  // A tool producing or changing the checklist should surface the list without
  // requiring an unrelated right-rail panel to be opened manually.
  const revision=`${sessionPath||''}:${todos.map(item=>`${item.content}|${item.status}`).join('~')}`;
  useEffect(()=>{
    if(!sessionPath||!todos.length){setOpen(false);return;}
    if(revision!==seenRevision){
      setSeenRevision(revision);
      if(dismissedRevision!==revision)setOpen(true);
    }
  },[sessionPath,todos.length,revision,seenRevision,dismissedRevision]);
  if(!sessionPath||!todos.length)return null;
  const toggle=()=>{
    setOpen(previous=>!previous);
    if(open)setDismissedRevision(revision);
    else setDismissedRevision(null);
  };
  const markAll=async()=>{
    if(busy||streaming||!sessionPath)return;
    setBusy(true);
    try{await completeSessionTodos(sessionPath);}finally{setBusy(false);}
  };
  return <aside className={styles.root} aria-label="会话清单列表">
    <button type="button" className={styles.toggle} aria-expanded={open} onClick={toggle}
      aria-controls="conversation-todo-peek" title="清单列表">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m4 6 1.5 1.5L8 5m2 2h10M4 13l1.5 1.5L8 12m2 2h10M4 20l1.5 1.5L8 19m2 2h10"/>
      </svg>
      <span>清单</span><span className={styles.count}>{summary.complete}/{summary.total}</span>
    </button>
    {open&&<div id="conversation-todo-peek" className={styles.popover} role="region" aria-label="清单列表详情">
      <div className={styles.heading}>
        <strong>清单列表</strong><span>{summary.complete}/{summary.total}</span>
        <button type="button" className={styles.dismiss} title="收起清单" aria-label="收起清单"
          onClick={()=>{setOpen(false);setDismissedRevision(revision);}}>×</button>
      </div>
      <div className={styles.items}>{todos.map((todo,index)=><div key={`${index}:${todo.content}`}
        className={styles.item} data-status={todo.status}>
        <span className={styles.marker} aria-hidden="true">{todo.status==='completed'?'✓':todo.status==='in_progress'?'◉':'○'}</span>
        <span>{todo.status==='in_progress'&&todo.activeForm?todo.activeForm:todo.content}</span>
      </div>)}</div>
      <button type="button" className={styles.doneButton} disabled={busy||streaming||summary.complete===summary.total}
        onClick={()=>void markAll()}>全部标记完成</button>
    </div>}
  </aside>;
}
