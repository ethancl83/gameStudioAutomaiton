import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { AppError } from "../domain/errors.js";
import { command, requireTool } from "./process.js";
import type { GitState, GitFile } from "./types.js";
export async function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array; signal?: AbortSignal } = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return command(
    await requireTool("git"),
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...options.env },
      input: options.input,
      signal: options.signal,
      timeout: 120000,
    },
  );
}
export function githubRepository(remote: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote.trim(),
    );
  return match?.[1] ?? null;
}
export function repository(value: string): string {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
    value.split("/").some((v) => v === "." || v === "..")
  )
    throw new AppError(
      "INVALID_REPOSITORY",
      "GitHub 저장소 형식을 확인해 주세요.",
    );
  return value;
}
export function credentialPath(path: string): boolean {
  return /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|\.pypirc$|id_(?:rsa|ed25519|ecdsa)$|credentials\.json$|[^/]+\.(?:pem|key|p12|pfx)$)/i.test(path);
}
export function gitFiles(output: string): GitFile[] {
  const entries = output.split("\0");
  const files: GitFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]!;
    if (!line) continue;
    files.push({ index: line[0]!, working: line[1]!, path: line.slice(3) });
    if (/[RC]/.test(line.slice(0, 2))) i++;
  }
  return files;
}
export async function gitState(cwd: string): Promise<GitState> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(error => {
    if (/not a git repository|outside repository/i.test(String(error)))
      throw new AppError('NOT_GIT_REPOSITORY', '이 폴더는 아직 Git 저장소가 아닙니다.');
    throw error;
  })).trim();
  const [branch, head, remote, files, branches, log] = await Promise.all([
    git(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => "HEAD"),
    git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
    git(root, ["remote", "get-url", "origin"]).catch(() => ""),
    git(root, ["status", "--porcelain=v1", "-z"]),
    git(root, ["branch", "--format=%(refname:short)"]),
    git(root, ["log", "-15", "--format=%h %s"]).catch(() => ""),
  ]);
  return {
    root,
    branch: branch.trim(),
    head: head.trim(),
    remote: remote.trim() || null,
    repository: githubRepository(remote),
    files: gitFiles(files),
    branches: branches.trim().split("\n").filter(Boolean),
    log,
  };
}
interface SnapshotEntry { path: string; mode: string; hash: string; size: number }
interface Baseline { head: string; entries: SnapshotEntry[] }
async function snapshot(cwd: string) {
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  const paths = [...new Set((await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort();
  const entries: SnapshotEntry[] = [];
  const hash = createHash('sha256').update(head);
  for (const path of paths) {
    const full = join(cwd, path);
    let st; try { st = await lstat(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!st.isFile() && !st.isSymbolicLink())
      throw new AppError('UNSUPPORTED_FILE', '서브모듈과 특수 파일은 자동 작업에서 지원하지 않습니다.');
    await checkedPaths(cwd, [path]);
    const digest = createHash('sha256');
    if (st.isSymbolicLink()) digest.update(await readlink(full));
    else for await (const chunk of createReadStream(full)) digest.update(chunk);
    const mode = st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644';
    const entry = { path, mode, hash: digest.digest('hex'), size: st.size };
    hash.update(JSON.stringify([entry.path, entry.mode, entry.hash]));
    entries.push(entry);
  }
  return { head, entries, fingerprint: hash.digest('hex') };
}
export async function fingerprint(cwd: string): Promise<string> { return (await snapshot(cwd)).fingerprint; }

export async function recordBaseline(cwd: string, control: string, base: string) {
  const state = await snapshot(cwd);
  if (state.head !== base) throw new AppError('BASE_CHANGED', '기준 커밋이 변경되었습니다.');
  await writeFile(join(control, 'baseline.json'), JSON.stringify({ head: base, entries: state.entries }), { flag: 'wx', mode: 0o600 });
}

async function baseline(control: string, base: string): Promise<Baseline> {
  let value: Baseline;
  try { value = JSON.parse(await readFile(join(control, 'baseline.json'), 'utf8')) as Baseline; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('BASELINE_REQUIRED', '작업 기준선이 없습니다. 이슈 또는 PR을 다시 가져오세요.'); throw error; }
  if (value.head !== base || !Array.isArray(value.entries)) throw new AppError('BASELINE_CHANGED', '작업 기준선이 변경되었습니다.');
  return value;
}

async function treeFromEntries(cwd: string, control: string, base: string, entries: SnapshotEntry[]) {
  const original = new Map((await baseline(control, base)).entries.map(entry => [entry.path, entry]));
  const scratch = await mkdtemp(join(control, 'index-'));
  const options = { env: { GIT_INDEX_FILE: join(scratch, 'index') } };
  try {
    await git(cwd, ['read-tree', base], options);
    let index = '';
    for (const entry of entries) {
      const prior = original.get(entry.path);
      original.delete(entry.path);
      if (prior?.hash === entry.hash && prior.mode === entry.mode) continue;
      if (entry.size > 20 * 1024 * 1024) throw new AppError('UNSUPPORTED_FILE', '변경한 파일이 20MB를 넘습니다. 큰 에셋은 수동 Git 작업으로 반영하세요.');
      const contents = entry.mode === '120000' ? Buffer.from(await readlink(join(cwd, entry.path))) : await readFile(join(cwd, entry.path));
      if (createHash('sha256').update(contents).digest('hex') !== entry.hash) throw new AppError('VERIFY_REQUIRED', '커밋 준비 중 파일이 변경되었습니다.');
      const oid = (await git(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], { input: contents })).trim();
      index += `${entry.mode} ${oid}\t${entry.path}\0`;
    }
    if (index) await git(cwd, ['update-index', '-z', '--index-info'], { ...options, input: index });
    if (original.size) await git(cwd, ['update-index', '--force-remove', '--', ...original.keys()], options);
    return (await git(cwd, ['write-tree'], options)).trim();
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Diff verified working bytes as Git objects so worktree clean filters never execute. */
export async function safeDiff(cwd: string, control: string, base: string) {
  const state = await snapshot(cwd);
  const tree = await treeFromEntries(cwd, control, base, state.entries);
  if (await fingerprint(cwd) !== state.fingerprint) throw new AppError('VERIFY_REQUIRED', 'diff 준비 중 파일이 변경되었습니다.');
  return git(cwd, ['diff', '--no-ext-diff', '--no-textconv', base, tree]);
}

/** Build exactly the verified bytes without executing git filters, hooks or project code. */
export async function verifiedCommit(cwd: string, control: string, expected: string, base: string, branch: string, message: string, automatic = false, signal?: AbortSignal) {
  const state = await snapshot(cwd);
  if (state.fingerprint !== expected || state.head !== base) throw new AppError('VERIFY_REQUIRED', '검증 이후 파일이나 기준 커밋이 변경되었습니다.');
  const currentBranch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).trim();
  const branchHead = (await git(cwd, ['rev-parse', `refs/heads/${branch}`])).trim();
  if (currentBranch !== branch || branchHead !== base)
    throw new AppError('VERIFY_REQUIRED', '작업 브랜치 또는 기준 커밋이 변경되었습니다.');
    const tree = await treeFromEntries(cwd, control, base, state.entries);
    const changed = (await git(cwd, ['diff-tree', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--name-only', '-r', '-z', base, tree])).split('\0').filter(Boolean);
    if (!changed.length) throw new AppError('NO_CHANGES', '커밋할 변경사항이 없습니다.');
    if (changed.some(path => path === '.gitattributes' || path.endsWith('/.gitattributes')))
      throw new AppError('ATTRIBUTE_CHANGE', 'Git 속성 변경은 안전하게 자동 반영할 수 없습니다. 별도 Git 작업으로 처리하세요.');
    const autocrlf = (await git(cwd, ['config', '--get', 'core.autocrlf']).catch(() => '')).trim();
    if (['true', 'input'].includes(autocrlf)) throw new AppError('ATTRIBUTE_CHANGE', 'core.autocrlf가 활성화된 저장소의 변경은 별도 Git 작업으로 처리하세요.');
    for (const path of changed) {
      const attrs = (await git(cwd, ['check-attr', '-z', '--all', '--', path])).split('\0');
      for (let i = 0; i + 2 < attrs.length; i += 3)
        if (['filter', 'eol', 'working-tree-encoding'].includes(attrs[i + 1]!) && !['unspecified', 'unset'].includes(attrs[i + 2]!))
          throw new AppError('ATTRIBUTE_CHANGE', `변환 속성이 있는 파일은 별도 Git 작업으로 처리하세요: ${path}`);
    }
    if (automatic && changed.some(path =>
      /(^|\/)(?:package\.json|[^/]*lock[^/]*|[^/]*\.(?:test|spec)\.[^/]*|(?:test|tests|spec|scripts)(?:\/|$)|[^/]*(?:jest|vitest|playwright|eslint|tsconfig)[^/]*)/.test(path) ||
      /(^|\/)(?:Makefile|GNUmakefile|pyproject\.toml|conftest\.py|pytest\.ini|tox\.ini|requirements[^/]*\.txt|Cargo\.toml|go\.mod|build\.gradle(?:\.kts)?|pom\.xml)$/.test(path)
    ))
      throw new AppError('MANUAL_APPROVAL_REQUIRED', '검증 설정·테스트 변경이 포함되어 자동 반영을 멈췄습니다. diff를 검토하고 승인·커밋하세요.');
    for (const path of changed) {
      if (credentialPath(path) || /^\.github\/workflows\//.test(path))
        throw new AppError('SENSITIVE_CHANGE', '인증 파일 또는 GitHub Actions 변경은 자동 작업에서 반영하지 않습니다.');
      const entry = state.entries.find(value => value.path === path);
      if (entry?.mode === '120000')
        throw new AppError('SENSITIVE_CHANGE', '변경된 심볼릭 링크 또는 인증 정보가 감지되었습니다.');
      if (entry) {
        const contents = await readFile(join(cwd, path));
        if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}/.test(contents.toString()))
          throw new AppError('SENSITIVE_CHANGE', '변경된 인증 정보가 감지되었습니다.');
      }
    }
    if (await fingerprint(cwd) !== expected) throw new AppError('VERIFY_REQUIRED', '커밋 준비 중 파일이 변경되었습니다.');
    if (signal?.aborted) throw new AppError('CANCELLED', '커밋 전에 작업이 중지되었습니다.');
    const sha = (await git(cwd, ['commit-tree', tree, '-p', base, '-m', message])).trim();
    if (await fingerprint(cwd) !== expected) throw new AppError('VERIFY_REQUIRED', '커밋 준비 중 파일이 변경되었습니다.');
    if (signal?.aborted) throw new AppError('CANCELLED', '커밋 전에 작업이 중지되었습니다.');
    await git(cwd, ['update-ref', `refs/heads/${branch}`, sha, base]);
    await git(cwd, ['read-tree', tree]);
    return sha;
}
export async function checkedPaths(
  cwd: string,
  paths: string[],
): Promise<string[]> {
  if (!paths.length || paths.length > 1000)
    throw new AppError("INVALID_FILES", "변경 파일을 선택하세요.");
  cwd = await realpath(cwd);
  for (const path of paths) {
    if (
      !path ||
      isAbsolute(path) ||
      path.split(/[\\/]/).includes("..") ||
      path.startsWith("-") ||
      path.includes("\0") ||
      path.split(/[\\/]/).includes(".git")
    )
      throw new AppError("INVALID_PATH", "저장소 내부 파일을 선택하세요.");
    const full = join(cwd, path);
    try {
      const actual = await realpath(full);
      const r = relative(cwd, actual);
      if (r.startsWith("..") || isAbsolute(r))
        throw new AppError("INVALID_PATH", "저장소 밖 파일입니다.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return paths;
}
