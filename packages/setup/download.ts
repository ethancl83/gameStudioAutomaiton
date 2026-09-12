import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream, openSync, writeSync, closeSync, chmodSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rename, rm, stat, realpath, lstat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createGunzip } from 'node:zlib';
import { AppError } from '../domain/errors.js';
import { ZIP_LIMITS } from './archive.js';

const MAX_REDIRECTS = 8;
const MAX_DOWNLOAD_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [0, 200, 800, 2_000] as const;
const HEADER_SIZE = 512;

export function assertOfficialUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('UNOFFICIAL_URL', '설치 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'https:') throw new AppError('UNOFFICIAL_URL', '설치 파일은 HTTPS로만 받습니다.');
  if (url.username || url.password) throw new AppError('UNOFFICIAL_URL', '주소에 인증 정보를 넣을 수 없습니다.');
  if (url.port && url.port !== '443') throw new AppError('UNOFFICIAL_URL', '설치 주소 포트가 허용되지 않습니다.');
  const host = url.hostname.toLowerCase();
  if (!host || isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new AppError('UNOFFICIAL_URL', '로컬·IP 주소로는 설치 파일을 받지 않습니다.');
  }
  if (/[^a-z0-9.-]/.test(host) || host.includes('..') || host.startsWith('.') || host.startsWith('-')) {
    throw new AppError('UNOFFICIAL_URL', '설치 호스트가 허용 목록과 일치하지 않습니다.');
  }
  if (!allowedHosts.includes(host)) throw new AppError('UNOFFICIAL_URL', '공식 CDN이 아닌 주소로는 설치 파일을 받지 않습니다.');
  return url;
}

export async function fetchOfficial(
  fetcher: typeof fetch,
  url: string,
  allowedHosts: readonly string[],
  init: RequestInit = {},
): Promise<{response: Response; url: string}> {
  let current = assertOfficialUrl(url, allowedHosts).href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetcher(current, {...init, redirect: 'manual'});
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new AppError('UNOFFICIAL_URL', '리디렉션 주소를 확인할 수 없습니다.');
      current = assertOfficialUrl(new URL(location, current).href, allowedHosts).href;
      continue;
    }
    return {response, url: current};
  }
  throw new AppError('UNOFFICIAL_URL', '리디렉션이 너무 많습니다.');
}

export interface DownloadRequest {
  url: string;
  destination: string;
  sha256?: string;
  sha512?: string;
  maxBytes: number;
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number | null) => void;
}

export interface DownloadResult { bytes: number; sha256: string; sha512: string; url: string }

function hex(digest: Buffer): string { return digest.toString('hex'); }

function requirePin(sha256?: string, sha512?: string): void {
  if (!sha256 && !sha512) throw new AppError('DIGEST_REQUIRED', '설치 파일 해시가 카탈로그에 없습니다.');
}

function strongValidator(headers: Headers): string | null {
  const etag = headers.get('etag');
  if (etag && etag.startsWith('"') && etag.endsWith('"') && etag.length > 2 && !etag.startsWith('W/')) return etag;
  const modified = headers.get('last-modified');
  if (modified && !modified.includes('\n') && !modified.includes('\0') && modified.length < 80) return modified;
  return null;
}

/** Payload size we will receive after fetch decoding. gzip Content-Length is the compressed
 * size; Node decompresses, so compare against x-identity-content-length when present. */
export function expectedDecodedLength(headers: Headers): number | null {
  const encoding = (headers.get('content-encoding') ?? 'identity').split(',')[0]!.trim().toLowerCase();
  const identity = headers.get('x-identity-content-length');
  const length = headers.get('content-length');
  const compressed = encoding !== '' && encoding !== 'identity';
  if (compressed) return identity && /^\d+$/.test(identity) ? Number(identity) : null;
  if (length && /^\d+$/.test(length)) return Number(length);
  if (identity && /^\d+$/.test(identity)) return Number(identity);
  return null;
}

function parseContentRange(value: string | null, offset: number): {start: number; end: number; total: number} {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((value ?? '').trim());
  if (!match) throw new AppError('DOWNLOAD_FAILED', '부분 전송 범위가 올바르지 않습니다.');
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)
    || start !== offset || end < start || total <= end) {
    throw new AppError('DOWNLOAD_FAILED', '부분 전송 범위가 올바르지 않습니다.');
  }
  return {start, end, total};
}

