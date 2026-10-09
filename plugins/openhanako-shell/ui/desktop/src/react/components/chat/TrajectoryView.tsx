/** Native Studio session-event trajectory. Never invent timing or token data. */
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {hanaFetch} from '../../hooks/use-hana-fetch';
import styles from './TrajectoryView.module.css';

export type RecordRole='system'|'user'|'assistant'|'tool'|'context'|'model';
export interface TrajectoryRecord {
  seq:number; time:number; turn:number; step:number; role:RecordRole;
  kind:string; label:string; content:string; status?:string; input?:string; output?:string;
  callId?:string; endAt?:number; durationMs?:number; ttftMs?:number; decodeMs?:number;
  usage?:Record<string,unknown>;
}
interface Page {ok:boolean;records:TrajectoryRecord[];total:number;hasMore:boolean;nextBefore:number|null;error?:string}
const ROLES=['all','system','user','assistant','tool','context','model'] as const;
const ROLE_LABEL:Record<string,string>={all:'全部',system:'SYSTEM',user:'USER',assistant:'ASSISTANT',tool:'TOOL',context:'CONTEXT',model:'MODEL'};
const TRACKS=[{id:'Input',roles:['system','user','context']},{id:'Model',roles:['model','assistant']},{id:'Tools',roles:['tool']}] as const;
const clock=(value:number)=>Number.isFinite(value)?new Date(value).toLocaleTimeString(undefined,{hour12:false}):'—';
const duration=(row:TrajectoryRecord)=>typeof row.durationMs==='number'?`${row.durationMs} ms`:'未记录';
const merge=(old:TrajectoryRecord[],next:TrajectoryRecord[])=>{
  const map=new Map(old.map(row=>[row.seq,row]));
  for(const row of next)map.set(row.seq,row);
  return [...map.values()].sort((a,b)=>a.seq-b.seq);
};
export function TrajectoryView({sessionPath,active}:{sessionPath:string;active:boolean}){
  const [records,setRecords]=useState<TrajectoryRecord[]>([]);
  const [cursor,setCursor]=useState<number|null>(null);
  const [hasMore,setHasMore]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [selected,setSelected]=useState<number|null>(null);
  const [role,setRole]=useState<string>('all');
  const [search,setSearch]=useState('');
  const [rangeFrom,setRangeFrom]=useState(0);
  const [rangeTo,setRangeTo]=useState(100);
  const [collapsed,setCollapsed]=useState<Set<number>>(new Set());
  const version=useRef(0);
  const cursorRef=useRef<number|null>(null);
  const load=useCallback(async(older=false)=>{
    if(!active||!sessionPath||(older&&cursorRef.current===null))return;
    const n=++version.current;
    setBusy(true);
    try{
      const params=new URLSearchParams({sessionId:sessionPath,limit:'200'});
      if(older&&cursorRef.current!==null)params.set('before',String(cursorRef.current));
      const response=await hanaFetch(`/api/session-trajectory?${params}`,{throwOnHttpError:false});
      const page=await response.json() as Page;
      if(n!==version.current)return;
      if(!response.ok||page.ok!==true||!Array.isArray(page.records))throw new Error(page.error||'Studio 轨迹接口暂不可用');
      const rows=page.records.filter(row=>Number.isInteger(row.seq)&&Number.isFinite(row.time));
      setRecords(previous=>merge(previous,rows));
      if(older||cursorRef.current===null){cursorRef.current=page.nextBefore;setCursor(page.nextBefore);setHasMore(page.hasMore);}
      setError('');
    }catch(e){if(n===version.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(n===version.current)setBusy(false);}
  },[active,sessionPath]);
  useEffect(()=>{version.current++;cursorRef.current=null;setCursor(null);setRecords([]);setHasMore(false);setSelected(null);setRangeFrom(0);setRangeTo(100);setCollapsed(new Set());setError('');},[sessionPath]);
  useEffect(()=>{if(!active||!sessionPath)return;
    void load();const timer=window.setInterval(()=>{void load();},7000);
    return()=>{window.clearInterval(timer);version.current++;};
  },[active,sessionPath,load]);
  const bounds=useMemo(()=>{
    const start=Math.min(...records.map(row=>row.time));
    const end=Math.max(...records.map(row=>Math.max(row.endAt??row.time,row.time)));
    return Number.isFinite(start)?[start,Math.max(end,start+1)] as const:[0,1] as const;
  },[records]);
  const span=bounds[1]-bounds[0];
  const range=rangeFrom===0 && rangeTo===100 ? null :
    [bounds[0]+span*rangeFrom/100,bounds[0]+span*rangeTo/100] as [number,number];
  const focusRow=(row:TrajectoryRecord)=>{
    setSelected(row.seq);
    setCollapsed(old=>{if(!old.has(row.turn))return old;const next=new Set(old);next.delete(row.turn);return next;});
    requestAnimationFrame(()=>{
      const element=document.querySelector(`[data-trajectory-seq="${row.seq}"]`);
      if(element && 'scrollIntoView' in element)element.scrollIntoView({block:'nearest',behavior:'smooth'});
    });
  };
  const shown=useMemo(()=>records.filter(row=>(role==='all'||role===row.role)
    &&(!search||`${row.role} ${row.label} ${row.kind} ${row.content}`.toLowerCase().includes(search.toLowerCase()))
    &&(!range||(row.time<=range[1]&&(row.endAt??row.time)>=range[0]))),[records,role,search,range]);
  const turns=useMemo(()=>{
    const groups=new Map<number,TrajectoryRecord[]>();
    for(const row of shown){const rows=groups.get(row.turn)||[];rows.push(row);groups.set(row.turn,rows);}
    return [...groups.entries()];
  },[shown]);
  const selectedRecord=records.find(row=>row.seq===selected);
  return <div className={styles.root} aria-label="会话轨迹">
    <header className={styles.header}><strong>Trajectory · 会话轨迹</strong>
      <span>{records.length} 条事件{cursor!==null?' · 支持载入更早记录':''}</span>
      <button type="button" disabled={busy} onClick={()=>void load()}>刷新</button>
    </header>
    {error&&<p className={styles.error} role="alert">{error}</p>}
    <section className={styles.overview} aria-label="执行时间轴">
      <div className={styles.heading}><strong>Timeline</strong><span>{records.length?`${clock(bounds[0])} — ${clock(bounds[1])}`:'等待事件记录'}</span>
        {range&&<button type="button" onClick={()=>{setRangeFrom(0);setRangeTo(100);}}>重置区间</button>}</div>
      <div className={styles.timelineRow}>
        <div className={styles.labels}>{TRACKS.map(item=><span key={item.id}>{item.id}</span>)}</div>
        <div className={styles.timeline} aria-label="轨迹时间轴">
          {TRACKS.map(track=><div key={track.id} className={styles.track}>
            {records.filter(row=>track.roles.some(item=>row.role===item))
              .filter(row=>row.role==='tool'?row.kind==='tool/call':row.role==='model'?row.kind==='step/start':row.role==='context'?row.kind==='turn/start':true)
              .map(row=><button type="button" key={row.seq}
                className={`${styles.bar} ${styles[row.role]} ${selected===row.seq?styles.barSelected:''}`}
                aria-label={`${row.label} ${clock(row.time)}`} title={`${row.label} · ${clock(row.time)} · ${duration(row)}`}
                style={{left:`${Math.max(0,(row.time-bounds[0])/span*100)}%`,
                  width:`${Math.max(.6,(row.endAt??row.time)-row.time>0?((row.endAt??row.time)-row.time)/span*100:.6)}%`}}
                onClick={()=>focusRow(row)}/>)}
            {range&&<div className={styles.selection} style={{left:`${(range[0]-bounds[0])/span*100}%`,width:`${(range[1]-range[0])/span*100}%`}}/>}
          </div>)}
        </div>
      </div>
      <div className={styles.rangeControls} aria-label="时间区间筛选">
        <label>起点 <input type="range" aria-label="时间起点" min="0" max="99"
          value={rangeFrom} onChange={e=>setRangeFrom(Math.min(Number(e.target.value),rangeTo-1))}/>
          <span>{clock(bounds[0]+span*rangeFrom/100)}</span></label>
        <label>终点 <input type="range" aria-label="时间终点" min="1" max="100"
          value={rangeTo} onChange={e=>setRangeTo(Math.max(Number(e.target.value),rangeFrom+1))}/>
          <span>{clock(bounds[0]+span*rangeTo/100)}</span></label>
      </div>
      <p className={styles.hint}>点击彩色事件定位详情；使用下方两个滑杆精确筛选时间，不再与事件点击冲突。</p>
    </section>
    <div className={styles.controls}>
      <input aria-label="搜索轨迹事件" placeholder="搜索角色、工具或内容…" value={search} onChange={event=>setSearch(event.target.value)}/>
      <div className={styles.filters}>{ROLES.map(option=><button type="button" key={option} aria-pressed={role===option}
        onClick={()=>setRole(option)}>{ROLE_LABEL[option]}</button>)}</div>
    </div>
    <div className={styles.body}>
      <section className={styles.ledger} aria-label="轨迹事件列表">
        {hasMore&&<button type="button" className={styles.more} disabled={busy} onClick={()=>void load(true)}>加载更早事件</button>}
        {!shown.length&&!busy&&<p className={styles.empty}>{error?'无法读取原生轨迹':'没有匹配的事件'}</p>}
        {turns.map(([turn,rows])=><div key={turn} className={styles.turn}>
          <button type="button" className={styles.turnHead} aria-expanded={!collapsed.has(turn)}
            onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(turn))next.delete(turn);else next.add(turn);return next;})}>
            <span className={styles.turnIdentity}>
              <span className={styles.turnNumber}>{turn || '–'}</span>
              <span>{turn ? `Turn ${turn}` : 'Context'}</span>
              <span className={styles.turnCaret}>{collapsed.has(turn)?'▸':'▾'}</span>
            </span>
            <small className={styles.turnCount}>{rows.length} 个事件</small>
          </button>
          {!collapsed.has(turn)&&rows.map(row=><button key={row.seq} type="button"
            className={`${styles.event} ${selected===row.seq?styles.eventSelected:''} ${row.status==='failed'?styles.failed:''}`}
            data-trajectory-seq={row.seq}
            aria-pressed={selected===row.seq} onClick={()=>focusRow(row)}>
            <span className={`${styles.roleTag} ${styles[row.role]}`}>{ROLE_LABEL[row.role]||row.role}</span>
            <span className={styles.eventText}><strong>{row.label}</strong><small>{(row.content||row.kind).slice(0,150)}</small></span>
            <span className={styles.time}>{clock(row.time)}<small>{duration(row)}</small></span>
          </button>)}
        </div>)}
      </section>
      <aside className={styles.inspector} aria-label="轨迹事件详情">
        {selectedRecord?<>
          <div className={styles.inspectorHead}>
            <span className={`${styles.roleTag} ${styles[selectedRecord.role]}`}>{ROLE_LABEL[selectedRecord.role]}</span>
            <button type="button" onClick={()=>setSelected(null)}>关闭</button>
          </div>
          <h3>{selectedRecord.label}</h3>
          <div className={styles.metaChips} aria-label="事件元信息">
            <span className={styles.metaChip} title={selectedRecord.kind}>#{selectedRecord.seq} · {selectedRecord.kind}</span>
            <span className={styles.metaChip}>Turn {selectedRecord.turn} · Step {selectedRecord.step}</span>
            {selectedRecord.status&&<span className={`${styles.metaChip} ${selectedRecord.status==='failed'?styles.metaFailed:styles.metaSuccess}`}>
              {selectedRecord.status}</span>}
          </div>
          <div className={styles.metaChips} aria-label="事件时间与耗时">
            <span className={styles.metaChip} title="开始时间">◷ {clock(selectedRecord.time)}</span>
            {selectedRecord.endAt!=null&&<span className={styles.metaChip} title="结束时间">→ {clock(selectedRecord.endAt)}</span>}
            {selectedRecord.durationMs!=null&&<span className={styles.metaChip}>耗时 {duration(selectedRecord)}</span>}
            {selectedRecord.ttftMs!=null&&<span className={styles.metaChip}>TTFT {selectedRecord.ttftMs}ms</span>}
            {selectedRecord.decodeMs!=null&&<span className={styles.metaChip}>解码 {selectedRecord.decodeMs}ms</span>}
          </div>
          {selectedRecord.usage&&Object.keys(selectedRecord.usage).length>0&&
            <div className={styles.metaChips} aria-label="Token 统计">
              {Object.entries(selectedRecord.usage).map(([key,value])=><span key={key} className={styles.metaChip}>
                {key.replace(/([A-Z])/g,' $1')}: {String(value)}
              </span>)}
            </div>}
          {(['input','output','content'] as const).map(field=>{
            const raw=selectedRecord[field];
            if(!raw)return null;
            return <section key={field} className={styles.inspectionBlock}>
              <h4>{field==='input'?'Input':field==='output'?'Output':'Summary / Raw'}</h4>
              <pre>{typeof raw==='string'?raw:JSON.stringify(raw,null,2)}</pre>
            </section>;
          })}
        </>:<p className={styles.empty}>选择事件即可查看具体角色、内容、输入、输出、耗时与 Token。</p>}
      </aside>
    </div>
  </div>;
}
