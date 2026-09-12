import { basename, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { Finding, ProjectInspection } from '../../packages/domain/index.js';
import { detectEngine } from './detect.js';
import { parseProject } from './parse.js';

function nowIso(): string {
  return new Date().toISOString();
}

async function normalizeRoot(directory: string): Promise<{ root: string; findings: Finding[] }> {
  const findings: Finding[] = [];
  const requested = resolve(directory);
  try {
    const root = await realpath(requested);
    const st = await stat(root);
    if (!st.isDirectory()) {
      findings.push({
        code: 'inspect.not_directory',
        severity: 'error',
        message: '선택한 경로는 디렉터리가 아닙니다.',
        path: root,
      });
    }
    return { root, findings };
  } catch {
    findings.push({
      code: 'inspect.unreadable',
      severity: 'error',
      message: '프로젝트 경로를 열 수 없습니다. 존재 여부와 읽기 권한을 확인하세요.',
      path: requested,
      fixHint: '접근 가능한 프로젝트 폴더를 선택하세요.',
    });
    return { root: requested, findings };
  }
}

export async function inspectProject(directory: string): Promise<ProjectInspection> {
  const { root, findings: pathFindings } = await normalizeRoot(directory);
  const inspectedAt = nowIso();
  const fallbackName = basename(root) || 'project';

  if (pathFindings.some((f) => f.code === 'inspect.unreadable' || f.code === 'inspect.not_directory')) {
    return {
      rootPath: root,
      name: fallbackName,
      engine: 'unknown',
      engineVersion: null,
      appIdentifier: null,
      targets: [],
      findings: pathFindings,
      inspectedAt,
    };
  }

  const detection = await detectEngine(root);
  const parsed = await parseProject(root, detection, fallbackName);
  return {
    rootPath: root,
    name: parsed.name,
    engine: detection.engine,
    engineVersion: parsed.engineVersion,
    appIdentifier: parsed.appIdentifier,
    targets: parsed.targets,
    findings: [...pathFindings, ...detection.findings, ...parsed.findings],
    inspectedAt,
  };
}

export { parseGodotPresets, targetsFromGodotPlatform } from './parse.js';