function retryable(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (!(error instanceof AppError)) return true;
  if (error.code !== 'DOWNLOAD_FAILED') return false;
  const details = error.details as {retry?: boolean} | undefined;
  if (details && typeof details === 'object' && details.retry === false) return false;
  return true;
}

async function hashesOfFile(path: string): Promise<{size: number; sha256: ReturnType<typeof createHash>; sha512: ReturnType<typeof createHash>}> {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return {size: (await stat(path)).size, sha256, sha512};
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

async function discardPartial(partial: string): Promise<void> {
  await rm(partial, {force: true});
  await rm(`${partial}.invalid`, {force: true});
}

async function quarantinePartial(partial: string): Promise<void> {
  await rm(`${partial}.invalid`, {force: true});
  try {
    await rename(partial, `${partial}.invalid`);
  } catch {
    await rm(partial, {force: true});
  }
}

async function writeBody(
  response: Response,
  partial: string,
  offset: number,
  maxBytes: number,
  signal: AbortSignal | undefined,
  onProgress: DownloadRequest['onProgress'],
  total: number | null,
  hash256: ReturnType<typeof createHash>,
  hash512: ReturnType<typeof createHash>,
): Promise<number> {
  if (!response.body) throw new AppError('DOWNLOAD_FAILED', '설치 파일 본문이 없습니다.');
  const file = createWriteStream(partial, {flags: offset === 0 ? 'w' : 'r+', start: offset, mode: 0o600});
  let bytes = offset;
  const reader = response.body.getReader();
  const onAbort = (): void => { reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new AppError('DOWNLOAD_LIMIT', '설치 파일이 허용 크기를 넘습니다.');
      hash256.update(value);
      hash512.update(value);
      if (!file.write(value)) await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => { file.off('error', onError); resolve(); };
        const onError = (error: Error): void => { file.off('drain', onDrain); reject(error); };
        file.once('drain', onDrain);
        file.once('error', onError);
      });
      onProgress?.(bytes, total);
    }
    await new Promise<void>((resolve, reject) => { file.end((error: Error | null | undefined) => error ? reject(error) : resolve()); });
  } catch (error) {
    file.destroy();
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return bytes;
}

/** Stream a catalog URL to disk with a byte cap and pinned digest. Never follows an unverified hop.
 * Node fetch decompresses gzip; Google's Content-Length is then the compressed size. We ask for
 * identity encoding and treat x-identity-content-length as the decoded size when encoding is gzip. */
