// 보안 경계의 순수 로직. Electron 의존성이 없어 main.ts와 테스트가 함께 사용한다.
// - renderer가 요청할 수 있는 API 경로/메서드를 화이트리스트로 제한한다.
// - 요청 네임스페이스(/demo 대 실제)를 main 소유의 실행 모드에 결속한다(renderer 문자열은 권한을 못 바꾼다).
// - openExternal 대상 URL을 허용된 HTTPS 호스트로 제한한다.
// - 로그/오류에 자격 증명이 새지 않도록 문자열을 정리한다.
// - 전체 백업 원본 스트림의 무결성/원자성 검증(다운로드·가져오기)을 순수 파일 연산으로 제공한다.
//   (node: 표준 모듈만 사용 — Electron 의존성 없음. main과 테스트가 동일 코드를 실행한다.)

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface RouteRule {
  method: HttpMethod;
  // 경로 세그먼트 패턴. ':id'는 URL-safe 세그먼트 하나에 대응한다.
  pattern: string;
}

// 구현 계약(docs/implementation-contract.md)의 UI·제어 서비스 계약 표와 1:1로 대응한다.
// 클라이언트는 '/api' 접두사 없는 논리 경로를 사용하고 transport가 접두사를 붙인다.
const ROUTES: RouteRule[] = [
  { method: 'GET', pattern: '/health' },
  { method: 'GET', pattern: '/state' },
  { method: 'POST', pattern: '/media' },
  { method: 'POST', pattern: '/projects/:id/artifacts' },
  { method: 'POST', pattern: '/history/query' },
  { method: 'POST', pattern: '/projects' },
  { method: 'DELETE', pattern: '/projects/:id' },
  { method: 'POST', pattern: '/projects/:id/inspect' },
  { method: 'POST', pattern: '/projects/:id/relink' },
  { method: 'PUT', pattern: '/projects/:id/policy' },
  // 프로젝트 빌드 보안: Android 서명 키 선택 + SSH 의존성 목록 저장.
  { method: 'PUT', pattern: '/projects/:id/build-security' },
  { method: 'POST', pattern: '/projects/:id/build' },
  { method: 'POST', pattern: '/projects/:id/publish' },
  { method: 'POST', pattern: '/pipelines/:id/cancel' },
  { method: 'GET', pattern: '/operations' },
  { method: 'GET', pattern: '/setup' },
  { method: 'GET', pattern: '/projects/:id/integration' },
  { method: 'POST', pattern: '/projects/:id/integration/preview' },
  { method: 'POST', pattern: '/projects/:id/integration/apply' },
  { method: 'POST', pattern: '/projects/:id/integration/rollback' },
  { method: 'PUT', pattern: '/projects/:id/store-app' },
  { method: 'POST', pattern: '/projects/:id/store-app/check' },
  { method: 'PUT', pattern: '/setup/tools' },
  { method: 'POST', pattern: '/setup/rescan' },
  { method: 'POST', pattern: '/setup/install' },
  { method: 'POST', pattern: '/setup/install/:id/cancel' },
  { method: 'PUT', pattern: '/projects/:id/preparation' },
  { method: 'PUT', pattern: '/operations/settings' },
  { method: 'POST', pattern: '/operations/backup' },
  { method: 'POST', pattern: '/operations/restore' },
  { method: 'POST', pattern: '/operations/diagnostics' },
  // 전체(포터블) 암호화 백업의 JSON 제어 경로. 대용량 원본 스트림(import/download)은 이 화이트리스트를
  // 거치지 않고 main의 전용 스트리밍 브리지로만 처리한다(renderer가 파일 바이트·경로·토큰을 만지지 않음).
  { method: 'GET', pattern: '/operations/portable-backups' },
  { method: 'POST', pattern: '/operations/portable-backups' },
  { method: 'POST', pattern: '/operations/portable-backups/:id/prepare-restore' },
  { method: 'POST', pattern: '/operations/portable-backups/commit-restore' },
  { method: 'POST', pattern: '/operations/runners' },
  { method: 'DELETE', pattern: '/operations/runners/:id' },
  { method: 'POST', pattern: '/operations/runners/:id/check' },
  { method: 'POST', pattern: '/runs/:id/cancel' },
  { method: 'POST', pattern: '/runs/:id/retry' },
  // 외부 쓰기 결과의 읽기 전용 재조정(상태 재확인). 재전송이 아니다.
  { method: 'POST', pattern: '/runs/:id/reconcile' },
  { method: 'POST', pattern: '/runs/:id/resolve' },
  { method: 'POST', pattern: '/connections' },
  { method: 'POST', pattern: '/connections/:id/check' },
  { method: 'DELETE', pattern: '/connections/:id' },
  { method: 'POST', pattern: '/connections/:id/actions' },
  // 자격 증명 병합 수정(취소된 키 복구). 저장된 기존 값은 서버가 노출하지 않는다.
  { method: 'PUT', pattern: '/connections/:id/credentials' },
  // Google OAuth 온보딩: 신규 연결 시작, 기존 연결 재인증 시작.
  { method: 'POST', pattern: '/oauth/google/start' },
  { method: 'POST', pattern: '/connections/:id/oauth/start' },
  // 빌드 서명·SSH 자격 증명 등록/회전/삭제. 비밀은 로컬 API로만 전송되고 응답에는 메타데이터만 온다.
  { method: 'POST', pattern: '/build-credentials' },
  { method: 'PUT', pattern: '/build-credentials/:id' },
  { method: 'DELETE', pattern: '/build-credentials/:id' },
  // 커뮤니티(SNS) 자동화 정책 및 예약 게시. 예약 취소는 대기 중인 항목만 서버가 취소한다.
  { method: 'PUT', pattern: '/projects/:id/social-policy' },
  { method: 'POST', pattern: '/social/schedules' },
  { method: 'DELETE', pattern: '/social/schedules/:id' },
  // 소셜(X/Threads) 브라우저 OAuth 시작: 신규 연결·기존 연결 재인증. 공급자는 x/threads로 제한한다.
  { method: 'POST', pattern: '/oauth/social/x/start' },
  { method: 'POST', pattern: '/oauth/social/threads/start' },
  { method: 'POST', pattern: '/connections/:id/oauth/social/start' },
];

