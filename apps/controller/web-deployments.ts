import { randomUUID } from 'node:crypto';
import { readFile, mkdir, copyFile, lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import type { WebDeploymentHooks } from './contracts.js';
import type { StudioTerminals } from '../../packages/development/terminal.js';
import type { WebDeployment } from '../../packages/development/types.js';
import { requireTool, command, quote } from '../../packages/development/process.js';
import { git, gitState, checkedPaths, fingerprint } from '../../packages/development/git.js';
import { cleanEnvironment, sandboxLaunch } from '../../packages/development/sandbox.js';
import { AppError, redact } from '../../packages/domain/errors.js';

type Provider = 'netlify' | 'vercel';
export interface WebDeploymentOptions { requireTool?: typeof requireTool; command?: typeof command; fetch?: typeof fetch }
export class WebDeployments {
  private active = new Set<Promise<unknown>>();
  private preparing = new Set<string>();
  private executing = new Set<string>();
  private tokens = new Map<string, string>();
  constructor(private service: WebDeploymentHooks, private terminals: StudioTerminals, private options: WebDeploymentOptions = {}) {}
  private tool(provider: Provider) { return (this.options.requireTool ?? requireTool)(provider); }
  get busy() { return this.active.size > 0 || this.preparing.size > 0; }
  activeForProject(id: string): boolean { return this.preparing.has(id) || this.executing.has(id); }
  list() { return this.service.store.list<WebDeployment>('web-deployment').sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  private save(value: WebDeployment) { this.service.store.putDocument('web-deployment', value.id, value); return value; }
  private project(id: string) {
    const project = this.service.project(id);
    if (project.relinkRequired) throw new AppError('PROJECT_RELINK_REQUIRED', '프로젝트 폴더를 다시 연결하세요.');
    return project;
  }
  async inspect(projectId: string) {
    const project = this.project(projectId);
    let pkg: {scripts?: Record<string,string>; dependencies?: Record<string,string>; devDependencies?: Record<string,string>} = {};
    try { pkg = JSON.parse(await readFile(join(project.rootPath,'package.json'),'utf8')); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const deps = {...pkg.dependencies,...pkg.devDependencies};
    const bindings = await Promise.all(['.netlify/state.json','.vercel/project.json'].map(async file => {
      try { const raw = JSON.parse(await readFile(join(project.rootPath,file),'utf8')); return {file, data: file.startsWith('.netlify') ? {siteId:raw.siteId} : {projectId:raw.projectId,orgId:raw.orgId}}; }
      catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {file,data:null}; throw new AppError('INVALID_BINDING','배포 연결 파일이 올바른 JSON이 아닙니다. 다시 연결하세요.'); }
    }));
    const buildCommand=pkg.scripts?.build?'npm run build':'';
    const publicDirectory=await lstat(join(project.rootPath,'public')).catch(()=>null);
    const output=deps.next?'.next':deps.vite||deps.astro||buildCommand?'dist':publicDirectory?.isDirectory()?'public':'.';
    let publicationError='';
    if(output==='.') {
      const names=await readdir(project.rootPath);
      const ambiguous=names.filter(name=>!name.startsWith('.')&&!/^(?:readme(?:\..*)?|license(?:\..*)?|package(?:-lock)?\.json)$/i.test(name)).some(name=>!['assets','images','fonts','css','js'].includes(name)&&! /\.(?:html?|css|ico|png|jpe?g|gif|svg|webp|avif|txt|xml|webmanifest)$/i.test(name));
      if(ambiguous||!names.includes('index.html')) publicationError='공개할 파일을 public 폴더에 모으세요. 소스·문서가 섞인 프로젝트 루트는 업로드하지 않습니다.';
    }
    return { root:project.rootPath, framework:deps.next?'Next.js':deps.vite?'Vite':deps.astro?'Astro':'정적 사이트', buildCommand, output, publicationError, scripts:pkg.scripts??{}, bindings };
  }
  async link(projectId: string, provider: Provider) {
    return this.terminals.open(`${provider} 프로젝트 연결`, this.project(projectId).rootPath, await this.tool(provider), ['link']);
  }
  async deploy(projectId: string, provider: Provider, production: boolean, expectedHead: string) {
    if (this.activeForProject(projectId)) throw new AppError('DEPLOY_UNRESOLVED', '이전 배포 결과를 먼저 확인하세요.', 409);
    this.preparing.add(projectId);
    try { return await this.prepareDeployment(projectId, provider, production, expectedHead); }
    finally { this.preparing.delete(projectId); }
  }
  private async prepareDeployment(projectId: string, provider: Provider, production: boolean, expectedHead: string) {
    const project = this.project(projectId);
    if (this.service.store.hasUnresolvedDeployment(projectId) || this.service.store.unresolvedEffects({ projectId }).some(run => run.kind === 'web-deployment'))
      throw new AppError('DEPLOY_UNRESOLVED','이전 배포 결과를 먼저 확인하세요. 중복 배포는 자동 재시도하지 않습니다.');
    const info = await this.inspect(projectId);
    const binding = info.bindings.find(b => b.file.startsWith(`.${provider}/`))?.data;
    if (!binding || (provider === 'netlify' ? typeof binding.siteId !== 'string' : typeof binding.projectId !== 'string' || typeof binding.orgId !== 'string'))
      throw new AppError('DEPLOY_LINK_REQUIRED','먼저 배포 프로젝트를 연결하세요.');
    const state = await gitState(project.rootPath);
    if (!state.head || state.files.length) throw new AppError('DEPLOY_COMMIT_REQUIRED','배포할 변경을 먼저 커밋하세요. 연결 설정 파일은 서비스 권장 방식으로 Git에서 제외하세요.');
    if(state.head!==expectedHead)throw new AppError('DEPLOY_CHANGED','승인 화면 이후 커밋이 변경되었습니다. 다시 확인한 뒤 승인하세요.');
    if(provider==='netlify'&&info.publicationError)throw new AppError('PUBLISH_DIRECTORY_REQUIRED',info.publicationError);
    if (provider === 'netlify' && info.framework === 'Next.js') throw new AppError('SERVER_BUILD_REQUIRED','Next.js 서버 빌드는 Vercel 또는 Netlify의 Git 연동 빌드를 사용하세요. 이 화면의 Netlify 업로드는 정적 사이트를 지원합니다.');
    const id = randomUUID(); const directory = join(this.service.store.directory,'web-deployments',id); const source = join(directory,'source');
    await mkdir(source,{recursive:true,mode:0o700});
    const before = await fingerprint(state.root);
    for (const path of (await git(state.root,['ls-files','-z'])).split('\0').filter(Boolean)) {
      if (/(^|\/)(\.env(?:\.|$)|\.git(?:\/|$)|id_rsa$|id_ed25519$|credentials\.json$)/.test(path)) throw new AppError('DEPLOY_SECRET','인증 파일이 Git에 포함되어 있습니다. 제거한 뒤 배포하세요.');
      await checkedPaths(state.root,[path]);
      if (!(await lstat(join(state.root,path))).isFile()) throw new AppError('DEPLOY_FILE','심볼릭 링크·서브모듈은 업로드 전에 일반 파일로 준비하세요.');
      await mkdir(dirname(join(source,path)),{recursive:true}); await copyFile(join(state.root,path),join(source,path));
    }
    if (await fingerprint(state.root) !== before) throw new AppError('DEPLOY_CHANGED','배포 준비 중 소스가 변경되었습니다. 다시 확인하세요.');
    if (provider === 'vercel') { await mkdir(join(source,'.vercel'),{recursive:true}); await writeFile(join(source,'.vercel/project.json'),JSON.stringify(binding)); }
    const record: WebDeployment = {id,projectId,provider,production,sourceSha:state.head,status:'running',terminalId:'',message:'커밋한 소스로 배포를 준비합니다.',createdAt:new Date().toISOString()};
    // Recheck after snapshot I/O. A removed project or newly reserved deployment
    // cannot slip between this synchronous gate and the ledger transaction.
    this.project(projectId);
    this.service.store.transaction(() => {
      const claimed = this.service.store.reserveDeployment(projectId, id);
      this.save(record); this.tokens.set(id, claimed.token);
    });
    this.executing.add(projectId);
    const operation = this.execute(record,directory,source,info,binding).catch(error => {
      const current = this.list().find(d=>d.id===id)!;
      const run = this.service.store.deploymentRun(id);
      this.settle({...current,status:['dispatched','action_required'].includes(this.service.store.effectState(run?.id ?? '') ?? '')?'action_required':'failed',message:redact(error instanceof Error?error.message:String(error))});
    }).finally(()=>{ this.active.delete(operation); this.executing.delete(projectId); this.tokens.delete(id); });
    this.active.add(operation);
    await Promise.race([operation,new Promise(resolve=>setTimeout(resolve,200))]);
    return this.list().find(d=>d.id===id)!;
  }
  private async execute(record: WebDeployment, directory: string, source: string, info: Awaited<ReturnType<WebDeployments['inspect']>>, binding: {siteId?:string}) {
    const file = await this.tool(record.provider);
    let cwd = source; let args: string[];
    if (record.provider === 'netlify') {
      if (info.buildCommand) {
        const lock = await lstat(join(source,'package-lock.json')).catch(()=>null);
        if (!lock) throw new AppError('LOCKFILE_REQUIRED','Netlify 정적 빌드는 package-lock.json을 사용합니다. 다른 패키지 관리자는 Git 연동 빌드를 사용하세요.');
        const launch = await sandboxLaunch({directory:join(directory,'build-control'),worktree:source,executable:'/bin/sh',args:['-c',`npm ci --no-audit --no-fund && ${info.buildCommand}`],extraDomains:['registry.npmjs.org','registry.yarnpkg.com']});
        launch.env.npm_config_cache=join(launch.env.TMPDIR!,'npm-cache');
        try {
          const session=await this.terminals.open('Netlify 정적 빌드',source,launch.file,launch.args,launch.env);
          this.save({...record,terminalId:session.id,message:'인증 정보가 없는 격리 환경에서 빌드 중입니다.'});
          if (await this.terminals.wait(session.id) !== 0) throw new AppError('WEB_BUILD_FAILED','웹 빌드가 실패했습니다. 빌드 터미널을 확인하세요.');
        } finally { await launch.cleanup(); }
      }
      const output=await realpath(join(source,info.output)); const rel=relative(await realpath(source),output);
      if(rel.startsWith('..')||isAbsolute(rel))throw new AppError('OUTPUT_PATH','빌드 결과가 프로젝트 밖에 있습니다.');
      const upload=join(directory,'upload'); await mkdir(upload);
      await this.copyStatic(output,upload,info.output==='.');
      if(!(await readdir(upload)).length)throw new AppError('EMPTY_OUTPUT','업로드할 웹 파일이 없습니다.');
      cwd=join(directory,'publish'); await mkdir(cwd); await writeFile(join(cwd,'netlify.toml'),'[build]\n');
      args=['deploy','--no-build','--dir',upload,'--site',binding.siteId!,'--json',...(record.production?['--prod']:[])];
    } else args=['deploy','--yes',...(record.production?['--prod']:[])];
    const resultFile=join(directory,'result.txt');
    // Provider progress remains on stderr; stdout is captured byte-for-byte for reconciliation.
    const line=`${[file,...args].map(quote).join(' ')} > ${quote(resultFile)}; code=$?; cat ${quote(resultFile)}; exit "$code"`;
    this.service.store.transaction(() => {
      const run = this.service.store.deploymentRun(record.id)!;
      this.service.store.markDispatched(run.id, this.tokens.get(record.id)!);
      this.save({...record,dispatched:true,message:'배포 서비스에 전송을 시작합니다.'});
    });
    const session=await this.terminals.open(`${record.provider} ${record.production?'Production':'Preview'} 배포`,cwd,'/bin/sh',['-c',line],cleanEnvironment());
    this.save({...record,terminalId:session.id,dispatched:true,message:'배포 서비스에서 처리 중입니다.'});
    const code=await this.terminals.wait(session.id);
    if(code!==0)throw new AppError('DEPLOY_UNCERTAIN',`CLI가 종료되었습니다 (${code}). 서비스에서 결과를 확인하세요.`);
    await this.check(record.id);
  }
  private async copyStatic(source:string,destination:string,root=false) {
    for(const name of await readdir(source)) {
      if(name.startsWith('.')||['node_modules','dev','package.json','package-lock.json'].includes(name))continue;
      if(root&&/^(?:readme(?:\..*)?|license(?:\..*)?)$/i.test(name))continue;
      const path=join(source,name);const st=await lstat(path);
      if(st.isSymbolicLink())throw new AppError('OUTPUT_SYMLINK','빌드 결과에 심볼릭 링크가 있습니다.');
      if(st.isDirectory()){await mkdir(join(destination,name));await this.copyStatic(path,join(destination,name));}
      else if(st.isFile())await copyFile(path,join(destination,name));
    }
  }
  async check(id:string) {
    const record=this.list().find(d=>d.id===id);if(!record)throw new AppError('NOT_FOUND','배포를 찾을 수 없습니다.',404);
    const file=await this.tool(record.provider);let url=record.url;let deploymentId=record.deploymentId;
    if(!url){
      const result=await readFile(join(this.service.store.directory,'web-deployments',id,'result.txt'),'utf8');
      if(record.provider==='netlify') {const data=JSON.parse(result);url=data.deploy_url??data.url;deploymentId=data.deploy_id;}
      else url=result.trim().split(/\s+/).find(value=>/^https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\/?$/.test(value));
    }
    if(!url || !/^https:\/\/[a-zA-Z0-9.-]+\.(?:netlify|vercel)\.app\/?$/.test(url))throw new AppError('DEPLOY_UNCONFIRMED','배포 URL을 확인하지 못했습니다. 서비스 이력을 확인하세요.');
    const data=JSON.parse(record.provider==='netlify' ? await (this.options.command ?? command)(file,['api','getDeploy','--data',JSON.stringify({deploy_id:deploymentId})]) : await (this.options.command ?? command)(file,['api',`/v13/deployments/${new URL(url).hostname}`]));
    const ready=record.provider==='netlify'?data.state==='ready':data.readyState==='READY';
    const http=ready?await (this.options.fetch ?? fetch)(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000)}):null;await http?.body?.cancel();
    // Query results may arrive after an operator resolved the uncertainty.
    // Never overwrite that durable decision with the snapshot read before I/O.
    const current = this.service.store.get<WebDeployment>('web-deployment', id);
    if (!current) throw new AppError('NOT_FOUND','배포를 찾을 수 없습니다.',404);
    if (current.resolved) return current;
    return this.settle({...current,url,deploymentId:deploymentId??data.id,status:ready&&http?.ok?'succeeded':'action_required',message:ready&&http?.ok?'공급자 완료 상태와 사이트 응답을 확인했습니다.':ready?'배포는 완료됐지만 접근 보호·리디렉션 등으로 페이지 확인이 필요합니다.':`서비스 처리 상태: ${data.state??data.readyState??'확인 필요'}`});
  }
  resolve(id:string){const record=this.list().find(d=>d.id===id);if(!record)throw new AppError('NOT_FOUND','배포를 찾을 수 없습니다.',404);if(record.status==='running'||this.executing.has(record.projectId))throw new AppError('BUSY','진행 중인 배포입니다.');return this.settle({...record,resolved:true,message:record.message+' 사용자가 서비스에서 확인하고 재배포 잠금을 해제했습니다.'});}
  private settle(record: WebDeployment): WebDeployment {
    return this.service.store.transaction(() => {
      const run = this.service.store.deploymentRun(record.id);
      if (run) {
        const status = record.status === 'succeeded' ? 'succeeded' : record.resolved || record.status === 'failed' ? 'failed' : 'action_required';
        const result = { deploymentId: record.id, url: record.url ?? null, operatorConfirmed: record.resolved === true };
        if (run.status === 'running') this.service.store.finish(run.id, this.tokens.get(record.id)!, status, result, null, record.resolved === true);
        else if (['action_required','waiting_external'].includes(run.status)) this.service.store.reconcile(run.id, run.updatedAt, status, result);
      }
      return this.save(record);
    });
  }
  recover(){for(const d of this.list())if(d.status==='running')this.settle({...d,status:'action_required',message:'이전 실행이 중단되었습니다. 결과 확인으로 서비스 상태를 조회하세요.'});}
  async close(){await Promise.allSettled([...this.active]);}
}