export async function downloadVerified(request: DownloadRequest): Promise<DownloadResult> {
  requirePin(request.sha256, request.sha512);
  const fetcher = request.fetch ?? fetch;
  await mkdir(dirname(request.destination), {recursive: true, mode: 0o700});
  const partial = request.destination + '.partial';
  await discardPartial(partial);

  let bytes = 0;
  let url = request.url;
  let validator: string | null = null;
  let total: number | null = null;
  let hash256 = createHash('sha256');
  let hash512 = createHash('sha512');
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    request.signal?.throwIfAborted();
    await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!, request.signal);
    const headers = new Headers();
    headers.set('accept-encoding', 'identity');
    if (bytes > 0 && validator) {
      headers.set('range', `bytes=${bytes}-`);
      headers.set('if-range', validator);
    }
    try {
      const fetched = await fetchOfficial(fetcher, request.url, request.allowedHosts, {signal: request.signal, headers});
      url = fetched.url;
      const response = fetched.response;
      const segmentStart = bytes;
      let segmentLength: number | null = null;
      if (response.status === 200) {
        if (bytes > 0) {
          bytes = 0;
          hash256 = createHash('sha256');
          hash512 = createHash('sha512');
          await discardPartial(partial);
        }
        total = expectedDecodedLength(response.headers);
        validator = strongValidator(response.headers);
      } else if (response.status === 206) {
        if (bytes <= 0 || !validator) throw new AppError('DOWNLOAD_FAILED', `설치 파일을 받지 못했습니다 (${response.status}).`, 400, {retry: false});
        const range = parseContentRange(response.headers.get('content-range'), bytes);
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity' || strongValidator(response.headers) !== validator || total !== null && total !== range.total) throw new AppError('DOWNLOAD_FAILED', '이어받기 응답의 파일 식별자·크기·인코딩이 원본과 일치하지 않습니다.', 400, {retry:false});
        segmentLength = range.end - bytes + 1;
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== segmentLength)) throw new AppError('DOWNLOAD_FAILED', '이어받기 범위와 응답 길이가 일치하지 않습니다.', 400, {retry:false});
        total = range.total;
      } else {
        const retry = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new AppError('DOWNLOAD_FAILED', `설치 파일을 받지 못했습니다 (${response.status}).`, 400, {retry});
      }
      if (total !== null && total > request.maxBytes) throw new AppError('DOWNLOAD_LIMIT', '설치 파일이 허용 크기를 넘습니다.');
      bytes = await writeBody(response, partial, bytes, request.maxBytes, request.signal, request.onProgress, total, hash256, hash512);
      if (segmentLength !== null && bytes - segmentStart !== segmentLength) throw new AppError('DOWNLOAD_FAILED', '이어받기 응답의 실제 바이트 수가 범위와 일치하지 않습니다.', 400, {retry:false});
      if (total !== null && bytes !== total) throw new AppError('DOWNLOAD_FAILED', '설치 파일이 중간에 잘렸습니다.');
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        await discardPartial(partial);
        throw Object.assign(new Error('aborted'), {name: 'AbortError'});
      }
      if (error instanceof AppError && (error.code === 'UNOFFICIAL_URL' || error.code === 'DIGEST_REQUIRED' || error.code === 'DOWNLOAD_LIMIT')) {
        await discardPartial(partial);
        throw error;
      }
      if (!retryable(error) || attempt === MAX_DOWNLOAD_ATTEMPTS - 1) {
        await quarantinePartial(partial);
        throw error;
      }
      try {
        const hashed = await hashesOfFile(partial);
        if (hashed.size > 0 && hashed.size <= request.maxBytes) {
          bytes = hashed.size;
          hash256 = hashed.sha256;
          hash512 = hashed.sha512;
        } else {
          bytes = 0;
          hash256 = createHash('sha256');
          hash512 = createHash('sha512');
          await discardPartial(partial);
        }
      } catch {
        bytes = 0;
        hash256 = createHash('sha256');
        hash512 = createHash('sha512');
        await discardPartial(partial);
      }
    }
  }

  if (lastError) {
    await quarantinePartial(partial);
    throw lastError;
  }
  if (total !== null && bytes !== total) {
    await quarantinePartial(partial);
    throw new AppError('DOWNLOAD_FAILED', '설치 파일이 중간에 잘렸습니다.');
  }
  const sha256 = hex(hash256.digest());
  const sha512 = hex(hash512.digest());
  if (request.sha256 && sha256 !== request.sha256.toLowerCase()) {
    await quarantinePartial(partial);
    throw new AppError('DIGEST_MISMATCH', '받은 파일의 SHA-256이 카탈로그와 다릅니다. 설치를 중단했습니다.');
  }
  if (request.sha512 && sha512 !== request.sha512.toLowerCase()) {
    await quarantinePartial(partial);
    throw new AppError('DIGEST_MISMATCH', '받은 파일의 SHA-512가 카탈로그와 다릅니다. 설치를 중단했습니다.');
  }
  await rename(partial, request.destination);
  return {bytes, sha256, sha512, url};
}

function tarPath(name: string): string {
  while (name.startsWith('./')) name = name.slice(2);
  if (!name || name.length > 2048 || name.includes('\\') || name.includes('\0') || name.startsWith('/')
    || /^[A-Za-z]:/.test(name) || name.split('/').some(part => !part || part === '..' || part === '.' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || /[<>:"|?*\x00-\x1f]/.test(name)) {
    throw new AppError('UNSAFE_ARCHIVE', '압축 파일에 안전하지 않은 경로가 있습니다.');
  }
  return name;
}

function parseOctal(header: Buffer, start: number, length: number): number {
  if (header[start] & 0x80) throw new AppError('INVALID_ARCHIVE', '큰 숫자 형식의 tar 항목은 지원하지 않습니다.');
  const text = header.subarray(start, start + length).toString('ascii').replace(/\0/g, ' ').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new AppError('INVALID_ARCHIVE', 'tar 숫자 정보가 잘못되었습니다.');
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError('INVALID_ARCHIVE', 'tar 크기 정보가 잘못되었습니다.');
  return value;
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) sum += (i >= 148 && i < 156) ? 0x20 : header[i]!;
  return sum;
}

function readCString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString('utf8');
}

