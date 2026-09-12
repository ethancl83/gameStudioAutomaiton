// 전체(포터블) 암호화 백업 브리지의 순수 보안/경로 로직 회귀 테스트.
// main.ts는 Electron 런타임이라 단위 테스트가 어렵지만, 브리지의 핵심 판정(식별자·매직·크기·경로·
// 허용 라우팅)은 security.ts의 순수 함수로 분리돼 있어 여기서 직접 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_MAGIC,
  MAX_PORTABLE_BACKUP_BYTES,
  hasBackupMagic,
  isAllowedApiPath,
  isPortableBackupId,
  isSha256Hex,
  isWithinPortableBackupSize,
  normalizePortableMode,
  openPinnedBackupSource,
  portableBackupDownloadPath,
  portableBackupImportPath,
  streamDownloadToFile,
  type DownloadExpectation,
} from '../apps/desktop/electron/security.js';

const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
function expectationFor(buf: Buffer): DownloadExpectation {
  return { length: buf.length, sha256: sha256Hex(buf) };
}
async function* once(buf: Buffer): AsyncGenerator<Uint8Array> {
  yield buf;
}
async function streamToBuffer(rs: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of rs) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}
async function partFiles(dir: string, base: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.startsWith(`${base}.appops-part-`));
}
const MAGIC = Buffer.from('APPOPSB1', 'latin1');

// ---------------------------------------------------------------------------
// 식별자 (엄격한 UUID)
// ---------------------------------------------------------------------------
test('isPortableBackupId accepts a UUID and rejects injection/garbage', () => {
  assert.equal(isPortableBackupId(VALID_UUID), true);
  assert.equal(isPortableBackupId(VALID_UUID.toUpperCase()), true);
  assert.equal(isPortableBackupId(''), false);
  assert.equal(isPortableBackupId('..'), false);
  assert.equal(isPortableBackupId('../../etc/passwd'), false);
  assert.equal(isPortableBackupId(`${VALID_UUID}/download`), false);
  assert.equal(isPortableBackupId(`${VALID_UUID}\n`), false);
  assert.equal(isPortableBackupId('3f2504e0-4f89-41d3-9a0c-0305e82c330'), false); // 12자 미만 마지막 그룹
  assert.equal(isPortableBackupId(123 as unknown), false);
  assert.equal(isPortableBackupId(null as unknown), false);
});

// ---------------------------------------------------------------------------
// 파일 매직 (APPOPSB1)
// ---------------------------------------------------------------------------
test('BACKUP_MAGIC is the archive magic APPOPSB1', () => {
  assert.equal(BACKUP_MAGIC.toString('latin1'), 'APPOPSB1');
  assert.equal(BACKUP_MAGIC.length, 8);
});

test('hasBackupMagic matches only the exact 8-byte prefix', () => {
  assert.equal(hasBackupMagic(Buffer.from('APPOPSB1rest-of-file')), true);
  assert.equal(hasBackupMagic(Buffer.from('APPOPSB1')), true);
  assert.equal(hasBackupMagic(Buffer.from('APPOPSB2')), false); // 다른 버전
  assert.equal(hasBackupMagic(Buffer.from('ZIPstuff')), false);
  assert.equal(hasBackupMagic(Buffer.from('APPOPS')), false); // 너무 짧음
  assert.equal(hasBackupMagic(new Uint8Array(0)), false);
});

// ---------------------------------------------------------------------------
// 크기 상한 (512 GiB)
// ---------------------------------------------------------------------------
test('MAX_PORTABLE_BACKUP_BYTES is 512 GiB (matches archive BACKUP_LIMITS.total)', () => {
  assert.equal(MAX_PORTABLE_BACKUP_BYTES, 512 * 1024 ** 3);
});

test('isWithinPortableBackupSize bounds (0, MAX]', () => {
  assert.equal(isWithinPortableBackupSize(0), false);
  assert.equal(isWithinPortableBackupSize(-1), false);
  assert.equal(isWithinPortableBackupSize(1), true);
  assert.equal(isWithinPortableBackupSize(MAX_PORTABLE_BACKUP_BYTES), true);
  assert.equal(isWithinPortableBackupSize(MAX_PORTABLE_BACKUP_BYTES + 1), false);
  assert.equal(isWithinPortableBackupSize(Number.NaN), false);
  assert.equal(isWithinPortableBackupSize(Number.POSITIVE_INFINITY), false);
});

// ---------------------------------------------------------------------------
// 모드/경로 (데모는 /demo 접두로 격리)
// ---------------------------------------------------------------------------
test('normalizePortableMode defaults anything but live to demo (safe default)', () => {
  assert.equal(normalizePortableMode('live'), 'live');
  assert.equal(normalizePortableMode('demo'), 'demo');
  assert.equal(normalizePortableMode(undefined), 'demo');
  assert.equal(normalizePortableMode('LIVE'), 'demo');
  assert.equal(normalizePortableMode({}), 'demo');
});

