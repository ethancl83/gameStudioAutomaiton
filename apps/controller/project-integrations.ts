import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Connection, ExternalResource, Project } from '../../packages/domain/index.js';
import { AppError, object, prohibitSecrets, text } from '../../packages/domain/errors.js';
import type { Store } from '../../packages/storage/index.js';
import { applyIntegration, detectProjectSdks, previewIntegration, recoverIncomplete, rollbackIntegration, withIntegrationStorage,
  type IntegrationApplyResult, type IntegrationPreview, type IntegrationProvider, type IntegrationRequest } from '../../packages/project-integration/index.js';
import type { AppService } from './service.js';
import { readJournal } from '../../packages/project-integration/journal.js';
import { MINIMAL_IOS_PBXPROJ } from '../../packages/project-integration/templates/ios.js';

interface IntegrationHistory { previews:IntegrationPreview[]; applications:IntegrationApplyResult[] }
const terminal=new Set(['succeeded','failed','cancelled']);
/** Renderer selects registered identities; project-controlled files never supply executable changes or storage paths. */
export class ProjectIntegrations {
  private readonly active=new Set<string>();
  constructor(private readonly store:Store,private readonly service:AppService,private readonly mode:'demo'|'live'){}
  isBusy(id:string):boolean{return this.active.has(id);}
  assertAvailable(id:string):void{
    if(this.project(id).relinkRequired)throw new AppError('PROJECT_RELINK_REQUIRED','복원한 프로젝트의 원본 폴더를 먼저 연결해 주세요.',409);
    if(this.active.has(id))throw new AppError('PROJECT_BUSY','SDK 파일 변경 또는 복구가 끝난 뒤 다시 시도해 주세요.',409);
    if(this.store.get('settings','integration-recovery:'+id))throw new AppError('SDK_RECOVERY_REQUIRED','SDK 변경 복구가 필요합니다. 준비 화면의 적용 이력에서 백업과 현재 파일을 확인하고 되돌리기를 완료해 주세요.',409);
  }
  private requireRecovery(id:string,applyId?:string):void{
    this.store.put('settings','integration-recovery:'+id,{applyId,at:new Date().toISOString(),reason:'SDK 변경이 중단되었거나 원본 편집과 충돌했습니다. 백업을 보존하고 새 빌드를 중단했습니다.'});
  }
  private async captureRecovery(id:string,root:string):Promise<void>{
    try{const record=await readJournal(root);if(record&&['backing_up','applying','rolling_back','rollback_conflict'].includes(record.status))this.requireRecovery(id,record.applyId);}
    catch{this.requireRecovery(id);}
  }
  private project(id:string):Project{const p=this.store.get<Project>('project',id);if(!p)throw new AppError('NOT_FOUND','등록한 프로젝트가 없습니다.',404);return p;}
  private history(id:string):IntegrationHistory{return this.store.get<IntegrationHistory>('settings','integration:'+id)??{previews:[],applications:[]};}
  private async run<T>(id:string,fn:(project:Project)=>Promise<T>,allowRecovery=false):Promise<T>{
    const project=this.project(id);
    if(!allowRecovery)this.assertAvailable(id);
    if(this.active.has(id)||this.store.runs(100_000).some(r=>r.projectId===id&&!terminal.has(r.status)))throw new AppError('PROJECT_BUSY','진행 중인 프로젝트 작업을 완료하거나 취소한 뒤 SDK 변경을 적용해 주세요.',409);
    this.active.add(id);
    try{
      if(this.mode==='demo')await this.prepareDemo(project);
      if(await realpath(project.rootPath)!==project.rootPath)throw new AppError('PROJECT_MOVED','원본 프로젝트의 실제 위치가 바뀌었습니다.');
      return await withIntegrationStorage(project.rootPath,join(this.store.directory,'project-integrations',id),()=>fn(project));
    }finally{this.active.delete(id);}
  }
  async state(id:string){
    const project=this.project(id);if(this.mode==='demo')await this.prepareDemo(project);
    const detection=project.relinkRequired?{root:project.rootPath,engine:project.engine,engineEvidence:[],sdks:[],findings:[{code:'project.relink',severity:'error' as const,message:'복원한 프로젝트의 원본 폴더를 먼저 연결해 주세요.'}]}:await detectProjectSdks(project.rootPath);
    return {detection,...this.history(id),recoveryRequired:this.store.get('settings','integration-recovery:'+id)??null};
  }
  async preview(id:string,input:unknown):Promise<IntegrationPreview>{
    return this.run(id,async project=>{
      const data=object(input);prohibitSecrets(data);
      const provider=text(data.provider,'SDK 제공자',30) as IntegrationProvider;
      if(!['admob','applovin-max','play-billing','app-store'].includes(provider))throw new AppError('INVALID_PROVIDER','연결할 SDK를 선택해 주세요.');
      const platform=text(data.platform,'플랫폼',10);
      if(!['android','ios'].includes(platform)||!project.targets.includes(platform as 'android'|'ios'))throw new AppError('UNSUPPORTED_TARGET','프로젝트에서 지원하는 모바일 대상을 선택해 주세요.');
      if(provider==='play-billing'&&platform!=='android'||provider==='app-store'&&platform!=='ios')throw new AppError('SDK_PLATFORM','결제 SDK와 플랫폼이 일치하지 않습니다.');
      if(project.engine==='unknown')throw new AppError('UNKNOWN_ENGINE','프로젝트 엔진을 먼저 확인해 주세요.');
      const connection=this.store.get<Connection>('connection',text(data.connectionId,'연결 계정',100));
      if(!connection||connection.provider!==(provider==='play-billing'?'google-play':provider)||connection.status!=='connected'||!project.policy.allowedConnectionIds.includes(connection.id))throw new AppError('SDK_CONNECTION','프로젝트에서 사용할 SDK 계정을 연결하고 권한을 확인해 주세요.');
      const all=this.store.list<ExternalResource>('resource');
      const select=(raw:unknown,kind:'ad-unit'|'product'):ExternalResource[]=>{
        if(raw===undefined)return [];
        if(!Array.isArray(raw)||raw.length>100||raw.some(v=>typeof v!=='string'))throw new AppError('INVALID_INPUT','동기화한 광고 단위·상품을 선택해 주세요.');
        return [...new Set(raw)].map(value=>{
          const resource=all.find(r=>r.id===value);const source=resource&&this.store.get<Connection>('connection',resource.connectionId);
          if(!resource||resource.kind!==kind||resource.projectId!==id||!source||source.status!=='connected'||!project.policy.allowedConnectionIds.includes(source.id)||resource.status==='deleted')throw new AppError('SDK_RESOURCE','이 프로젝트에서 확인한 광고 단위·상품만 사용할 수 있습니다.');
          if(kind==='ad-unit'&&(source.id!==connection.id||source.provider!==provider)||kind==='product'&&source.provider!==(platform==='android'?'google-play':'app-store'))throw new AppError('SDK_RESOURCE','SDK 제공자·플랫폼과 선택한 항목이 일치하지 않습니다.');
          if(kind==='product'&&['play-billing','app-store'].includes(provider)&&source.id!==connection.id)throw new AppError('SDK_RESOURCE','선택한 스토어 계정의 상품을 사용해 주세요.');
          return resource;
        });
      };
      const units=select(data.adUnitIds,'ad-unit'),products=select(data.productIds,'product');
      const appIds=new Set(all.filter(r=>r.connectionId===connection.id&&r.projectId===id).map(r=>r.data.admobAppId).filter((v):v is string=>typeof v==='string'));
      if(this.mode==='demo'&&provider==='admob')appIds.add('ca-app-pub-3940256099942544~3347511713');
      let appId=data.appId?text(data.appId,'공개 앱 ID',200):undefined;
      if(provider==='admob'){
        if(!appId&&appIds.size===1)appId=[...appIds][0];
        if(!appId||!appIds.has(appId))throw new AppError('SDK_APP_ID','동기화한 AdMob 앱 ID를 선택해 주세요.');
        if(units.some(r=>typeof r.data.admobAppId==='string'&&r.data.admobAppId!==appId))throw new AppError('SDK_APP_ID','같은 AdMob 앱의 광고 단위를 선택해 주세요.');
      }else if(appId&&appId!==project.appIdentifier)throw new AppError('SDK_APP_ID','프로젝트와 다른 앱 식별자를 사용할 수 없습니다.');
      else appId=project.appIdentifier??undefined;
      const credentials=provider==='applovin-max'?await this.service.vault.get(connection.id):{};
      const request:IntegrationRequest={projectRoot:project.rootPath,engine:project.engine,platform:platform as 'android'|'ios',provider,appId,
        adUnits:units.map(r=>({adUnitId:this.mode==='demo'?(provider==='admob'?'ca-app-pub-3940256099942544/5224354917':'0123456789abcdef'):r.externalId,name:r.name,adFormat:String(r.data.adFormat??r.data.format??'REWARD'),platform})),
        products:products.map(r=>({productId:String(r.data.productId??r.externalId),name:r.name,productType:String(r.data.productType??'inapp')})),
        options:{includePurchases:products.length>0,maxSdkKeyBound:Boolean(credentials.sdkKey)}};
      const preview=await previewIntegration(request);const history=this.history(id);history.previews=[preview,...history.previews].slice(0,100);
      this.store.writeBatch([{kind:'settings',id:'integration:'+id,value:history}],[],[{projectId:id,kind:'sdk.previewed',message:'광고·결제 SDK 변경 미리보기를 만들었습니다.',data:{previewId:preview.previewId,provider,platform}}]);return preview;
    });
  }
  async apply(id:string,input:unknown):Promise<IntegrationApplyResult>{return this.run(id,async project=>{
    const previewId=text(object(input).previewId,'미리보기 ID',100);const history=this.history(id);
    if(!history.previews.some(p=>p.previewId===previewId))throw new AppError('SDK_PREVIEW_REQUIRED','이 프로젝트의 변경 미리보기를 먼저 확인해 주세요.');
    let result:IntegrationApplyResult;
    try{result=await applyIntegration({projectRoot:project.rootPath,previewId});}
    catch(error){await this.captureRecovery(id,project.rootPath);throw error;}
    if(result.findings.some(f=>f.code==='apply.rollback_conflict'))this.requireRecovery(id,result.applyId);
    history.applications=[result,...history.applications.filter(a=>a.applyId!==result.applyId)].slice(0,200);
    this.store.writeBatch([{kind:'settings',id:'integration:'+id,value:history}],[],[{projectId:id,kind:'sdk.applied',level:result.status==='applied'?'info':'warning',message:result.status==='applied'?'SDK 파일 변경을 적용했습니다. 게임 이벤트 연결·실행 검증을 진행해 주세요.':'SDK 변경을 적용하지 못했습니다. 결과에서 원인을 확인해 주세요.',data:{applyId:result.applyId,status:result.status}}]);return result;
  });}
  async rollback(id:string,input:unknown){return this.run(id,async project=>{
    const applyId=text(object(input).applyId,'적용 ID',100);const history=this.history(id);
    const recovery=this.store.get<{applyId?:string}>('settings','integration-recovery:'+id);
    if(!history.applications.some(a=>a.applyId===applyId)&&recovery?.applyId!==applyId)throw new AppError('SDK_APPLY_REQUIRED','이 프로젝트의 적용 이력을 선택해 주세요.');
    let result;
    try{result=await rollbackIntegration(applyId,project.rootPath);}
    catch(error){this.requireRecovery(id,applyId);throw error;}
    if(['rolled_back','noop'].includes(result.status))this.store.remove('settings','integration-recovery:'+id);
    else this.requireRecovery(id,applyId);
    if(['rolled_back','noop'].includes(result.status))history.applications=history.applications.map(a=>a.applyId===applyId?{...a,status:'failed',wiring:a.wiring.map(w=>({...w,status:'missing',detail:'이 적용을 되돌렸습니다.'})),findings:[...a.findings,{code:'apply.rolled_back',severity:'info',message:'원본으로 되돌렸습니다.'}]}:a);
    this.store.writeBatch([{kind:'settings',id:'integration:'+id,value:history}],[],[{projectId:id,kind:'sdk.rolled_back',level:result.status==='conflict'?'warning':'info',message:'SDK 되돌리기 결과: '+result.status,data:{applyId,status:result.status}}]);return result;
  },true);}
  async recover():Promise<void>{
    for(const p of this.store.list<Project>('project')){
      if(p.relinkRequired)continue;
      if(!this.store.get('settings','integration:'+p.id))continue;
      try{await withIntegrationStorage(p.rootPath,join(this.store.directory,'project-integrations',p.id),async()=>{
        const r=await recoverIncomplete(p.rootPath);
        if(!r)return;
        if(['rolled_back','noop'].includes(r.status))this.store.remove('settings','integration-recovery:'+p.id);
        else this.requireRecovery(p.id,r.applyId);
        this.store.addEvent({projectId:p.id,kind:'sdk.recovery',level:r.status==='conflict'?'warning':'info',message:'중단된 SDK 변경 복구 결과: '+r.status,data:{applyId:r.applyId,status:r.status}});
      });}catch{this.requireRecovery(p.id);this.store.addEvent({projectId:p.id,kind:'sdk.recovery-required',level:'warning',message:'중단된 SDK 변경 이력을 확인해 주세요. 원본을 자동 덮어쓰지 않았습니다.'});}
    }
  }
  private async prepareDemo(p:Project):Promise<void>{
    if(this.store.get<{schema?:number}>('settings','demo-sdk-project:'+p.id)?.schema===2&&(await lstat(p.rootPath).catch(()=>null))?.isDirectory())return;
    const files:Record<string,string>=p.engine==='android'?{'settings.gradle':"include ':app'\n",'app/build.gradle':"plugins { id 'com.android.application' }\nandroid { namespace 'com.appops.demo' }\ndependencies { }\n",'app/src/main/AndroidManifest.xml':'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Demo">\n</application></manifest>'}:p.engine==='godot'?{'project.godot':'config_version=5\n[application]\nconfig/name="Demo"\n'}:p.engine==='unity'?{'Packages/manifest.json':'{"dependencies":{}}','ProjectSettings/ProjectVersion.txt':'m_EditorVersion: 6000.0.0f1\n'}:p.engine==='unreal'?{'Demo.uproject':'{"FileVersion":3,"Modules":[{"Name":"Demo","Type":"Runtime"}]}','Source/Demo/Demo.Build.cs':'using UnrealBuildTool; public class Demo : ModuleRules { public Demo(ReadOnlyTargetRules Target) : base(Target) { PublicDependencyModuleNames.AddRange(new string[] {"Core"}); } }'}:{'Demo.xcodeproj/project.pbxproj':MINIMAL_IOS_PBXPROJ.replaceAll('com.example.AppOpsFixture',p.appIdentifier??'com.appops.demo'),'AppDelegate.swift':'import UIKit\n@main final class AppDelegate: UIResponder, UIApplicationDelegate { var window: UIWindow?; func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { window = UIWindow(frame: UIScreen.main.bounds); window?.rootViewController = UIViewController(); window?.makeKeyAndVisible(); return true } }\n','Podfile':"platform :ios, '15.0'\ntarget 'App' do\nend\n",'Info.plist':'<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>'};
    for(const [name,content] of Object.entries(files)){const path=join(p.rootPath,name);await mkdir(dirname(path),{recursive:true,mode:0o700});try{await writeFile(path,content,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile())throw new AppError('DEMO_PROJECT_CHANGED','데모 프로젝트의 파일 경로를 확인해 주세요.');const previous=await readFile(path,'utf8');if(previous==='// Synthetic demo project'||name==='Podfile'&&previous==="platform :ios, '15.0'\ntarget 'Demo' do\nend\n")await writeFile(path,content,{mode:0o600});}}
    this.store.put('settings','demo-sdk-project:'+p.id,{schema:2,createdAt:new Date().toISOString()});
  }
}
