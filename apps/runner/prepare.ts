import { lstat, mkdir, symlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { BuildPlan, CommandSpec } from '../../packages/domain/index.js';

function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

async function linkOnce(linkPath: string, target: string): Promise<void> {
  try {
    await lstat(linkPath);
    return; // already prepared for this run
  } catch {
    await symlink(target, linkPath);
  }
}

/**
 * Seeds per-run writable tool caches before a sandboxed command starts.
 * All writable cache paths must live inside the per-run output directory
 * (cleared on every attempt); read-only sources are the validated APPOPS_*
 * tool directories referenced by the plan's environment. No project code
 * runs here — only directory creation and symlinks into trusted images.
 *
 * Returns an actionable error string instead of touching anything outside
 * the output root.
 */
export async function prepareTaskCaches(command: CommandSpec, plan: BuildPlan): Promise<string | null> {
  const env = command.env ?? {};
  const outputRoot = resolve(plan.outputPath);

  const gradleHome = env.GRADLE_USER_HOME;
  if (gradleHome) {
    const resolved = resolve(gradleHome);
    if (!isInside(outputRoot, resolved) || resolved === outputRoot) {
      return `GRADLE_USER_HOME 은 실행별 출력 디렉터리 안의 하위 경로여야 합니다: ${gradleHome}`;
    }
    await mkdir(resolved, { recursive: true });
    const toolsRoot = env.GRADLE_TOOLS_ROOT;
    if (toolsRoot) {
      // The wrapper distribution is served read-only from the tool image; the
      // rest of the per-run Gradle home stays writable and empty.
      await linkOnce(join(resolved, 'wrapper'), join(resolve(toolsRoot), 'wrapper'));
    }
  }

  const xdgData = env.XDG_DATA_HOME;
  const godotTemplates = env.GODOT_TEMPLATES_SOURCE;
  if (xdgData && godotTemplates) {
    const resolved = resolve(xdgData);
    if (!isInside(outputRoot, resolved) || resolved === outputRoot) {
      return `XDG_DATA_HOME 은 실행별 출력 디렉터리 안의 하위 경로여야 합니다: ${xdgData}`;
    }
    const godotDir = join(resolved, 'godot');
    await mkdir(godotDir, { recursive: true });
    await linkOnce(join(godotDir, 'export_templates'), join(resolve(godotTemplates), 'export_templates'));
  }

  return null;
}