function parsePax(data: Buffer): {path?: string; size?: number} {
  const result: {path?: string; size?: number} = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const digits = space < 0 ? '' : data.subarray(offset, space).toString('ascii');
    const length = Number(digits);
    if (!/^[1-9][0-9]*$/.test(digits) || !Number.isSafeInteger(length) || length <= space - offset + 2
      || offset + length > data.length || data[offset + length - 1] !== 0x0a) {
      throw new AppError('INVALID_ARCHIVE', 'pax 형식이 잘못되었습니다.');
    }
    // PAX record lengths count bytes, including the prefix and newline, not UTF-16 characters.
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq < 1) throw new AppError('INVALID_ARCHIVE', 'pax 형식이 잘못되었습니다.');
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (key === 'linkpath' || key.startsWith('GNU.sparse.') || key === 'SCHILY.realsize') throw new AppError('UNSAFE_ARCHIVE', '링크나 희소 파일이 있는 tar 파일입니다.');
    if (key === 'path') result.path = value;
    if (key === 'size') {
      const size = Number(value);
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(size) || size < 0) throw new AppError('INVALID_ARCHIVE', 'pax 크기가 잘못되었습니다.');
      result.size = size;
    }
    offset += length;
  }
  return result;
}

interface TarHeader {
  name: string;
  linkname: string;
  size: number;
  type: string;
  executable: boolean;
  directory: boolean;
}
interface TarWork { kind:'file'|'skip'; remaining:number; pad:number; fd?:number; executable?:boolean; output?:string }

function parseHeader(block: Buffer): TarHeader | null {
  if (block.every(byte => byte === 0)) return null;
  const stored = parseOctal(block, 148, 8);
  if (stored !== headerChecksum(block)) throw new AppError('INVALID_ARCHIVE', 'tar 헤더 검사가 실패했습니다.');
  const magic = readCString(block, 257, 6);
  if (magic && magic !== 'ustar' && magic !== 'ustar ') throw new AppError('INVALID_ARCHIVE', '지원하지 않는 tar 형식입니다.');
  const type = String.fromCharCode(block[156] || 0) || '0';
  // GNU/oldgnu uses this region for atime/ctime and sparse metadata, not a POSIX path prefix.
  const prefix = magic === 'ustar' ? readCString(block, 345, 155) : '';
  const base = readCString(block, 0, 100);
  const name = prefix ? `${prefix}/${base}` : base;
  const mode = parseOctal(block, 100, 8);
  const size = parseOctal(block, 124, 12);
  return {name, linkname: readCString(block, 157, 100), size, type, executable: Boolean(mode & 0o111), directory: type === '5' || name.endsWith('/')};
}

/** Stream a verified archive into a fresh directory. Optional internal links are materialized as
 * ordinary files only after extraction. No filesystem link is created or traversed. */