test('portable stream paths route demo through /demo and live directly', () => {
  assert.equal(portableBackupDownloadPath('live', VALID_UUID), `/operations/portable-backups/${VALID_UUID}/download`);
  assert.equal(portableBackupDownloadPath('demo', VALID_UUID), `/demo/operations/portable-backups/${VALID_UUID}/download`);
  assert.equal(portableBackupImportPath('live'), '/operations/portable-backups/import');
  assert.equal(portableBackupImportPath('demo'), '/demo/operations/portable-backups/import');
});

// ---------------------------------------------------------------------------
// JSON 허용 라우팅: 제어 경로만 통과, 원본 스트림(import/download)은 통과 금지
// (import/download는 forwardRequest가 아니라 전용 스트리밍 브리지로만 처리한다)
// ---------------------------------------------------------------------------
test('JSON control routes for portable backups are allowed (live and demo)', () => {
  assert.equal(isAllowedApiPath('GET', '/operations/portable-backups'), true);
  assert.equal(isAllowedApiPath('POST', '/operations/portable-backups'), true);
  assert.equal(isAllowedApiPath('POST', `/operations/portable-backups/${VALID_UUID}/prepare-restore`), true);
  assert.equal(isAllowedApiPath('POST', '/operations/portable-backups/commit-restore'), true);
  // 데모 접두도 동일 규칙으로 통과.
  assert.equal(isAllowedApiPath('GET', '/demo/operations/portable-backups'), true);
  assert.equal(isAllowedApiPath('POST', '/demo/operations/portable-backups/commit-restore'), true);
});

test('raw stream endpoints are NOT in the JSON allowlist (bridge-only)', () => {
  // 대용량 원본 스트림은 JSON forwardRequest로 흘리면 안 된다 — main 전용 브리지로만.
  assert.equal(isAllowedApiPath('GET', `/operations/portable-backups/${VALID_UUID}/download`), false);
  assert.equal(isAllowedApiPath('POST', '/operations/portable-backups/import'), false);
  assert.equal(isAllowedApiPath('GET', `/demo/operations/portable-backups/${VALID_UUID}/download`), false);
  // 잘못된 메서드/경로도 거부.
  assert.equal(isAllowedApiPath('DELETE', '/operations/portable-backups'), false);
  assert.equal(isAllowedApiPath('POST', '/operations/portable-backups/../secret'), false);
});

// ---------------------------------------------------------------------------
// SHA-256 16진 판정
// ---------------------------------------------------------------------------
test('isSha256Hex는 64 16진 문자열만 허용한다(대소문자 무관)', () => {
  assert.equal(isSha256Hex('a'.repeat(64)), true);
  assert.equal(isSha256Hex('A'.repeat(64)), true);
  assert.equal(isSha256Hex('a'.repeat(63)), false);
  assert.equal(isSha256Hex('a'.repeat(65)), false);
  assert.equal(isSha256Hex('z'.repeat(64)), false); // 비 16진
  assert.equal(isSha256Hex(''), false);
  assert.equal(isSha256Hex(123 as unknown), false);
});

