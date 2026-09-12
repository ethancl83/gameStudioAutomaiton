// Behavioral regression tests for the portable-backup archive primitive (packages/backup/archive.ts).
// Covers the v4-backup-crypto-review fixes: schema-2 KDF write + schema-1/2 read, writer/reader
// structural symmetry, case-distinct paths, data/file exclusivity, path bounds, cancellation, and
// frame/tamper rejection. No secret values are asserted — only behavioral accept/reject and integrity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupPath, readBackup, writeBackup, type BackupEntry, type BackupEntrySink } from '../packages/backup/archive.js';

const PASSWORD = randomBytes(24).toString('base64url');
const CHUNK = 1024 * 1024;
const MAGIC = Buffer.from('APPOPSB1');
const ENTRY = Buffer.from('entry');

async function temporary(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'appops-backup-primitive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Collect every entry into memory; assert nothing on the bytes here (callers assert round-trip).
function collectingSink(store: Map<string, Buffer>, path: string): BackupEntrySink {
  const chunks: Buffer[] = [];
  return { write: async b => { chunks.push(Buffer.from(b)); }, finish: async () => { store.set(path, Buffer.concat(chunks)); } };
}

const STD: BackupEntry[] = [
  { kind: 'manifest', path: 'manifest.json', data: Buffer.from('{}') },
  { kind: 'database', path: 'operations.sqlite', data: Buffer.from('db-fixture') },
];

// Faithful replica of the on-disk envelope so we can forge a schema-1 archive (backward compat) and
// schema/param mismatches. It mirrors writeBackup exactly; if its schema-2 output round-trips through
// the real readBackup, the replica is correct and its schema-1 output proves the compat branch.
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function seal(key: Buffer, nonce: Buffer, aad: Buffer, data: Buffer): { bytes: Buffer; tag: Buffer } {
  const c = createCipheriv('aes-256-gcm', key, nonce); c.setAAD(aad);
  return { bytes: Buffer.concat([c.update(data), c.final()]), tag: c.getAuthTag() };
}
function buildArchive(opts: { schema: number; N: number; p: number; entries: readonly BackupEntry[] }): Buffer {
  const { schema, N, p } = opts;
  const entries = opts.entries.map(e => ({ kind: e.kind, path: e.path, data: e.data ?? Buffer.alloc(0) }));
  const salt = randomBytes(16), prefix = randomBytes(8), key = randomBytes(32), wrapNonce = randomBytes(12);
  const base = { schema, kdf: { name: 'scrypt', N, r: 8, p, salt: salt.toString('base64url') }, fileNonce: prefix.toString('base64url') };
  const kek = scryptSync(PASSWORD, salt, 32, { N, r: 8, p, maxmem: 64 * 1024 ** 2 });
  const wrapped = seal(kek, wrapNonce, Buffer.from(JSON.stringify(base)), key);
  const header = Buffer.from(JSON.stringify({ ...base, wrapped: { nonce: wrapNonce.toString('base64url'), key: wrapped.bytes.toString('base64url'), tag: wrapped.tag.toString('base64url') } }));
  const headerHash = createHash('sha256').update(header).digest();
  let counter = 0; const parts = [Buffer.concat([MAGIC, u32(header.length), header])]; let total = 0;
  const frame = (data: Buffer, context: Buffer) => {
    const index = u32(counter++); const v = seal(key, Buffer.concat([prefix, index]), Buffer.concat([MAGIC, headerHash, index, context]), data);
    parts.push(Buffer.concat([u32(v.bytes.length), v.bytes, v.tag]));
  };
  for (const e of entries) {
    const meta = { type: 'entry', kind: e.kind, path: e.path, size: e.data.length, sha256: createHash('sha256').update(e.data).digest('hex'), executable: false };
    total += e.data.length;
    const encoded = Buffer.from(JSON.stringify(meta)); frame(encoded, ENTRY);
    const context = createHash('sha256').update(encoded).digest();
    for (let at = 0, part = 0; at < e.data.length; at += CHUNK, part++) frame(e.data.subarray(at, at + CHUNK), Buffer.concat([context, u32(part)]));
  }
  frame(Buffer.from(JSON.stringify({ type: 'end', entries: entries.length, bytes: total })), ENTRY);
  return Buffer.concat(parts);
}

async function readAll(path: string, password = PASSWORD): Promise<Map<string, Buffer>> {
  const store = new Map<string, Buffer>();
  await readBackup(path, password, async meta => collectingSink(store, meta.path));
  return store;
}

// ---------------------------------------------------------------------------
// F4: KDF work factor + schema-2 write / schema-1+2 read
// ---------------------------------------------------------------------------

test('writeBackup emits schema 2 with scrypt p=3 and round-trips', async t => {
  const dir = await temporary(t), archive = join(dir, 'a.appopsbackup');
  await writeBackup(archive, PASSWORD, STD);
  const header = JSON.parse((await readFile(archive)).subarray(12, 12 + (await readFile(archive)).readUInt32BE(8)).toString('utf8'));
  assert.equal(header.schema, 2);
  assert.equal(header.kdf.N, 32768);
  assert.equal(header.kdf.p, 3); // OWASP-equivalent to N=2^17,r=8,p=1 while staying under the 64 MiB maxmem cap
  const store = await readAll(archive);
  assert.deepEqual(store.get('operations.sqlite'), Buffer.from('db-fixture'));
});

test('readBackup still opens a legacy schema-1 (p=1) archive (pre-release compatibility)', async t => {
  const dir = await temporary(t), archive = join(dir, 'legacy.appopsbackup');
  await writeFile(archive, buildArchive({ schema: 1, N: 32768, p: 1, entries: STD }));
  const store = await readAll(archive);
  assert.deepEqual(store.get('manifest.json'), Buffer.from('{}'));
  assert.deepEqual(store.get('operations.sqlite'), Buffer.from('db-fixture'));
});

test('readBackup rejects schema/param mismatches and unknown schemas', async t => {
  const dir = await temporary(t);
  const cases: [string, Buffer][] = [
    ['schema 2 but p=1', buildArchive({ schema: 2, N: 32768, p: 1, entries: STD })],
    ['schema 1 but p=3', buildArchive({ schema: 1, N: 32768, p: 3, entries: STD })],
    ['unknown schema 3', buildArchive({ schema: 3, N: 32768, p: 3, entries: STD })],
    ['weakened N', buildArchive({ schema: 2, N: 1024, p: 3, entries: STD })],
  ];
  for (const [name, bytes] of cases) {
    const path = join(dir, name.replace(/\W+/g, '_'));
    await writeFile(path, bytes);
    await assert.rejects(() => readAll(path), /지원하지 않는 백업 암호화 버전|인증·형식·무결성/, name);
  }
});

// ---------------------------------------------------------------------------
// F3: writer enforces the reader's structural invariants (fail loud at write time)
// ---------------------------------------------------------------------------

test('writeBackup rejects malformed entry structures and removes the partial file', async t => {
  const dir = await temporary(t);
  const db: BackupEntry = { kind: 'database', path: 'operations.sqlite', data: Buffer.from('db') };
  const man: BackupEntry = { kind: 'manifest', path: 'manifest.json', data: Buffer.from('{}') };
  const bad: [string, BackupEntry[]][] = [
    ['no manifest first', [db]],
    ['manifest but no database', [man, { kind: 'data', path: 'x.bin', data: Buffer.from('x') }]],
    ['two manifests', [man, man]],
    ['database at wrong path', [man, { kind: 'database', path: 'other.sqlite', data: Buffer.from('db') }]],
  ];
  for (const [name, entries] of bad) {
    const path = join(dir, name.replace(/\W+/g, '_') + '.appopsbackup');
    await assert.rejects(() => writeBackup(path, PASSWORD, entries), /구조가 올바르지 않습니다|중복/, name);
    assert.equal(existsSync(path), false, `${name}: partial file must be removed`);
  }
});

// ---------------------------------------------------------------------------
// F2: exact dedupe — case-distinct paths coexist, exact duplicates reject
// ---------------------------------------------------------------------------

test('writeBackup keeps case-distinct paths (case-sensitive trees stay backupable)', async t => {
  const dir = await temporary(t), archive = join(dir, 'case.appopsbackup');
  await writeBackup(archive, PASSWORD, [
    ...STD,
    { kind: 'data', path: 'Assets/Logo.png', data: Buffer.from('upper') },
    { kind: 'data', path: 'assets/logo.png', data: Buffer.from('lower') },
  ]);
  const store = await readAll(archive);
  assert.deepEqual(store.get('Assets/Logo.png'), Buffer.from('upper'));
  assert.deepEqual(store.get('assets/logo.png'), Buffer.from('lower'));
});

test('writeBackup rejects an exact duplicate path and removes the partial file', async t => {
  const dir = await temporary(t), archive = join(dir, 'dupe.appopsbackup');
  await assert.rejects(() => writeBackup(archive, PASSWORD, [
    ...STD,
    { kind: 'data', path: 'a/b.bin', data: Buffer.from('one') },
    { kind: 'data', path: 'a/b.bin', data: Buffer.from('two') },
  ]), /중복/);
  assert.equal(existsSync(archive), false);
});

// ---------------------------------------------------------------------------
// F12: data/file exclusivity
// ---------------------------------------------------------------------------

test('writeBackup rejects an entry that sets both data and file', async t => {
  const dir = await temporary(t), archive = join(dir, 'both.appopsbackup');
  const src = join(dir, 'src.bin'); await writeFile(src, 'file-source');
  await assert.rejects(
    () => writeBackup(archive, PASSWORD, [{ kind: 'manifest', path: 'manifest.json', data: Buffer.from('{}'), file: src }]),
    /동시에 지정할 수 없습니다/,
  );
  assert.equal(existsSync(archive), false);
});

// ---------------------------------------------------------------------------
// F14: path hygiene (traversal, control bytes, component length)
// ---------------------------------------------------------------------------

test('backupPath rejects hostile and out-of-bounds paths, accepts safe ones', () => {
  for (const p of ['../escape', '/abs', 'a/../b', 'a//b', 'C:\\x', 'con.txt', 'trailing ', 'trailing.', 'a\u0000b', 'a\u007fb', 'x'.repeat(2049), `${'n'.repeat(256)}/ok`]) {
    assert.throws(() => backupPath(p), /안전하지 않습니다/, p);
  }
  for (const p of ['manifest.json', 'artifacts/run-1/game.bin', 'Assets/Logo.png', `${'n'.repeat(255)}/ok`]) {
    assert.equal(backupPath(p), p);
  }
});

// ---------------------------------------------------------------------------
// Frame reorder + trailing garbage (AAD ordering + end-position binding)
// ---------------------------------------------------------------------------

function frameRanges(buf: Buffer): { start: number; end: number }[] {
  let off = 8; const hlen = buf.readUInt32BE(off); off += 4 + hlen; const ranges: { start: number; end: number }[] = [];
  while (off < buf.length) { const len = buf.readUInt32BE(off); const total = 4 + len + 16; ranges.push({ start: off, end: off + total }); off += total; }
  return ranges;
}

test('readBackup rejects two data frames swapped within one entry (AAD ordering binding)', async t => {
  const dir = await temporary(t), archive = join(dir, 'reorder.appopsbackup');
  // A 1.5 MiB entry produces two data frames (1 MiB + 0.5 MiB) to swap.
  await writeBackup(archive, PASSWORD, [...STD, { kind: 'data', path: 'artifacts/big.bin', data: randomBytes(CHUNK + CHUNK / 2) }]);
  const buf = await readFile(archive); const r = frameRanges(buf);
  // Layout: 0 man-meta,1 man-data,2 db-meta,3 db-data,4 big-meta,5 big-data0,6 big-data1,7 end.
  const a = r[5]!, b = r[6]!;
  const swapped = Buffer.concat([
    buf.subarray(0, a.start), buf.subarray(b.start, b.end), buf.subarray(a.end, b.start), buf.subarray(a.start, a.end), buf.subarray(b.end),
  ]);
  const path = join(dir, 'swapped.appopsbackup'); await writeFile(path, swapped);
  await assert.rejects(() => readAll(path));
});

test('readBackup rejects trailing garbage appended to a valid archive', async t => {
  const dir = await temporary(t), archive = join(dir, 'trail.appopsbackup');
  await writeBackup(archive, PASSWORD, STD);
  const path = join(dir, 'trailing.appopsbackup');
  await writeFile(path, Buffer.concat([await readFile(archive), Buffer.from([0, 1, 2, 3])]));
  await assert.rejects(() => readAll(path));
});

// ---------------------------------------------------------------------------
// Cancellation (writeBackup/readBackup {signal}) + sink.abort on error
// ---------------------------------------------------------------------------

test('writeBackup honors an already-aborted signal and writes no file', async t => {
  const dir = await temporary(t), archive = join(dir, 'pre-abort.appopsbackup');
  const c = new AbortController(); c.abort();
  await assert.rejects(() => writeBackup(archive, PASSWORD, STD, { signal: c.signal }), (e: { code?: string }) => e.code === 'BACKUP_CANCELLED');
  assert.equal(existsSync(archive), false);
});

test('writeBackup cancelled mid-stream rejects and removes the partial file', async t => {
  const dir = await temporary(t), archive = join(dir, 'mid-abort.appopsbackup');
  const c = new AbortController();
  async function* entries(): AsyncGenerator<BackupEntry> {
    yield { kind: 'manifest', path: 'manifest.json', data: Buffer.from('{}') };
    yield { kind: 'database', path: 'operations.sqlite', data: Buffer.from('db') };
    c.abort();
    yield { kind: 'data', path: 'never.bin', data: randomBytes(4096) };
  }
  await assert.rejects(() => writeBackup(archive, PASSWORD, entries(), { signal: c.signal }), (e: { code?: string }) => e.code === 'BACKUP_CANCELLED');
  assert.equal(existsSync(archive), false);
});

test('readBackup cancelled mid-read invokes sink.abort for the in-flight entry', async t => {
  const dir = await temporary(t), archive = join(dir, 'read-abort.appopsbackup');
  await writeBackup(archive, PASSWORD, [...STD, { kind: 'data', path: 'artifacts/big.bin', data: randomBytes(2 * CHUNK) }]);
  const c = new AbortController(); let aborted = 0;
  await assert.rejects(() => readBackup(archive, PASSWORD, async meta => ({
    write: async () => { if (meta.path === 'artifacts/big.bin') c.abort(); },
    finish: async () => {},
    abort: async () => { aborted += 1; },
  }), { signal: c.signal }), (e: { code?: string }) => e.code === 'BACKUP_CANCELLED');
  assert.equal(aborted, 1);
});

test('readBackup invokes sink.abort when a sink write throws (no descriptor leak)', async t => {
  const dir = await temporary(t), archive = join(dir, 'sink-throw.appopsbackup');
  await writeBackup(archive, PASSWORD, STD);
  let aborted = false;
  await assert.rejects(() => readBackup(archive, PASSWORD, async () => ({
    write: async () => { throw new Error('disk full'); },
    finish: async () => {},
    abort: async () => { aborted = true; },
  })), /disk full/);
  assert.equal(aborted, true);
});