export async function extractTarGz(archivePath: string, destination: string, signal?: AbortSignal,
  options: {materializeInternalLinks?: boolean} = {}): Promise<void> {
  const size = (await stat(archivePath)).size;
  if (size < 24 || size > ZIP_LIMITS.archive) throw new AppError('ARCHIVE_LIMIT', '설치 압축 파일 크기를 확인해 주세요.');
  try { await lstat(destination); throw new AppError('INSTALL_EXISTS', '새 설치 임시 폴더가 이미 존재합니다.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(destination, {recursive: true, mode: 0o700});
  const root = await realpath(destination);
  const seen = new Set<string>();
  const descriptors = new Set<number>();
  let leftover = Buffer.alloc(0);
  let longName: string | null = null;
  let pax: {path?: string; size?: number} = {};
  let total = 0;
  let entries = 0;
  let current: TarWork | null = null;
  let ended = false;
  const links = new Map<string, string>();

  const consume = async (chunk: Buffer): Promise<void> => {
    signal?.throwIfAborted();
    if (ended) {
      if (chunk.some(byte => byte !== 0)) throw new AppError('INVALID_ARCHIVE', 'tar 끝 표시 뒤에 데이터가 있습니다.');
      return;
    }
    let data = leftover.length ? Buffer.concat([leftover, Buffer.from(chunk)]) : Buffer.from(chunk);
    leftover = Buffer.alloc(0);
    const take = (count: number): Buffer | null => {
      if (data.length < count) return null;
      const out = Buffer.from(data.subarray(0, count));
      data = Buffer.from(data.subarray(count));
      return out;
    };
    while (data.length) {
      if (current) {
        const amount = Math.min(current.remaining, data.length);
        const piece = data.subarray(0, amount);
        data = data.subarray(amount);
        if (current.kind === 'file' && current.fd !== undefined) {
          let offset = 0;
          while (offset < piece.length) offset += writeSync(current.fd, piece, offset, piece.length - offset);
        }
        current.remaining -= amount;
        if (current.remaining === 0) {
          if (current.kind === 'file' && current.fd !== undefined) {
            closeSync(current.fd); descriptors.delete(current.fd);
            chmodSync(current.output!, current.executable ? 0o700 : 0o600);
          }
          if (current.pad) {
            if (data.length < current.pad) {
              leftover = data;
              current = {kind:'skip', remaining: current.pad, pad: 0};
              return;
            }
            data = data.subarray(current.pad);
          }
          current = null;
        }
        continue;
      }
      const block = take(HEADER_SIZE);
      if (!block) { leftover = data; return; }
      const header = parseHeader(block);
      if (!header) {
        if (data.some(byte => byte !== 0)) throw new AppError('INVALID_ARCHIVE', 'tar 끝 표시 뒤에 데이터가 있습니다.');
        ended = true; leftover = Buffer.alloc(0); return;
      }
      entries += 1;
      if (entries > ZIP_LIMITS.entries) throw new AppError('ARCHIVE_LIMIT', '압축 항목 수가 설치 한도를 넘습니다.');
      let pad = (HEADER_SIZE - (header.size % HEADER_SIZE)) % HEADER_SIZE;
      if (header.type === 'L' || header.type === 'x') {
        if (header.size > 16_384) throw new AppError('ARCHIVE_LIMIT', 'tar 이름 정보가 너무 깁니다.');
        const body = take(header.size);
        if (!body) { leftover = Buffer.concat([Buffer.from(block), data]); return; }
        if (header.type === 'L') longName = body.subarray(0, header.size).toString('utf8').replace(/\0+$/, '');
        else {
          pax = parsePax(body.subarray(0, header.size));
        }
        if (pad) {
          const padding = take(pad);
          if (!padding) { current = {kind:'skip', remaining: pad, pad: 0}; leftover = data; return; }
        }
        continue;
      }
      if (header.type === 'g') throw new AppError('UNSAFE_ARCHIVE', '전역 pax tar는 지원하지 않습니다.');
      const isLink = header.type === '1' || header.type === '2';
      if (!['0', '\0', '5'].includes(header.type) && !(isLink && options.materializeInternalLinks)) throw new AppError('UNSAFE_ARCHIVE', '링크·특수 파일이 있는 압축 파일입니다.');
      const rawName = (pax.path ?? longName ?? header.name).replace(/\/$/, '');
      const fileSize = pax.size ?? header.size;
      pad = (HEADER_SIZE - (fileSize % HEADER_SIZE)) % HEADER_SIZE;
      const directory = header.type === '5' || header.name.endsWith('/');
      longName = null; pax = {};
      if ((rawName === '.' || rawName === '') && directory && fileSize === 0) continue;
      const name = tarPath(rawName);
      const normalized = name.normalize('NFC').toLowerCase();
      if (!normalized || seen.has(normalized)) throw new AppError('UNSAFE_ARCHIVE', '중복 경로가 있는 압축 파일입니다.');
      seen.add(normalized);
      total += fileSize;
      if (fileSize > ZIP_LIMITS.file || total > ZIP_LIMITS.total) throw new AppError('ARCHIVE_LIMIT', '압축 해제 크기가 설치 한도를 넘습니다.');
      const output = resolve(root, name);
      const rel = relative(root, output);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new AppError('UNSAFE_ARCHIVE', '설치 경로를 벗어나는 항목입니다.');
      if (isLink) {
        const targetName = header.linkname;
        if (fileSize !== 0 || !targetName || targetName.includes('\\') || /[<>:"|?*\x00-\x1f]/.test(targetName) || isAbsolute(targetName)) {
          throw new AppError('UNSAFE_ARCHIVE', '안전하지 않은 tar 링크 항목입니다.');
        }
        const target = resolve(header.type === '1' ? root : dirname(output), targetName);
        const targetRel = relative(root, target);
        if (!targetRel || targetRel.startsWith('..') || isAbsolute(targetRel)) throw new AppError('UNSAFE_ARCHIVE', '설치 경로를 벗어나는 링크입니다.');
        tarPath(targetRel.split('\\').join('/'));
        links.set(output, target);
        continue;
      }
      if (directory) {
        await mkdir(output, {recursive: true, mode: 0o700});
        if (fileSize) current = {kind:'skip', remaining: fileSize, pad};
        else if (pad) current = {kind:'skip', remaining: pad, pad: 0};
        continue;
      }
      await mkdir(dirname(output), {recursive: true, mode: 0o700});
      const fd = openSync(output, 'wx', 0o600);
      descriptors.add(fd);
      current = {kind:'file', remaining: fileSize, pad, fd, executable: header.executable, output};
    }
  };

  try {
    const stream = createReadStream(archivePath, {highWaterMark: 64 * 1024}).pipe(createGunzip());
    for await (const chunk of stream) await consume(Buffer.from(chunk));
    if (!ended || longName !== null || Object.keys(pax).length) throw new AppError('INVALID_ARCHIVE', 'tar 파일이 중간에 잘렸습니다.');
    if ((current as TarWork | null)?.remaining) throw new AppError('INVALID_ARCHIVE', 'tar 파일이 중간에 잘렸습니다.');
    if (leftover.length && leftover.some(byte => byte !== 0)) throw new AppError('INVALID_ARCHIVE', 'tar 파일이 중간에 잘렸습니다.');
    const materialize = async (output: string, chain: Set<string>): Promise<void> => {
      signal?.throwIfAborted();
      const target = links.get(output);
      if (!target) return;
      if (chain.has(output) || chain.size >= 32) throw new AppError('UNSAFE_ARCHIVE', '순환하거나 너무 긴 tar 링크입니다.');
      const next = new Set(chain).add(output);
      await materialize(target, next);
      // All extracted entries are regular files/directories. Realpath also detects an
      // unexpected external replacement before any bytes are copied.
      const targetReal = await realpath(target);
      const targetRel = relative(root, targetReal);
      const info = await lstat(target);
      if (targetReal !== target || !targetRel || targetRel.startsWith('..') || isAbsolute(targetRel) || !info.isFile()) {
        throw new AppError('UNSAFE_ARCHIVE', 'tar 링크는 같은 설치 폴더의 일반 파일만 가리킬 수 있습니다.');
      }
      total += info.size;
      if (info.size > ZIP_LIMITS.file || total > ZIP_LIMITS.total) throw new AppError('ARCHIVE_LIMIT', '링크 복사 크기가 설치 한도를 넘습니다.');
      await mkdir(dirname(output), {recursive: true, mode: 0o700});
      if (await realpath(dirname(output)) !== dirname(output)) throw new AppError('UNSAFE_ARCHIVE', '설치 경로가 바뀌었습니다.');
      await copyFile(target, output, constants.COPYFILE_EXCL);
      await chmod(output, info.mode & 0o111 ? 0o700 : 0o600);
      links.delete(output);
    };
    for (const output of links.keys()) await materialize(output, new Set());
  } finally {
    for (const fd of descriptors) try { closeSync(fd); } catch { /* already closed */ }
  }
}

export async function assertTreeSafe(root: string): Promise<void> {
  const stack = [await realpath(root)];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const target = join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || info.isFIFO() || info.isSocket() || info.isCharacterDevice() || info.isBlockDevice()) {
        throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 링크나 특수 파일이 있습니다.');
      }
      if (info.isDirectory()) stack.push(target);
    }
  }
}
