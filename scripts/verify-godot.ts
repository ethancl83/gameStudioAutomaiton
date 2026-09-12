import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { startController } from '../apps/controller/server.js';
import type { ApiResult, Project, Run } from '../packages/domain/index.js';

const engine = process.env.APPOPS_GODOT_PATH;
if (!engine || !process.env.APPOPS_GODOT_DATA_DIR) throw new Error('APPOPS_GODOT_PATH와 APPOPS_GODOT_DATA_DIR을 준비해 주세요. docs/build-support.md 참고.');
const directory = await mkdtemp(join(tmpdir(), 'appops-godot-controller-'));
const projectPath = join(directory, 'project'); await mkdir(projectPath);
await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Controller Verify"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.3")\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
await writeFile(join(projectPath, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');
await writeFile(join(projectPath, 'main.gd'), 'extends Node\nfunc _ready():\n\tprint("AppOps controller build OK")\n\tget_tree().quit()\n');
await writeFile(join(projectPath, 'export_presets.cfg'), '[preset.0]\nname="Linux"\nplatform="Linux/X11"\nrunnable=true\nexport_filter="all_resources"\nexport_path="game.x86_64"\n[preset.0.options]\nbinary_format/embed_pck=false\nbinary_format/architecture="x86_64"\ntexture_format/s3tc_bptc=true\n');
const controller = await startController({ directory: join(directory, 'data'), port: 0, connectors: [] });
try {
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${controller.port}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + controller.token, Origin: 'app://appops', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as ApiResult<T>;
    if (!value.ok) throw new Error(value.error.code + ': ' + value.error.message);
    return value.data;
  };
  const project = await api<Project>('/projects', { path: projectPath });
  const started = await api<Run>('/projects/' + project.id + '/build', { target: 'linux', exportPreset: 'Linux', engineExecutable: resolve(engine) });
  let run = started; const deadline = Date.now() + 120_000;
  while (['queued', 'running', 'retry_wait'].includes(run.status) && Date.now() < deadline) {
    await setTimeout(100); run = controller.service.store.getRun(started.id)!;
  }
  const summary = { directory, projectId: project.id, runId: run.id, status: run.status, result: run.result, error: run.error };
  await writeFile(join(directory, 'verification.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (run.status !== 'succeeded') throw new Error('제어 서비스의 실제 Godot 빌드가 완료되지 않았습니다.');
} finally { await controller.close(); }
