// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {hanaFetch} from '../../../hooks/use-hana-fetch';
import {TrajectoryView} from '../TrajectoryView';
vi.mock('../../../hooks/use-hana-fetch',()=>({hanaFetch:vi.fn()}));
const first=[
  {seq:2,time:1000,turn:1,step:0,role:'user',kind:'user/message',label:'User',content:'inspect files'},
  {seq:3,time:1020,turn:1,step:1,role:'model',kind:'step/start',label:'Model step begins',content:'',endAt:1120,durationMs:100},
  {seq:4,time:1040,turn:1,step:1,role:'tool',kind:'tool/call',label:'read_file',content:'{"path":"src"}',input:'{"path":"src"}',endAt:1100,durationMs:60},
  {seq:5,time:1100,turn:1,step:1,role:'tool',kind:'tool/result',label:'Tool result',content:'file ok',output:'file ok'},
  {seq:6,time:1120,turn:1,step:1,role:'assistant',kind:'assistant/message',label:'Assistant',content:'Summary',usage:{inputTokens:10,outputTokens:20}},
];
const success=(data:unknown)=>new Response(JSON.stringify(data),{status:200});
beforeEach(()=>{vi.mocked(hanaFetch).mockReset();vi.mocked(hanaFetch).mockResolvedValue(success({ok:true,records:first,total:6,hasMore:true,nextBefore:2}));});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('native Trajectory tab',()=>{
  it('renders real three-track timing, colored roles, and verified event inspector',async()=>{
    render(<TrajectoryView sessionPath="/sessions/active.jsonl" active/>);
    expect(await screen.findByText('read_file')).toBeInTheDocument();
    expect(screen.getByRole('region',{name:'执行时间轴'})).toBeInTheDocument();
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
    fireEvent.click(screen.getByText('read_file'));
    const inspector=screen.getByRole('complementary',{name:'轨迹事件详情'});
    expect(inspector).toHaveTextContent('60 ms');
    expect(inspector).toHaveTextContent('src');
    expect(inspector).toHaveTextContent('Input');
    fireEvent.click(screen.getByRole('button',{name:'ASSISTANT'}));
    expect(screen.queryByText('User')).not.toBeInTheDocument();
    expect(screen.getByText('Assistant')).toBeInTheDocument();
  });
  it('pages older events by cursor, preserving the newest ones without duplicates',async()=>{
    vi.mocked(hanaFetch).mockImplementation(async url=>success(String(url).includes('before=2')?
      {ok:true,records:[{seq:0,time:900,turn:0,step:0,role:'system',kind:'request/header',label:'Model request',content:'System'}],total:6,hasMore:false,nextBefore:null}:
      {ok:true,records:first,total:6,hasMore:true,nextBefore:2}));
    render(<TrajectoryView sessionPath="session-a" active/>);
    await screen.findByText('read_file');
    fireEvent.click(screen.getByRole('button',{name:'加载更早事件'}));
    expect(await screen.findByText('Model request')).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'加载更早事件'})).not.toBeInTheDocument();
    expect(vi.mocked(hanaFetch).mock.calls.some(([url])=>String(url).includes('before=2'))).toBe(true);
  });
  it('filters through separate keyboard-accessible time range controls without blocking event clicks',async()=>{
    render(<TrajectoryView sessionPath="session-timeline" active/>);
    expect(await screen.findByText('read_file')).toBeInTheDocument();
    const rangeFrom=screen.getByRole('slider',{name:'时间起点'});
    const rangeTo=screen.getByRole('slider',{name:'时间终点'});
    expect(rangeFrom).toHaveValue('0');
    expect(rangeTo).toHaveValue('100');
    fireEvent.change(rangeFrom,{target:{value:'75'}});
    expect(rangeFrom).toHaveValue('75');
    expect(screen.queryByText('User')).not.toBeInTheDocument();
    expect(screen.getByText('Tool result')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'重置区间'}));
    expect(screen.getByText('User')).toBeInTheDocument();
    fireEvent.click(screen.getByText('read_file'));
    const panel=screen.getByRole('complementary',{name:'轨迹事件详情'});
    expect(panel).toHaveTextContent('60 ms');
    expect(panel.querySelector('dl')).toBeNull();
  });
  it('fails closed without native trajectory support; no fake usage or times',async()=>{
    vi.mocked(hanaFetch).mockResolvedValue(new Response(JSON.stringify({ok:false,error:'session_trajectory unavailable'}),{status:501}));
    render(<TrajectoryView sessionPath="session-a" active/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('session_trajectory unavailable');
    expect(screen.getByText('无法读取原生轨迹')).toBeInTheDocument();
  });
});
