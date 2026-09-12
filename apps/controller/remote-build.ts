import { join } from 'node:path';
import type { BuildExecutionResult, RunnerRegistration, Run } from '../../packages/domain/index.js';
import { AppError, object, text } from '../../packages/domain/errors.js';
import type { CredentialVault } from '../../packages/credentials/index.js';
import { packFiles, unpackFiles, boundedJson, bundlePath } from '../../packages/remote-runner/index.js';
import type { ExecutionContext } from './queue.js';

export async function remoteBuild(runner:RunnerRegistration,run:Run,source:string,output:string,vault:CredentialVault,execution:ExecutionContext):Promise<BuildExecutionResult> {
  if(runner.status!=='ready')throw new AppError('RUNNER_UNAVAILABLE','선택한 원격 러너의 연결 상태를 확인해 주세요.',409);
  const credentials=await vault.get('runner-'+runner.id);const code=text(credentials.pairingToken,'러너 연결 코드',500);
  execution.progress(runner.label+'에 검증한 소스 스냅샷을 전송합니다.');
  const bundle=await packFiles(source);
  const response=await fetch(runner.endpoint+'/build',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+code},body:JSON.stringify({runId:run.id,target:run.input.target,options:{configuration:run.input.configuration,exportPreset:run.input.exportPreset,scheme:run.input.scheme},source:bundle}),signal:AbortSignal.any([execution.signal,AbortSignal.timeout(60*60_000)]),redirect:'error'});
  const body=await boundedJson(response);
  if(!response.ok)throw new AppError(response.status===409?'TEMPORARY':'REMOTE_BUILD_FAILED',typeof body.error==='string'?body.error:'원격 빌드가 실패했습니다.',response.status);
  if(body.protocol!=='appops-runner-v1'||body.runId!==run.id||!Array.isArray(body.artifacts)||!body.artifacts.length||body.artifacts.length>1000)throw new AppError('RUNNER_RESPONSE','원격 결과물의 작업 신원이 일치하지 않습니다.',502);
  const artifacts:string[]=[];
  for(const [index,entry]of body.artifacts.entries()){
    const item=object(entry);const name=bundlePath(text(item.name,'결과물 이름',255));if(name.includes('/'))throw new AppError('RUNNER_RESPONSE','결과물 이름을 확인해 주세요.',502);
    // Keep executable/sidecar siblings adjacent, as produced by the engine.
    // Exclusive writes reject colliding names instead of overwriting an artifact.
    await unpackFiles(item.bundle,output,false);artifacts.push(join(output,name));
  }
  if(Array.isArray(body.logs))for(const line of body.logs.slice(-100))if(typeof line==='string')execution.progress(line.slice(0,2000));
  execution.checkpoint({runnerId:runner.id,runnerLabel:runner.label});
  return {exitCode:0,cancelled:false,artifacts,startedAt:run.startedAt??new Date().toISOString(),finishedAt:new Date().toISOString()};
}
