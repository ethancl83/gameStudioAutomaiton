import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, join } from 'node:path';
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { object, text, AppError, redact } from '../../packages/domain/errors.js';
import { createBuildPlan, scanToolchains } from '../../packages/engines/index.js';
import { inspectProject } from '../../packages/inspection/index.js';
import { packFiles, unpackFiles, MAX_BUNDLE_BYTES } from '../../packages/remote-runner/index.js';
import { executeBuild } from './execute.js';
import { probeIsolation, type IsolationOptions } from './sandbox.js';
import { targetValue } from '../controller/validation.js';

export interface RemoteRunnerOptions { directory:string;port?:number;token?:string;isolation?:IsolationOptions;execute?:typeof executeBuild;engines?:Partial<Record<import('../../packages/domain/index.js').EngineKind,string>> }
export async function startRemoteRunner(options:RemoteRunnerOptions) {
  await mkdir(options.directory,{recursive:true,mode:0o700});
  const tokenPath=join(options.directory,'pairing-code');
  let token=options.token;
  if(!token){try{token=await readFile(tokenPath,'utf8');}catch{token=randomBytes(32).toString('base64url');await writeFile(tokenPath,token,{mode:0o600,flag:'wx'});}}
  if(token.length<24)throw new AppError('INVALID_RUNNER_AUTH','러너 연결 코드는 24자 이상이어야 합니다.');
  const expected=Buffer.from(token);let active:AbortController|undefined;
  const server=createServer(async(req,res)=>{
    const respond=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    const auth=req.headers.authorization;const actual=Buffer.from(auth?.startsWith('Bearer ')?auth.slice(7):'');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||req.headers.origin){respond(401,{error:'러너 인증이 필요합니다.'});return;}
    if(req.method==='GET'&&req.url==='/health'){const isolation=await probeIsolation();respond(200,{protocol:'appops-runner-v1',platform:process.platform,ready:Boolean(options.isolation?.launcher)||isolation.available,toolchains:await scanToolchains(),isolation:options.isolation?.launcher?'configured-launcher':isolation});return;}
    if(req.method!=='POST'||req.url!=='/build'){respond(404,{error:'지원하지 않는 러너 요청입니다.'});return;}
    if(active){respond(409,{error:'러너가 다른 빌드를 처리하고 있습니다.'});return;}
    const abort=new AbortController();active=abort;let work:string|undefined;
    const timeout=setTimeout(()=>abort.abort(),60*60_000);timeout.unref();
    res.once('close',()=>{if(!res.writableEnded)abort.abort();});
    try{
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req){size+=chunk.length;if(size>MAX_BUNDLE_BYTES*1.5)throw new AppError('BUNDLE_LIMIT','요청 크기가 너무 큽니다.',413);chunks.push(Buffer.from(chunk));}
      const body=object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const id=text(body.runId,'작업 ID',100);if(!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw new AppError('INVALID_RUN','작업 ID가 올바르지 않습니다.');
      const target=targetValue(body.target);const input=object(body.options??{});work=join(options.directory,'jobs',id);
      await rm(work,{recursive:true,force:true});const source=join(work,'source');const output=join(work,'output');
      await unpackFiles(body.source,source);const inspection=await inspectProject(source);
      const buildOptions:{target:typeof target;outputPath:string;configuration?:string;exportPreset?:string;scheme?:string}={target,outputPath:output};
      for(const key of ['configuration','exportPreset','scheme'] as const)if(input[key])buildOptions[key]=text(input[key],key,200);
      const plan=await createBuildPlan(inspection,{...buildOptions,engineExecutable:options.engines?.[inspection.engine]});
      if(plan.findings.some(f=>f.severity==='error'))throw new AppError('BUILD_PREREQUISITES',plan.findings.filter(f=>f.severity==='error').map(f=>f.message).join(' '),422);
      const logs:string[]=[];let logSize=0;
      const result=await(options.execute??executeBuild)(plan,{signal:abort.signal,isolation:options.isolation,onOutput:entry=>{if(logSize<64_000){const clean=redact(entry.text);logs.push(clean);logSize+=clean.length;}}});
      if(result.cancelled||result.exitCode!==0||!result.artifacts.length)throw new AppError('BUILD_FAILED','원격 빌드가 실패했습니다. '+logs.slice(-8).join('\n'),422);
      const artifacts:unknown[]=[];
      for(const [index,path]of result.artifacts.entries()){
        const artifactRoot=join(work,'transfer',String(index));await mkdir(artifactRoot,{recursive:true,mode:0o700});
        const kind=(await lstat(path)).isDirectory()?'directory':'file';const name=basename(path);
        await cp(path,join(artifactRoot,name),{recursive:true,dereference:false});
        artifacts.push({name,kind,bundle:await packFiles(artifactRoot,false)});
      }
      abort.signal.throwIfAborted();respond(200,{protocol:'appops-runner-v1',runId:id,result:{...result,artifacts:undefined},artifacts,logs});
    }catch(error){respond(error instanceof AppError?error.status:500,{error:redact(error instanceof Error?error.message:'러너 작업 오류')});}
    finally{clearTimeout(timeout);if(work)await rm(work,{recursive:true,force:true}).catch(()=>{});active=undefined;}
  });
  server.requestTimeout=60*60_000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??4320,'127.0.0.1',()=>resolve());});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Runner address unavailable');
  return {port:address.port,tokenPath,async close(){active?.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
