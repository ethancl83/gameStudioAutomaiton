import {useState} from 'react';
import {api,type DemoScenario} from '../api';
import {useAction} from '../useAction';
import {Card,Field,Modal,Notice,Spinner} from './ui';
import type {AppState} from '../../../../packages/domain';

export function DemoControls({state,refresh}:{state:AppState;refresh:()=>Promise<void>}) {
  const [scenario,setScenario]=useState<DemoScenario>('normal');
  const [confirm,setConfirm]=useState(false);
  const change=useAction<{scenario:DemoScenario}>(refresh);
  const reset=useAction<{reset:true}>();
  const busy=state.runs.some(run=>['queued','running','retry_wait','waiting_external','action_required'].includes(run.status));
  if(!api.isDemo())return null;
  async function resetData(){const result=await reset.run(()=>api.resetDemo());if(result?.ok)window.location.reload();}
  return <Card title="데모 체험 설정">
    <p className="small muted">실패와 복구 과정을 직접 확인하거나 기본 데모로 다시 시작할 수 있습니다.</p>
    <div className="row" style={{gap:12,alignItems:'flex-end',flexWrap:'wrap'}}>
      <Field label="적용할 상황" htmlFor="demo-scenario">
        <select id="demo-scenario" className="select" value={scenario} onChange={event=>{setScenario(event.target.value as DemoScenario);change.reset();}}>
          <option value="normal">정상 동작</option><option value="network-error">네트워크 오류 후 자동 재시도</option><option value="auth-expired">권한 만료 후 연결 복구</option><option value="review-rejected">스토어 심사 거절</option>
        </select>
      </Field>
      <button className="btn" disabled={change.pending||reset.pending} onClick={()=>void change.run(()=>api.setDemoScenario(scenario))}>{change.pending?<Spinner/>:null} 상황 적용</button>
      <button className="btn btn--danger" disabled={busy||change.pending||reset.pending} onClick={()=>{reset.reset();setConfirm(true);}}>데모 초기화</button>
    </div>
    {busy&&<p className="small muted">진행 중이거나 확인이 필요한 작업을 완료·취소하면 초기화할 수 있습니다.</p>}
    {change.result&&<p className="small">{change.result.scenario==='normal'?'정상 동작으로 설정했습니다.':'다음 해당 서비스 작업에 선택한 상황을 적용합니다.'}</p>}
    {change.error&&<Notice tone="error">{change.error.message}</Notice>}
    {confirm&&<Modal title="데모 데이터 초기화" onClose={()=>{if(!reset.pending)setConfirm(false);}} footer={<><button className="btn" disabled={reset.pending} onClick={()=>setConfirm(false)}>취소</button><button className="btn btn--danger" disabled={busy||reset.pending} onClick={()=>void resetData()}>{reset.pending?<Spinner/>:null} 초기화 실행</button></>}>
      <p>데모에서 만든 프로젝트·작업·키·백업을 지우고 9개 연결과 5개 기본 프로젝트를 다시 준비합니다. 실제 운영 데이터는 보존됩니다.</p>
      {reset.error&&<Notice tone="error">{reset.error.message}</Notice>}
    </Modal>}
  </Card>;
}
