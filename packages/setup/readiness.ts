import type { AppState, BuildTarget, Finding, Project, Provider, RunnerRegistration, Toolchain } from '../domain/index.js';
import type { PreparationCheck, PreparationPreferences, ProjectPreparation, ToolId } from './types.js';

const toolNames:Record<string,string>={godot:'Godot 편집기',unity:'Unity 편집기','unreal-uat':'Unreal 빌드 도구','unreal-engine-root':'Unreal 엔진','godot-export-templates':'Godot 내보내기 템플릿','jdk-home':'Android용 JDK','android-sdk-validated':'Android SDK','gradle-offline-cache':'Gradle 의존성 캐시',xcodebuild:'Xcode'};
const installIds:Record<string,ToolId>={godot:'godot',unity:'unity','unreal-uat':'unreal','unreal-engine-root':'unreal','godot-export-templates':'godot-templates','jdk-home':'jdk','android-sdk-validated':'android-sdk','gradle-offline-cache':'gradle-cache',xcodebuild:'xcode'};
export function requiredTools(project:Project,target:BuildTarget):string[]{
  const keys:string[]=[];
  if(project.engine==='godot')keys.push('godot','godot-export-templates');
  if(project.engine==='unity')keys.push('unity');
  if(project.engine==='unreal')keys.push('unreal-uat','unreal-engine-root');
  if(target==='android')keys.push('jdk-home','android-sdk-validated','gradle-offline-cache');
  if(target==='ios')keys.push('xcodebuild');
  return [...new Set(keys)];
}
export function storeForTarget(target:BuildTarget):Provider{return target==='android'?'google-play':target==='ios'?'app-store':'steam';}
export interface PreparationEvidence {
  preferences:PreparationPreferences; state:AppState; runners:RunnerRegistration[];
  isolation:{available:boolean;reason?:string}; runnerTools?:Toolchain[]; planFindings?:Finding[];
  sdk?:{installed:boolean;verified:boolean;detail:string};
}
/** Pure decision logic: account presence, one unrelated SDK, or a saved checkbox is never proof of a runnable project. */
export function evaluatePreparation(project:Project,evidence:PreparationEvidence):ProjectPreparation {
  const {state,preferences:p}=evidence;const checks:PreparationCheck[]=[];
  const demo=state.runtime.mode==='demo';const target=p.target;
  const push=(id:string,label:string,ok:boolean,detail:string,action:PreparationCheck['action'],extra:Partial<PreparationCheck>={})=>checks.push({id,label,status:ok?'ready':'required',detail,action:ok?'none':action,...extra});
  if(project.relinkRequired)push('relink','원본 폴더 연결',false,'백업을 복원했습니다. 이 장비의 원본 프로젝트 폴더를 연결해 주세요.','project');
  push('project','프로젝트 검수',project.engine!=='unknown'&&!project.findings.some(f=>f.severity==='error'&&!(p.runnerId&&f.code==='ios.requires_macos')),project.findings.filter(f=>f.severity==='error').map(f=>f.message).join(' ')||'프로젝트 형식과 검수 결과를 확인했습니다.','project');
  push('target','배포 대상',project.targets.includes(target),'선택한 프로젝트의 '+target+' 내보내기 설정을 확인합니다.','project');
  const runner=p.runnerId?evidence.runners.find(r=>r.id===p.runnerId&&r.id!=='local'):undefined;
  const host=runner?.platform??state.runtime.platform;
  const currentRunner=runner?.status==='ready'&&Boolean(runner.lastCheckedAt)&&Date.now()-Date.parse(runner.lastCheckedAt!)<24*60*60*1000;
  push('runner','빌드 실행 환경',p.runnerId?currentRunner:evidence.isolation.available,p.runnerId?(runner?.lastError??(runner?'등록한 장비의 최근 연결·격리를 확인합니다.':'선택한 러너가 없습니다.')):(evidence.isolation.reason??'이 컴퓨터의 빌드 격리를 확인했습니다.'),'runner');
  if(target==='ios')push('macos','iOS용 Mac',host==='darwin'||demo,'iOS 빌드·서명에는 Xcode가 설치된 Mac 러너가 필요합니다.','runner');
  const tools=p.runnerId?evidence.runnerTools:state.toolchains;
  for(const name of requiredTools(project,target)){
    const tool=tools?.find(t=>t.name===name);
    push('tool:'+name,toolNames[name]??name,demo||Boolean(tool?.available),demo?'데모 도구가 준비되어 있습니다.':tool?.reason??(tool?.available?'실행 환경에서 확인했습니다.':p.runnerId?'러너 도구 상태를 다시 확인해 주세요.':'필요한 도구를 설치하거나 기존 설치 경로를 연결해 주세요.'),'tool',{toolId:installIds[name]});
  }
  if(project.engineVersion&&['godot','unity'].includes(project.engine)){
    const installed=tools?.find(t=>t.name===project.engine)?.version??'';
    const required=project.engine==='godot'?project.engineVersion.match(/^\d+\.\d+/)?.[0]:project.engineVersion;
    push('engine-version','프로젝트 엔진 버전',demo||Boolean(required&&installed.includes(required)),`프로젝트 ${project.engineVersion} · 설치 ${installed||'확인 필요'}`,'tool',{toolId:project.engine as 'godot'|'unity'});
  }
  if(evidence.planFindings){const errors=evidence.planFindings.filter(f=>f.severity==='error');push('build-plan','빌드 설정',errors.length===0,errors.map(f=>f.message).join(' ')||'내보내기 프리셋·명령·필수 도구 경로를 확인했습니다.','project');}
  push('vault','계정·키 보관함',state.vault.available,state.vault.reason??'등록한 계정과 키를 다시 입력하지 않고 사용합니다.','key');
  if(target==='android'){
    const key=state.buildCredentials?.find(k=>k.id===project.buildSecurity?.androidKeystoreId&&k.kind==='android-keystore');
    push('android-key','Android 서명 키',Boolean(key),key?'이 프로젝트에 연결된 서명 키를 사용합니다.':'키스토어를 등록하고 이 프로젝트의 빌드 보안에 연결해 주세요.','key');
  }
  const provider=storeForTarget(target);
  const mapping=project.storeApps?.[provider as 'google-play'|'app-store'|'steam'];
  const selectedConnection=p.connectionId??mapping?.connectionId;
  const connection=selectedConnection?state.connections.find(c=>c.id===selectedConnection&&c.provider===provider):state.connections.find(c=>c.provider===provider&&project.policy.allowedConnectionIds.includes(c.id)&&c.status==='connected');
  push('connection',provider+' 계정',connection?.status==='connected',connection?.lastError??(connection?'저장한 계정 연결 상태를 확인했습니다.':'프로젝트에서 사용할 '+provider+' 계정을 선택해 주세요.'),'connection',{provider});
  if(connection)push('policy','프로젝트의 연결 권한',project.policy.allowedConnectionIds.includes(connection.id),'선택한 계정을 프로젝트의 허용 연결에 저장합니다.','policy');
  const id=(provider==='steam'?mapping?.appId:project.appIdentifier)??'';
  push('identifier','앱 식별자',demo||(provider==='steam'?/^\d+$/.test(id):/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id)),provider==='steam'?'Steam 프로젝트에는 Steam AppID를 연결해 주세요.':'프로젝트의 패키지·번들 식별자가 필요합니다.','project');
  push('store-app','스토어 앱 확인',demo||Boolean(mapping?.verifiedAt&&mapping.connectionId===connection?.id),'최초 앱·계약·필수 자료를 준비한 뒤 스토어 조회로 이 프로젝트의 앱을 확인합니다.','verify',{provider,url:state.capabilities.find(c=>c.provider===provider)?.setupUrl});
  const build=state.runs.find(r=>r.projectId===project.id&&r.kind==='build'&&r.status==='succeeded'&&r.result?.target===target&&r.input.runnerId===p.runnerId&&Date.parse(r.finishedAt??'')>=Date.parse(project.inspectedAt));
  push('build-verified','대상 빌드 확인',demo||Boolean(build),build?'최근 프로젝트 검수 이후 이 대상의 빌드를 완료했습니다.':'설정한 엔진·대상으로 시험 빌드를 실행해 결과물을 확인해 주세요.','project');
  if(p.sdkRequired)push('sdk','게임 광고·결제 연결',Boolean(evidence.sdk?.installed&&evidence.sdk.verified),evidence.sdk?.detail??'SDK 적용 후 게임의 광고·구매 이벤트 연결과 시험 실행을 확인해 주세요.','sdk');
  const ready=checks.filter(c=>c.status==='ready').length;
  return {projectId:project.id,projectName:project.name,engine:project.engine,target,status:ready===checks.length?'ready':'required',ready,total:checks.length,checks,checkedAt:new Date().toISOString()};
}