// ---------------------------------------------------------------------------
// 다운로드 스트리밍: O_EXCL 임시 → 정확 바이트 해싱 → 길이·SHA 일치 시에만 원자적 교체.
// 실패(길이/해시 불일치)에서는 기존 목적지를 보존하고 임시 파일을 남기지 않는다.
// ---------------------------------------------------------------------------
test('streamDownloadToFile: 검증 통과 시 목적지를 원자적으로 교체하고 임시 파일을 남기지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-dl-'));
  try {
    const dest = join(dir, 'out.bin');
    await writeFile(dest, 'OLD-CONTENT'); // 기존 파일 존재
    const payload = Buffer.concat([MAGIC, randomBytes(2048)]);
    await streamDownloadToFile(once(payload), dest, expectationFor(payload));
    assert.deepEqual(await readFile(dest), payload); // 새 내용으로 교체됨
    assert.deepEqual(await partFiles(dir, 'out.bin'), []); // 임시 파일 잔존 없음
    const st = await stat(dest);
    assert.equal(st.mode & 0o777, 0o600); // 0600 권한
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('streamDownloadToFile: 길이 불일치면 던지고 기존 파일을 보존한다(임시 파일 정리)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-dl-'));
  try {
    const dest = join(dir, 'out.bin');
    await writeFile(dest, 'OLD-CONTENT');
    const payload = Buffer.concat([MAGIC, randomBytes(1000)]);
    const wrong: DownloadExpectation = { length: payload.length + 5, sha256: sha256Hex(payload) };
    await assert.rejects(streamDownloadToFile(once(payload), dest, wrong), /length mismatch/);
    assert.equal((await readFile(dest)).toString(), 'OLD-CONTENT'); // 기존 파일 보존
    assert.deepEqual(await partFiles(dir, 'out.bin'), []); // 임시 파일 제거됨
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('streamDownloadToFile: SHA-256 불일치면 던지고 기존 파일을 보존한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-dl-'));
  try {
    const dest = join(dir, 'out.bin');
    await writeFile(dest, 'OLD-CONTENT');
    const payload = Buffer.concat([MAGIC, randomBytes(1000)]);
    const wrong: DownloadExpectation = { length: payload.length, sha256: 'b'.repeat(64) };
    await assert.rejects(streamDownloadToFile(once(payload), dest, wrong), /sha256 mismatch/);
    assert.equal((await readFile(dest)).toString(), 'OLD-CONTENT');
    assert.deepEqual(await partFiles(dir, 'out.bin'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('streamDownloadToFile: 목적지가 없던 경우 실패 시 파일을 만들지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-dl-'));
  try {
    const dest = join(dir, 'fresh.bin');
    const payload = Buffer.concat([MAGIC, randomBytes(500)]);
    const wrong: DownloadExpectation = { length: payload.length, sha256: 'c'.repeat(64) };
    await assert.rejects(streamDownloadToFile(once(payload), dest, wrong));
    await assert.rejects(stat(dest)); // 목적지가 생성되지 않음
    assert.deepEqual(await partFiles(dir, 'fresh.bin'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 가져오기 소스 고정(O_NOFOLLOW 단일 디스크립터): 매직·크기·심볼릭 링크·경로 스왑(inode 고정).
// ---------------------------------------------------------------------------
test('openPinnedBackupSource: 매직·크기가 유효한 일반 파일을 열고 그 디스크립터로 바이트를 읽는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-imp-'));
  try {
    const path = join(dir, 'good.appopsbackup');
    const payload = Buffer.concat([MAGIC, randomBytes(4096)]);
    await writeFile(path, payload);
    const opened = await openPinnedBackupSource(path);
    assert.equal(opened.ok, true);
    if (opened.ok) {
      assert.equal(opened.value.size, payload.length);
      // 매직을 위치 0에서 읽었어도 스트림은 처음부터(start:0) 전체를 준다.
      const streamed = await streamToBuffer(opened.value.fh.createReadStream({ autoClose: false, start: 0 }));
      assert.deepEqual(streamed, payload);
      await opened.value.fh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openPinnedBackupSource: 매직 불일치·빈 파일을 거부한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-imp-'));
  try {
    const bad = join(dir, 'bad.bin');
    await writeFile(bad, Buffer.concat([Buffer.from('ZIPSTUFF!'), randomBytes(64)]));
    const r1 = await openPinnedBackupSource(bad);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.code, 'bad_magic');

    const empty = join(dir, 'empty.bin');
    await writeFile(empty, Buffer.alloc(0));
    const r2 = await openPinnedBackupSource(empty);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, 'empty');

    // 크기 상한 초과(작은 상한을 주입해 검증).
    const okFile = join(dir, 'ok.appopsbackup');
    await writeFile(okFile, Buffer.concat([MAGIC, randomBytes(100)]));
    const r3 = await openPinnedBackupSource(okFile, 50);
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.code, 'too_large');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openPinnedBackupSource: 심볼릭 링크는 O_NOFOLLOW로 거부한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-imp-'));
  try {
    const real = join(dir, 'real.appopsbackup');
    await writeFile(real, Buffer.concat([MAGIC, randomBytes(64)]));
    const link = join(dir, 'link.appopsbackup');
    await symlink(real, link);
    const r = await openPinnedBackupSource(link);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'symlink');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openPinnedBackupSource: 열린 디스크립터는 inode에 고정되어 이후 경로 스왑에 영향받지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-imp-'));
  try {
    const path = join(dir, 'swap.appopsbackup');
    const original = Buffer.concat([MAGIC, Buffer.from('ORIGINAL-BYTES'), randomBytes(64)]);
    await writeFile(path, original);
    const opened = await openPinnedBackupSource(path);
    assert.equal(opened.ok, true);
    if (opened.ok) {
      // 검증 이후 같은 경로를 다른(같은 형식) 파일로 교체한다.
      await unlink(path);
      await writeFile(path, Buffer.concat([MAGIC, Buffer.from('REPLACEMENT-DIFFERENT'), randomBytes(64)]));
      // 그러나 열어 둔 디스크립터에서 읽으면 여전히 원본 inode의 바이트가 나온다.
      const streamed = await streamToBuffer(opened.value.fh.createReadStream({ autoClose: false, start: 0 }));
      assert.deepEqual(streamed, original);
      assert.equal(opened.value.size, original.length); // 크기도 검증 당시의 것
      await opened.value.fh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
