import { spawn } from 'node:child_process';
import { open, type FileHandle } from 'node:fs/promises';
import { gunzipSync, inflateRawSync } from 'node:zlib';

import { AppError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Decimal helpers
// ---------------------------------------------------------------------------

/** Convert a decimal string like "12.3456" to an integer micros string without float error. */
export function decimalToMicros(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new AppError('INVALID_PROVIDER_RESPONSE', '금액 형식을 해석할 수 없습니다.', 502);
  const [, sign, whole, fraction = ''] = match;
  const micros = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  return sign === '-' ? -micros : micros;
}

// ---------------------------------------------------------------------------
// Gzip TSV reports (Apple sales reports)
// ---------------------------------------------------------------------------

export function parseGzipTsv(bytes: Buffer): Array<Record<string, string>> {
  let text: string;
  try {
    text = gunzipSync(bytes).toString('utf8');
  } catch {
    throw new AppError('INVALID_PROVIDER_RESPONSE', '보고서 압축을 해제할 수 없습니다.', 502);
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) return [];
  const headers = lines[0].split('\t').map(header => header.trim());
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    headers.forEach((header, index) => { row[header] = (cells[index] ?? '').trim(); });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader — reads one entry from an .ipa without loading the whole
// archive. Supports stored/deflate entries and ZIP64 central directory offsets.
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

interface ZipEntry { name: string; method: number; compressedSize: number; localOffset: number }

function corrupted(): AppError {
  return new AppError('INVALID_INPUT', '결과물 아카이브(.ipa)를 읽을 수 없습니다. 파일이 손상되었을 수 있습니다.');
}

export async function readZipEntry(path: string | FileHandle, matches: (name: string) => boolean): Promise<{ name: string; data: Buffer } | undefined> {
  const handle = typeof path === 'string' ? await open(path, 'r') : path;
  try {
    const { size } = await handle.stat();
    if (size < 22) throw corrupted();
    const tailLength = Math.min(size, 22 + 65_535 + 20);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) { eocd = index; break; }
    }
    if (eocd < 0) throw corrupted();
    let entryCount: number = tail.readUInt16LE(eocd + 10);
    let directorySize: number = tail.readUInt32LE(eocd + 12);
    let directoryOffset: number = tail.readUInt32LE(eocd + 16);
    if (directoryOffset === 0xffffffff || entryCount === 0xffff || directorySize === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) throw corrupted();
      const zip64Offset = Number(tail.readBigUInt64LE(locator + 8));
      const zip64 = Buffer.alloc(56);
      await handle.read(zip64, 0, 56, zip64Offset);
      if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw corrupted();
      entryCount = Number(zip64.readBigUInt64LE(32));
      directorySize = Number(zip64.readBigUInt64LE(40));
      directoryOffset = Number(zip64.readBigUInt64LE(48));
    }
    if (directorySize > 64 * 1024 * 1024) throw corrupted();
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    let cursor = 0;
    let entry: ZipEntry | undefined;
    for (let index = 0; index < entryCount && cursor + 46 <= directory.length; index += 1) {
      if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw corrupted();
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize: number = directory.readUInt32LE(cursor + 20);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      let localOffset: number = directory.readUInt32LE(cursor + 42);
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        // ZIP64 extra field (id 0x0001): fields appear in a fixed order for
        // each 0xffffffff placeholder present in the fixed record.
        const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
        let extraCursor = 0;
        while (extraCursor + 4 <= extra.length) {
          const id = extra.readUInt16LE(extraCursor);
          const dataSize = extra.readUInt16LE(extraCursor + 2);
          if (id === 0x0001) {
            let fieldCursor = extraCursor + 4;
            const uncompressedMissing = directory.readUInt32LE(cursor + 24) === 0xffffffff;
            if (uncompressedMissing) fieldCursor += 8;
            if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(fieldCursor)); fieldCursor += 8; }
            if (localOffset === 0xffffffff) localOffset = Number(extra.readBigUInt64LE(fieldCursor));
            break;
          }
          extraCursor += 4 + dataSize;
        }
      }
      if (matches(name)) { entry = { name, method, compressedSize, localOffset }; break; }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (!entry) return undefined;
    if (entry.compressedSize > 16 * 1024 * 1024) throw corrupted();

    const local = Buffer.alloc(30);
    await handle.read(local, 0, 30, entry.localOffset);
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw corrupted();
    const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const compressed = Buffer.alloc(entry.compressedSize);
    await handle.read(compressed, 0, entry.compressedSize, dataOffset);
    if (entry.method === 0) return { name: entry.name, data: compressed };
    if (entry.method === 8) {
      try { return { name: entry.name, data: inflateRawSync(compressed, {maxOutputLength:16*1024*1024}) }; } catch { throw corrupted(); }
    }
    throw corrupted();
  } finally {
    if(typeof path === 'string') await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Property list parsing (binary bplist00 and XML) — only what an Info.plist
// needs: dictionaries, arrays, strings, integers, booleans.
// ---------------------------------------------------------------------------

type PlistValue = string | number | boolean | null | PlistValue[] | { [key: string]: PlistValue };

function parseBinaryPlist(buffer: Buffer): PlistValue {
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetSize = trailer.readUInt8(6);
  const referenceSize = trailer.readUInt8(7);
  const objectCount = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
  if (objectCount > 100_000) throw corrupted();

  const readUInt = (offset: number, size: number): number => {
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 256 + buffer.readUInt8(offset + index);
    return value;
  };
  const offsets: number[] = [];
  for (let index = 0; index < objectCount; index += 1) {
    offsets.push(readUInt(offsetTableOffset + index * offsetSize, offsetSize));
  }

  const parseObject = (reference: number, depth: number): PlistValue => {
    if (depth > 32 || reference >= offsets.length) throw corrupted();
    let offset = offsets[reference];
    const marker = buffer.readUInt8(offset);
    const type = marker >> 4;
    let length = marker & 0x0f;
    offset += 1;
    if (type !== 0x1 && type !== 0x2 && length === 0x0f) {
      const intMarker = buffer.readUInt8(offset);
      const intSize = 1 << (intMarker & 0x0f);
      offset += 1;
      length = readUInt(offset, intSize);
      offset += intSize;
    }
    switch (type) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x1:
        return readUInt(offset, 1 << length);
      case 0x2:
        return length === 2 ? buffer.readFloatBE(offset) : buffer.readDoubleBE(offset);
      case 0x4:
        return buffer.subarray(offset, offset + length).toString('base64');
      case 0x5:
        return buffer.subarray(offset, offset + length).toString('latin1');
      case 0x6: {
        const utf16 = buffer.subarray(offset, offset + length * 2);
        let text = '';
        for (let index = 0; index < length; index += 1) text += String.fromCharCode(utf16.readUInt16BE(index * 2));
        return text;
      }
      case 0xa: {
        const items: PlistValue[] = [];
        for (let index = 0; index < length; index += 1) {
          items.push(parseObject(readUInt(offset + index * referenceSize, referenceSize), depth + 1));
        }
        return items;
      }
      case 0xd: {
        const dictionary: { [key: string]: PlistValue } = {};
        for (let index = 0; index < length; index += 1) {
          const key = parseObject(readUInt(offset + index * referenceSize, referenceSize), depth + 1);
          const value = parseObject(readUInt(offset + (length + index) * referenceSize, referenceSize), depth + 1);
          if (typeof key === 'string') dictionary[key] = value;
        }
        return dictionary;
      }
      default:
        throw corrupted();
    }
  };
  return parseObject(topObject, 0);
}

