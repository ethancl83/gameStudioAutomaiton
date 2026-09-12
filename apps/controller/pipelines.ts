import { randomUUID } from 'node:crypto';
import type { Connection, Project, ReleasePipeline, RunnerRegistration, Run } from '../../packages/domain/index.js';
import { AppError, object, text, canonical } from '../../packages/domain/errors.js';
import type { Store } from '../../packages/storage/index.js';
import { enforcePolicy, targetValue } from './validation.js';

interface Actions {
  build(projectId:string,input:unknown,pipeline?:ReleasePipeline):Run;
  action(connectionId:string,input:unknown,pipeline?:ReleasePipeline):Run;
  inspect(projectId:string):Promise<Project>;
  cancel(runId:string):Run;
}
const stamp = () => new Date().toISOString();
const pending = new Set(['queued','running','retry_wait']);
export class ReleasePipelines {
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(private store:Store,private actions:Actions) {}
  start():void { this.timer=setInterval(()=>this.cycle(),300);this.timer.unref();this.cycle(); }
  stop():void { clearInterval(this.timer); }
  list():ReleasePipeline[] { return this.store.list<ReleasePipeline>('pipeline'); }
  async publish(projectId:string,body:unknown):Promise<ReleasePipeline> {
    const data=object(body); const target=targetValue(data.target);
    const project=this.store.get<Project>('project',projectId);
    const connectionId=text(data.connectionId,'스토어 연결',100);
    const connection=this.store.get<Connection>('connection',connectionId);
    if (!project || !connection || connection.status==='disconnected') throw new AppError('NOT_FOUND','프로젝트와 연결된 스토어를 선택해 주세요.',404);
    const importedArtifactId=data.importedArtifactId?text(data.importedArtifactId,'가져온 결과물 ID',100):undefined;
    if (!importedArtifactId&&!project.targets.includes(target)) throw new AppError('UNSUPPORTED_TARGET','이 프로젝트가 지원하는 빌드 대상을 선택해 주세요.');
    const eligible=target==='android'?['google-play']:target==='ios'?['app-store']:target==='macos'?['app-store','steam']:['steam'];
    if (!eligible.includes(connection.provider)) throw new AppError('PROVIDER_MISMATCH','빌드 대상과 스토어가 일치하지 않습니다.');
    const input:Record<string,unknown>={track:data.track?text(data.track,'배포 트랙',100):'internal'};
    if(importedArtifactId)input.importedArtifactId=importedArtifactId;
    for (const key of ['version','releaseNotes','configuration','exportPreset','scheme','runnerId']) if (data[key]!==undefined&&data[key]!=='') input[key]=text(data[key],key,key==='releaseNotes'?4000:200);
    enforcePolicy(project,connection,'upload-build',input);
    const key=data.idempotencyKey ? text(data.idempotencyKey,'출시 요청 키',128) : undefined;
    const previous=this.list().find(p=>p.projectId===projectId&&(key?p.input.requestKey===key:p.connectionId===connectionId&&p.target===target&&!['succeeded','failed','cancelled'].includes(p.status)&&canonical(p.input)===canonical(input)));
    if (previous) {
      if (key&&(previous.connectionId!==connectionId||previous.target!==target||canonical({...previous.input,requestKey:undefined})!==canonical({...input,requestKey:undefined}))) throw new AppError('IDEMPOTENCY_CONFLICT','같은 요청 키에 다른 출시 내용을 사용할 수 없습니다.',409);
      return previous;
    }
    if(importedArtifactId){
      const id=randomUUID(),at=stamp();
      const pipeline:ReleasePipeline={id,projectId,connectionId,target,status:'uploading',buildRunId:'',input:{...input,...(key?{requestKey:key}:{})},error:null,createdAt:at,updatedAt:at};
      this.actions.action(connectionId,{operation:'upload-build',projectId,input,idempotencyKey:'pipeline_'+id.replaceAll('-','')},pipeline);
      this.store.addEvent({projectId,kind:'pipeline.started',message:project.name+' 외부 결과물의 스토어 업로드를 시작합니다.',data:{pipelineId:id}});
      return this.store.get<ReleasePipeline>('pipeline',id)!;
    }
    const inspection=await this.actions.inspect(projectId);
    const runner=input.runnerId?this.store.get<RunnerRegistration>('runner',String(input.runnerId)):undefined;
    const remoteMac=target==='ios'&&runner?.status==='ready'&&runner.platform==='darwin';
    if (inspection.findings.some(f=>f.severity==='error'&&!(f.code==='ios.requires_macos'&&remoteMac))) throw new AppError('INSPECTION_FAILED','프로젝트 검수 오류를 해결한 뒤 출시해 주세요.',422);
    const id=randomUUID();const at=stamp();
    const pipeline:ReleasePipeline={id,projectId,connectionId,target,status:'building',buildRunId:'',input:{...input,...(key?{requestKey:key}:{})},error:null,createdAt:at,updatedAt:at};
    this.actions.build(projectId,{...input,target},pipeline);
    this.store.addEvent({projectId,kind:'pipeline.started',message:project.name+' 검수 완료 · 빌드와 스토어 업로드를 시작합니다.',data:{pipelineId:id}});
    return this.store.get<ReleasePipeline>('pipeline',id)!;
  }
  cancel(id:string):ReleasePipeline {
    const pipeline=this.store.get<ReleasePipeline>('pipeline',id);
    if (!pipeline) throw new AppError('NOT_FOUND','출시 작업을 찾을 수 없습니다.',404);
    if (pipeline.status==='succeeded') throw new AppError('ALREADY_FINISHED','이미 완료된 출시입니다.',409);
    const child=this.store.getRun(pipeline.uploadRunId??pipeline.buildRunId);
    if (child&&['waiting_external','action_required'].includes(child.status)&&this.store.effectState(child.id)!=='prepared') throw new AppError('RECONCILIATION_REQUIRED','스토어에 보낸 작업의 반영 상태를 먼저 확인해 주세요.',409);
    if (child&&pending.has(child.status)) {
      const cancelled=this.actions.cancel(child.id);
      if (cancelled.status==='action_required') return this.save(pipeline,{status:'action_required',error:cancelled.error});
    }
    return this.save(pipeline,{status:'cancelled',error:null});
  }
  cycle():void { for (const pipeline of this.list()) if (!['succeeded','cancelled'].includes(pipeline.status)) {try {this.advance(pipeline);}catch(error){try{this.save(pipeline,{status:'action_required',error:error instanceof Error?error.message:'출시 진행 조건을 확인해 주세요.'});}catch{}}} }
  private save(pipeline:ReleasePipeline,patch:Partial<ReleasePipeline>):ReleasePipeline {
    const updated={...pipeline,...patch,updatedAt:stamp()};
    if (pipeline.status===updated.status&&pipeline.error===updated.error&&pipeline.buildRunId===updated.buildRunId&&pipeline.uploadRunId===updated.uploadRunId) return pipeline;
    this.store.writeBatch([{kind:'pipeline',id:pipeline.id,value:updated}],[],[{projectId:pipeline.projectId,kind:'pipeline.'+updated.status,message:'출시 흐름: '+updated.status+(updated.error?' · '+updated.error:''),data:{pipelineId:pipeline.id,buildRunId:updated.buildRunId,uploadRunId:updated.uploadRunId}}]);
    return updated;
  }
  private advance(initial:ReleasePipeline):void {
    if(initial.restoredPaused)return;
    let pipeline=initial;
    if(pipeline.input.importedArtifactId){
      if(!pipeline.uploadRunId){
        const {requestKey:_,...input}=pipeline.input;
        const upload=this.actions.action(pipeline.connectionId,{operation:'upload-build',projectId:pipeline.projectId,input,idempotencyKey:'pipeline_'+pipeline.id.replaceAll('-','')},pipeline);
        pipeline=this.save(pipeline,{uploadRunId:upload.id,status:'uploading',error:null});
      }
      this.advanceUpload(pipeline);return;
    }
    if (!pipeline.buildRunId) {
      // Recover a crash after enqueuing the child but before publishing its pointer.
      const found=this.store.runs(100_000).find(r=>r.kind==='build'&&r.input.pipelineId===pipeline.id);
      const build=found??this.actions.build(pipeline.projectId,{...pipeline.input,target:pipeline.target},pipeline);
      pipeline=this.save(pipeline,{buildRunId:build.id,status:'building'});
    }
    const build=this.store.getRun(pipeline.buildRunId);
    if (!build) {this.save(pipeline,{status:'failed',error:'출시에 필요한 빌드 이력이 없습니다.'});return;}
    if (build.status!=='succeeded') {this.save(pipeline,{status:pending.has(build.status)?'building':build.status==='cancelled'?'cancelled':build.status==='action_required'?'action_required':'failed',error:build.error});return;}
    if (!pipeline.uploadRunId) {
      const {requestKey:_,configuration:__,exportPreset:___,scheme:____,runnerId:_____,...releaseInput}=pipeline.input;
      const upload=this.actions.action(pipeline.connectionId,{operation:'upload-build',projectId:pipeline.projectId,input:{...releaseInput,buildRunId:build.id},idempotencyKey:'pipeline_'+pipeline.id.replaceAll('-','')},pipeline);
      pipeline=this.save(pipeline,{uploadRunId:upload.id,status:'uploading',error:null});
    }
    this.advanceUpload(pipeline);
  }
  private advanceUpload(pipeline:ReleasePipeline):void {
    const upload=this.store.getRun(pipeline.uploadRunId!);
    if (!upload) {this.save(pipeline,{status:'failed',error:'출시에 필요한 업로드 이력이 없습니다.'});return;}
    this.save(pipeline,{status:upload.status==='succeeded'?'succeeded':upload.status==='cancelled'?'cancelled':upload.status==='failed'?'failed':upload.status==='action_required'?'action_required':'uploading',error:upload.error});
  }
}