// URL-safe 세그먼트: 경로 이탈(.. / 인코딩 우회)과 슬래시 주입을 막는다.
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

function segmentMatches(patternSeg: string, actualSeg: string): boolean {
  if (patternSeg === ':id') {
    return SEGMENT.test(actualSeg) && actualSeg !== '.' && actualSeg !== '..';
  }
  return patternSeg === actualSeg;
}

/**
 * renderer가 보낸 (method, path)가 허용된 API 작업인지 검사한다.
 * path는 쿼리스트링 없이 '/'로 시작하는 논리 경로여야 한다.
 */
export function isAllowedApiPath(method: string, path: string): boolean {
  if (typeof method !== 'string' || typeof path !== 'string') return false;
  const upper = method.toUpperCase();
  if (upper !== 'GET' && upper !== 'POST' && upper !== 'PUT' && upper !== 'DELETE') return false;
  // 쿼리/프래그먼트/절대 URL은 허용하지 않는다.
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('\\')) {
    return false;
  }
  if (path.includes('//') || path.includes('..')) return false;

  if (path.startsWith('/demo/')) {
    const logical = path.slice('/demo'.length);
    if (upper === 'POST' && (logical === '/reset' || logical === '/scenario')) return true;
    if (logical.startsWith('/demo/')) return false;
    return isAllowedApiPath(upper, logical);
  }

  const actual = path.split('/').filter((s) => s.length > 0);
  for (const rule of ROUTES) {
    if (rule.method !== upper) continue;
    const pat = rule.pattern.split('/').filter((s) => s.length > 0);
    if (pat.length !== actual.length) continue;
    let ok = true;
    for (let i = 0; i < pat.length; i += 1) {
      if (!segmentMatches(pat[i], actual[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// openExternal 허용 호스트. 공급자 콘솔/공식 문서의 설정 링크만 시스템 브라우저로 연다.
// capability.setupUrl 도메인을 기준으로 하되, 하위 도메인까지 정확 일치/접미사 일치로 검사한다.
const ALLOWED_EXTERNAL_HOSTS: readonly string[] = [
  // Google OAuth 동의 화면(시스템 브라우저에서 최초 1회 로그인).
  'accounts.google.com',
  'play.google.com',
  'developer.android.com',
  'support.google.com',
  'console.cloud.google.com',
  'developers.google.com',
  'appstoreconnect.apple.com',
  'developer.apple.com',
  'partner.steamgames.com',
  'steamcommunity.com',
  'store.steampowered.com',
  'ads.google.com',
  'dash.applovin.com',
  'support.applovin.com',
  'apps.admob.com',
  'admob.google.com',
  // 소셜 OAuth 동의 화면(시스템 브라우저에서 최초 1회 로그인).
  'x.com',
  'threads.com',
  'threads.net',
];

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_EXTERNAL_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

// 개발 서버 URL로 로드/신뢰할 수 있는 loopback 주소인지 검사한다.
// Electron 창은 컴파일된 파일(file:)과 loopback 개발 서버만 로드하고,
// 외부 주소를 앱 화면으로 로드하지 않는다.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackDevUrl(rawUrl: string | null | undefined): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * 시스템 브라우저로 열 수 있는 외부 URL인지 검사한다.
 * HTTPS만 허용하고, 자격 증명 포함 URL(user:pass@)과 허용되지 않은 호스트를 거부한다.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (!url.hostname) return false;
  return hostAllowed(url.hostname);
}

// 알려진 자격 증명 필드 키를 로그/오류에서 마스킹한다. 전체 백업 암호(passphrase)도 포함한다.
const SECRET_HINTS = /(token|secret|password|passwd|passphrase|key|credential|bearer|authorization|apikey|api_key|private)/i;

/**
 * 객체를 로그에 남기기 전에 자격 증명으로 보이는 값을 마스킹한다.
 * main 프로세스가 요청 로그를 남길 때 사용한다.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[깊이초과]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_HINTS.test(k)) {
        out[k] = '[제거됨]';
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// 전체(포터블) 암호화 백업 브리지의 순수 검증/경로 로직.
// main이 네이티브 dialog·스트리밍을 orchestrate할 때 사용하고, 테스트가 직접 검증한다.
// (Electron 의존성 없음 — renderer는 이 모듈을 import하지 않는다.)
// ---------------------------------------------------------------------------

// 암호화 백업 파일 매직(packages/backup/archive.ts의 MAGIC과 동일). 파일의 첫 8바이트.
export const BACKUP_MAGIC = Buffer.from('APPOPSB1', 'latin1');

// 전체 백업 원본 스트림의 절대 상한. packages/backup/archive.ts의 BACKUP_LIMITS.total과 일치(512 GiB).
export const MAX_PORTABLE_BACKUP_BYTES = 512 * 1024 ** 3;

// 전체 백업 실행 모드. localStorage에서 preload가 읽어 main으로 전달한다.
export type PortableBackupMode = 'demo' | 'live';

// 'live'만 실제 저장공간, 그 외(데모·미상)는 데모 저장공간으로 안전 기본값 처리한다.
export function normalizePortableMode(mode: unknown): PortableBackupMode {
  return mode === 'live' ? 'live' : 'demo';
}

// 다운로드 GET/prepare 등에 쓰는 백업 식별자를 엄격한 UUID로 제한한다. URL 경로 세그먼트로 들어가므로
// 경로 주입·이탈을 막는다(8-4-4-4-12 16진).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isPortableBackupId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

// 파일 앞부분(최소 8바이트)이 암호화 백업 매직으로 시작하는지 확인한다.
export function hasBackupMagic(head: Uint8Array): boolean {
  if (head.length < BACKUP_MAGIC.length) return false;
  for (let i = 0; i < BACKUP_MAGIC.length; i += 1) {
    if (head[i] !== BACKUP_MAGIC[i]) return false;
  }
  return true;
}

// 바이트 수가 유효한 전체 백업 크기인지(0 초과, 상한 이하) 확인한다.
export function isWithinPortableBackupSize(size: number): boolean {
  return Number.isFinite(size) && size > 0 && size <= MAX_PORTABLE_BACKUP_BYTES;
}

// apiBase(…/api) 뒤에 붙일 논리 경로. 데모는 /demo 접두를 붙여 격리 저장공간으로 라우팅한다.
function modeSegment(mode: PortableBackupMode): string {
  return mode === 'demo' ? '/demo' : '';
}
export function portableBackupDownloadPath(mode: PortableBackupMode, id: string): string {
  return `${modeSegment(mode)}/operations/portable-backups/${id}/download`;
}
export function portableBackupImportPath(mode: PortableBackupMode): string {
  return `${modeSegment(mode)}/operations/portable-backups/import`;
}

// ---------------------------------------------------------------------------
// main 소유 실행 모드에 결속된 요청 네임스페이스 판정.
// 실행 모드(demo/live)는 main이 소유·영속하며 renderer 문자열로 바뀌지 않는다. 여기서는 renderer가
// 보낸 논리 경로의 네임스페이스가 그 실행 모드와 일치하는지만 판정한다: 데모 모드는 반드시 `/demo/…`,
// 실제 모드는 반드시 비-데모 경로여야 한다. 손상된 renderer가 데모 세션에서 실제 경로를(또는 그 반대)
// 밀어 넣어도 main이 여기서 거부한다(fail-closed). 실제 권한 변경은 setMode 확인을 통해서만 이뤄진다.
export function requestNamespaceMatches(mode: PortableBackupMode, path: string): boolean {
  if (typeof path !== 'string') return false;
  const isDemoPath = path === '/demo' || path.startsWith('/demo/');
  return mode === 'demo' ? isDemoPath : !isDemoPath;
}

// 로컬 데스크톱 실행 모드 선호를 저장하는 파일 형태. renderer localStorage 밖(사용자 데이터 디렉터리)에
// 0600으로 보관한다. 'live'만 실제, 그 외/누락/손상은 데모(안전 기본값)로 정규화한다.
export function normalizeStoredMode(raw: unknown): PortableBackupMode {
  if (raw && typeof raw === 'object' && 'mode' in raw) {
    return normalizePortableMode((raw as { mode?: unknown }).mode);
  }
  return normalizePortableMode(raw);
}

// ---------------------------------------------------------------------------
// 신뢰할 수 있는 IPC 발신 프레임 URL 판정.
// 프로덕션: 패키지된 진입 파일의 정확한 file: URL만 신뢰한다(임의의 file://이 아니라 정확 일치).
// 개발: 주입된 loopback dev 서버(프로토콜·호스트 일치)만 신뢰한다. (프레임 최상위 여부와 webContents
//  신원은 Electron 런타임이 있는 main.ts에서 추가로 확인한다 — 이 함수는 URL 계약만 담당한다.)
export function isTrustedFrameUrl(
  rawUrl: string,
  opts: { devServerUrl: string | null; entryUrl: string | null },
): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (opts.devServerUrl) {
    let dev: URL;
    try {
      dev = new URL(opts.devServerUrl);
    } catch {
      return false;
    }
    return url.protocol === dev.protocol && url.host === dev.host;
  }
  // 프로덕션: 정확한 진입 URL만. entryUrl이 없으면(예: 아직 미설정) 신뢰하지 않는다.
  if (!opts.entryUrl) return false;
  return rawUrl === opts.entryUrl;
}

// ---------------------------------------------------------------------------
// 전체 백업 원본 스트림의 무결성/원자성(다운로드·가져오기).
// ---------------------------------------------------------------------------

// 소문자 16진 SHA-256(64자)인지 확인한다.
const SHA256_HEX = /^[0-9a-f]{64}$/i;
export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && SHA256_HEX.test(v);
}

// 네이티브 다운로드는 무결성 정보가 필수다: 유효한 Content-Length(정수, 0 초과, 상한 이하)와
// SHA-256(64 16진)을 모두 요구한다. 하나라도 없거나 잘못되면 저장을 거부한다(fail-closed).
export interface DownloadExpectation {
  length: number;
  sha256: string;
}
export function parseDownloadExpectation(
  contentLength: string | null | undefined,
  sha256: string | null | undefined,
  max: number = MAX_PORTABLE_BACKUP_BYTES,
): { ok: true; value: DownloadExpectation } | { ok: false; reason: 'missing_sha256' | 'missing_length' | 'bad_length' | 'too_large' } {
  const sha = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
  if (!isSha256Hex(sha)) return { ok: false, reason: 'missing_sha256' };
  if (contentLength === null || contentLength === undefined || String(contentLength).trim() === '') {
    return { ok: false, reason: 'missing_length' };
  }
  const len = Number(contentLength);
  if (!Number.isInteger(len) || len <= 0) return { ok: false, reason: 'bad_length' };
  if (len > max) return { ok: false, reason: 'too_large' };
  return { ok: true, value: { length: len, sha256: sha } };
}

// 부모 디렉터리 엔트리를 디스크로 밀어낸다(rename 내구성). 일부 파일시스템/플랫폼은 디렉터리 fsync를
// 허용하지 않으므로 최선 노력(best-effort)으로 처리한다 — 파일 자체 fsync는 호출부에서 필수로 수행한다.
async function fsyncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    /* 디렉터리 fsync 미지원 — 무시 */
  } finally {
    await handle?.close().catch(() => {});
  }
}

// 응답 스트림을 목적지와 같은 디렉터리의 배타적 임시 파일(O_CREAT|O_EXCL|O_WRONLY, 0600)에 기록하며
// 정확한 바이트를 해싱한다. 선언된 길이·SHA-256과 정확히 일치할 때만 파일+부모 디렉터리를 fsync한 뒤
// 원자적 rename으로 목적지를 교체한다. 어떤 실패에서도 임시 파일만 제거하고 기존 목적지는 보존한다
// (검증 통과 전에는 목적지를 절대 건드리지 않는다).
export async function streamDownloadToFile(
  source: AsyncIterable<Uint8Array>,
  dest: string,
  expectation: DownloadExpectation,
  max: number = MAX_PORTABLE_BACKUP_BYTES,
): Promise<void> {
  const tmp = `${dest}.appops-part-${randomBytes(6).toString('hex')}`;
  const fh = await open(tmp, 'wx', 0o600);
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > expectation.length || received > max) throw new Error('length mismatch');
      hash.update(buf);
      let offset = 0;
      while (offset < buf.length) {
        const { bytesWritten } = await fh.write(buf, offset, buf.length - offset);
        if (!bytesWritten) throw new Error('write failed');
        offset += bytesWritten;
      }
    }
    if (received !== expectation.length) throw new Error('length mismatch');
    if (hash.digest('hex') !== expectation.sha256) throw new Error('sha256 mismatch');
    // 파일 데이터·메타데이터를 먼저 flush하고(필수), 부모 디렉터리 엔트리를 flush한 뒤 교체한다.
    await fh.sync();
    await fh.close();
    await fsyncDir(dirname(dest));
    // 여기서만 목적지가 바뀐다 — 완전한 검증 성공 후에만 원자적으로 교체한다.
    await rename(tmp, dest);
  } catch (error) {
    await fh.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// 사용자가 고른 파일을 O_NOFOLLOW로 단 한 번 연다(심볼릭 링크 거부). 그 하나의 디스크립터로 stat(일반
// 파일·크기 상한)과 매직(APPOPSB1)을 모두 확인하고, 같은 디스크립터를 호출부가 업로드 스트림까지 잡고
// 있게 한다(경로 교체 TOCTOU 방지 — 열린 inode의 바이트만 전송된다). 실패 시 디스크립터를 닫고 사유를
// 돌려준다. 성공 시 열린 FileHandle과 크기만 반환한다.
export interface PinnedBackupSource {
  fh: FileHandle;
  size: number;
}
export async function openPinnedBackupSource(
  path: string,
  max: number = MAX_PORTABLE_BACKUP_BYTES,
): Promise<
  | { ok: true; value: PinnedBackupSource }
  | { ok: false; code: 'symlink' | 'not_regular' | 'empty' | 'too_large' | 'bad_magic' | 'read_failed'; message: string }
> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP') return { ok: false, code: 'symlink', message: '심볼릭 링크는 가져올 수 없습니다.' };
    return { ok: false, code: 'read_failed', message: '선택한 파일을 열 수 없습니다.' };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      await fh.close();
      return { ok: false, code: 'not_regular', message: '일반 파일이 아닙니다.' };
    }
    const size = st.size;
    if (!Number.isFinite(size) || size <= 0) {
      await fh.close();
      return { ok: false, code: 'empty', message: '빈 파일입니다.' };
    }
    if (size > max) {
      await fh.close();
      return { ok: false, code: 'too_large', message: '파일이 허용 크기(512 GiB)를 초과합니다.' };
    }
    // 매직은 같은 디스크립터에서 위치 0을 지정해 읽는다(파일 오프셋을 옮기지 않음 → 이후 start:0 스트림과 무관).
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (!hasBackupMagic(head.subarray(0, bytesRead))) {
      await fh.close();
      return { ok: false, code: 'bad_magic', message: 'AppOps 암호화 백업 파일이 아닙니다(.appopsbackup).' };
    }
    return { ok: true, value: { fh, size } };
  } catch {
    await fh.close().catch(() => {});
    return { ok: false, code: 'read_failed', message: '선택한 파일을 읽을 수 없습니다.' };
  }
}

export const __testing = { ALLOWED_EXTERNAL_HOSTS, ROUTES };