function parseXmlPlist(text: string): PlistValue {
  const tags = [...text.matchAll(/<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>|<!--[\s\S]*?-->/g)];
  let cursor = 0;
  const decode = (value: string): string =>
    value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const textBetween = (start: number, end: number): string => decode(text.slice(start, end).trim());

  const parseValue = (depth: number): PlistValue => {
    if (depth > 32) throw corrupted();
    while (cursor < tags.length) {
      const tag = tags[cursor];
      cursor += 1;
      if (!tag[2] || tag[1] === '/') continue;
      const name = tag[2];
      const selfClosed = tag[3] === '/';
      if (name === 'plist') continue;
      if (name === 'true') return true;
      if (name === 'false') return false;
      if (name === 'string' || name === 'integer' || name === 'real' || name === 'date' || name === 'data' || name === 'key') {
        if (selfClosed) return '';
        const closing = tags.findIndex((candidate, index) => index >= cursor && candidate[1] === '/' && candidate[2] === name);
        if (closing < 0) throw corrupted();
        const value = textBetween(tag.index! + tag[0].length, tags[closing].index!);
        cursor = closing + 1;
        if (name === 'integer') return Number(value);
        if (name === 'real') return Number(value);
        return value;
      }
      if (name === 'array') {
        const items: PlistValue[] = [];
        if (selfClosed) return items;
        while (cursor < tags.length && !(tags[cursor][1] === '/' && tags[cursor][2] === 'array')) items.push(parseValue(depth + 1));
        cursor += 1;
        return items;
      }
      if (name === 'dict') {
        const dictionary: { [key: string]: PlistValue } = {};
        if (selfClosed) return dictionary;
        while (cursor < tags.length && !(tags[cursor][1] === '/' && tags[cursor][2] === 'dict')) {
          const key = parseValue(depth + 1);
          const value = parseValue(depth + 1);
          if (typeof key === 'string') dictionary[key] = value;
        }
        cursor += 1;
        return dictionary;
      }
    }
    throw corrupted();
  };
  return parseValue(0);
}

