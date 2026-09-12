import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startController } from '../apps/controller/server.js';
import { startRemoteRunner } from '../apps/runner/remote.js';
import { CredentialVault } from '../packages/credentials/index.js';
import type { ApiResult, Project, Run } from '../packages/domain/index.js';

const engine = process.env.APPOPS_GODOT_PATH;
if (!engine || !process.env.APPOPS_GODOT_DATA_DIR) throw new Error('APPOPS_GODOT_PATH와 APPOPS_GODOT_DATA_DIR을 준비해 주세요. docs/build-support.md 참고.');
const directory = await mkdtemp(join(tmpdir(), 'appops-godot-controller-'));
const projectPath = join(directory, 'project'); await mkdir(projectPath);
await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Controller Verify"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.3")\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
await writeFile(join(projectPath, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');
await writeFile(join(projectPath, 'main.gd'), 'extends Node\nfunc _ready():\n\tprint("AppOps controller build OK")\n\tget_tree().quit()\n');
await writeFile(join(projectPath, 'export_presets.cfg'), '[preset.0]\nname="Linux"\nplatform="Linux/X11"\nrunnable=true\nexport_filter="all_resources"\nexport_path="game.x86_64"\n[preset.0.options]\nbinary_format/embed_pck=false\nbinary_format/architecture="x86_64"\ntexture_format/s3tc_bptc=true\n');

let master:Buffer|undefined;
const vault=new CredentialVault(join(directory,'data','credentials'),{keyProvider:{name:'verification-memory',getKey:async()=>master,setKey:async value=>{master=value;}}});
const pairingCode='remote-verification-only-20260911';
const remote=await startRemoteRunner({directory:join(directory,'remote'),port:0,token:pairingCode,engines:{godot:resolve(engine)}});
const controller=await startController({directory:join(directory,'data'),port:0,connectors:[],vault,scanToolchains:async()=>[]});
try {
  const registration=await controller.service.operations.registerRunner({label:'검증용 원격 Linux',platform:'linux',endpoint:'http://127.0.0.1:'+remote.port,pairingToken:pairingCode});
  const ready=await controller.service.operations.checkRunner(registration.id);
  if(ready.status!=='ready')throw new Error(ready.lastError!);
  const project=await controller.service.addProject({path:projectPath});
  const build=controller.service.build(project.id,{target:'linux',exportPreset:'Linux',runnerId:registration.id});
  let run=build;const deadline=Date.now()+180_000;
  while(['queued','running','retry_wait'].includes(run.status)&&Date.now()<deadline){await setTimeout(100);run=controller.service.store.getRun(build.id)!;}
  const summary={directory,mode:'live',transport:'authenticated loopback HTTP remote runner',runId:run.id,status:run.status,result:run.result,error:run.error};
  await writeFile(join(directory,'remote-verification.json'),JSON.stringify(summary,null,2));
  process.stdout.write(JSON.stringify(summary,null,2)+'\n');
  if(run.status!=='succeeded')throw new Error('실제 원격 Godot 빌드 검증 실패');
}finally{await controller.close();await remote.close();}
