import { useEffect, useId, useRef, useState } from 'react';
import type { ImportedArtifact } from '../../../../packages/domain';
import { api } from '../api';
import { Field, Notice, Spinner } from './ui';

export function ArtifactPicker({projectId,target,assets,value,onChange,refresh,demo=false}: {projectId:string;target:string;assets:ImportedArtifact[];value:string;onChange:(id:string)=>void;refresh:()=>Promise<void>;demo?:boolean}) {
  const id=useId(),alive=useRef(true);const [path,setPath]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState(''),[imported,setImported]=useState<ImportedArtifact[]>([]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const options=[...assets,...imported.filter(item=>!assets.some(asset=>asset.id===item.id))].filter(asset=>asset.projectId===projectId&&asset.target===target);
  const selected=options.find(asset=>asset.id===value);
  async function add(){
    setPending(true);setError('');
    try{const result=await api.importArtifact(projectId,{path:demo?'demo':path.trim(),target});if(!alive.current)return;
      if(!result.ok)throw new Error(result.error.message);setImported(items=>[...items,result.data]);onChange(result.data.id);await refresh();
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'결과물을 가져오지 못했습니다.');}finally{if(alive.current)setPending(false);}
  }
  return <div className="stack" style={{gap:10}}>
    <Field label="업로드할 외부 결과물" required htmlFor={id} hint={target==='android'?'외부에서 서명한 AAB 또는 APK':target==='ios'?'외부에서 배포용으로 서명한 IPA':'Steam에 업로드할 콘텐츠 폴더'}>
      <select id={id} className="select" value={selected?value:''} disabled={pending} onChange={event=>onChange(event.target.value)}>
        <option value="">결과물 선택</option>{options.map(asset=><option key={asset.id} value={asset.id}>{asset.name}{asset.version?' · '+asset.version:''} · {(asset.size/1024**2).toFixed(1)} MiB</option>)}
      </select>
    </Field>
    {!demo&&<Field label="결과물 경로" htmlFor={id+'-path'} hint="원본은 보존하고 앱 보관 폴더에 복사합니다.">
      <div className="row" style={{gap:8}}><input id={id+'-path'} className="input" value={path} disabled={pending} onChange={event=>setPath(event.target.value)} placeholder={['android','ios'].includes(target)?'/path/to/release.'+(target==='ios'?'ipa':'aab'):'/path/to/steam-content'} />
      {api.isElectron&&<button className="btn" disabled={pending} onClick={()=>void api.selectArtifact(target).then(value=>{if(value&&alive.current)setPath(value);})}>찾아보기</button>}</div>
    </Field>}
    <button className="btn" disabled={pending||(!demo&&!path.trim())} onClick={()=>void add()}>{pending?<><Spinner /> 결과물 복사·확인 중</>:demo?'데모 결과물 가져오기':'결과물 가져오기'}</button>
    {selected&&<p className="small faint" style={{margin:0}}>{selected.appIdentifier&&<><span className="mono">{selected.appIdentifier}</span> · </>}SHA-256 {selected.sha256.slice(0,12)}…{selected.signature==='present'?' · 서명 정보 포함. 서명 유효성은 스토어에서 최종 확인합니다.':''}</p>}
    {error&&<Notice tone="error">{error}</Notice>}
  </div>;
}