export function parsePlist(data: Buffer): Record<string, PlistValue> {
  const parsed = data.subarray(0, 8).toString('latin1') === 'bplist00'
    ? parseBinaryPlist(data)
    : parseXmlPlist(data.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupted();
  return parsed as Record<string, PlistValue>;
}

export interface IpaMetadata { bundleId: string; shortVersion: string; buildVersion: string }

/** Read CFBundle identifiers/versions from an .ipa's Payload/<App>.app/Info.plist. */
export async function readIpaMetadata(path: string | FileHandle): Promise<IpaMetadata> {
  const entry = await readZipEntry(path, name => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name));
  if (!entry) throw new AppError('INVALID_INPUT', '.ipa 안에서 Payload/*.app/Info.plist를 찾지 못했습니다. iOS 앱 아카이브가 맞는지 확인해 주세요.');
  const plist = parsePlist(entry.data);
  const bundleId = plist.CFBundleIdentifier;
  const shortVersion = plist.CFBundleShortVersionString;
  const buildVersion = plist.CFBundleVersion;
  if (typeof bundleId !== 'string' || typeof shortVersion !== 'string' || typeof buildVersion !== 'string') {
    throw new AppError('INVALID_INPUT', 'Info.plist에 CFBundleIdentifier/CFBundleShortVersionString/CFBundleVersion이 없습니다.');
  }
  return { bundleId, shortVersion, buildVersion };
}

export async function readFileSlice(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const slice = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(slice, filled, length - filled, offset + filled);
      if (bytesRead === 0) throw new AppError('INVALID_INPUT', '결과물 파일이 예고된 크기보다 작습니다.');
      filled += bytesRead;
    }
    return slice;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// VDF (Valve KeyValues) generation with strict escaping — used to build the
// SteamPipe app_build script. Values may not contain control characters.
// ---------------------------------------------------------------------------

export type VdfNode = { [key: string]: string | VdfNode };

function vdfString(value: string, label: string): string {
  if (/[\0-\x1f\x7f]/.test(value)) {
    throw new AppError('INVALID_INPUT', `${label} 값에 제어 문자를 사용할 수 없습니다.`);
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderVdf(node: VdfNode, indent = 0): string {
  const pad = '\t'.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new AppError('INVALID_INPUT', 'VDF 키 형식이 올바르지 않습니다.');
    if (typeof value === 'string') {
      lines.push(`${pad}${vdfString(key, key)}\t\t${vdfString(value, key)}`);
    } else {
      lines.push(`${pad}${vdfString(key, key)}`, `${pad}{`, renderVdf(value, indent + 1), `${pad}}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Trusted CLI runner — no shell, no secrets in argv, bounded output.
// ---------------------------------------------------------------------------

export interface CommandResult { code: number | null; output: string; timedOut: boolean }

export function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; timeoutMs: number; env?: Record<string, string | undefined>; onLine?: (line: string) => void },
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    // detached puts the child in its own process group so cancellation can
    // kill the whole tree (SteamCMD spawns helpers), not just the leader.
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    const killTree = (): void => {
      try {
        if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    let output = '';
    let pending = '';
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (output.length < 512 * 1024) output += text.slice(0, 512 * 1024 - output.length);
      pending += text;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).trimEnd();
        pending = pending.slice(newline + 1);
        if (line && options.onLine) options.onLine(line);
      }
      if (pending.length > 8_192) pending = pending.slice(-8_192);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);
    const onAbort = (): void => { killTree(); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      result();
    };
    child.on('error', error => finish(() => rejectPromise(error)));
    child.on('close', code => finish(() => resolvePromise({ code, output, timedOut })));
  });
}
