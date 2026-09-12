import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, lstat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zipSync } from 'fflate';
import { AppError } from '../packages/domain/errors.js';
import { extractZip } from '../packages/setup/archive.js';
import { GITHUB_RELEASE_HOSTS, GOOGLE_DL_HOSTS, packageFor } from '../packages/setup/catalog.js';
import { assertOfficialUrl, downloadVerified, expectedDecodedLength, extractTarGz } from '../packages/setup/download.js';

async function tempDir(t: { after: (fn: () => void | Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

function expectCode(error: unknown, code: string): boolean {
  return error instanceof AppError && error.code === code;
}

function tarHeader(options: {name: string; size: number; type?: string; mode?: string; linkname?: string}): Buffer {
  const header = Buffer.alloc(512);
  header.write(options.name, 0, 100, 'utf8');
  header.write((options.mode ?? '0000644').slice(-7) + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(options.size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(options.type ?? '0', 156, 1, 'ascii');
  if (options.linkname) header.write(options.linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarArchive(entries: {name: string; content?: Buffer; type?: string; linkname?: string}[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    parts.push(tarHeader({name: entry.name, size: content.length, type: entry.type, linkname: entry.linkname}), content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const official = 'https://github.com/godotengine/godot-builds/releases/download/4.3-stable/Godot_v4.3-stable_linux.x86_64.zip';

test('catalog pins official Godot 4.3 and Temurin 21 digests', () => {
  const godot = packageFor('godot', 'linux', 'x64');
  assert.equal(godot.url, official);
  assert.equal(godot.sha512, 'fd52bb4ba8acc30ca5accd1c566d470ad7282f891ccc0995dfafabcf92bcf76280ce182bf9d80ebd885f3ed2165d01e1fc3f2928436b15498dfbd98656c2a45a');
  const templates = packageFor('godot-templates', 'linux', 'x64');
  assert.equal(templates.sha512, '476366caf0fd45a8f24136cf9cf1dc0bc2b96f7c82d53e5f82200b55aefd07b286d283fd6f1ce29e0de70648c5a51d3b12f96c6d4fafd4e8c4878ecda6406d6a');
  const android = packageFor('android-sdk', 'linux', 'x64');
  assert.equal(android.sha256, '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583');
  const jdk = packageFor('jdk', 'linux', 'x64');
  assert.equal(jdk.sha256, 'ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94');
  assert.equal(jdk.archive, 'tar.gz');
  assert.equal(packageFor('jdk', 'win32', 'x64').archive, 'zip');
  assert.throws(() => packageFor('unity'), (error: unknown) => expectCode(error, 'MANUAL_INSTALL'));
  assert.throws(() => packageFor('gradle-cache'), (error: unknown) => expectCode(error, 'MANUAL_INSTALL'));
});

test('official URL policy rejects local, IP, http, userinfo and off-allowlist hosts', () => {
  const hosts = GITHUB_RELEASE_HOSTS;
  assert.equal(assertOfficialUrl(official, hosts).hostname, 'github.com');
  for (const url of [
    'http://github.com/x',
    'https://127.0.0.1/x',
    'https://192.168.0.8/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://user:pass@github.com/x',
    'https://evil.example/x',
    'https://github.com.evil.example/x',
    'file:///etc/passwd',
    'https://8.8.8.8/x',
    'https://github.com:8443/x',
  ]) {
    assert.throws(() => assertOfficialUrl(url, hosts), (error: unknown) => expectCode(error, 'UNOFFICIAL_URL'), url);
  }
});

test('download verifies digest, follows official redirects, and rejects bad hops', async t => {
  const dir = await tempDir(t, 'appops-dl-');
  const body = Buffer.from('fixture-bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const dest = join(dir, 'ok.bin');

  const okFetch: typeof fetch = async input => {
    const url = String(input);
    if (url === official) return new Response(null, {status: 302, headers: {location: 'https://objects.githubusercontent.com/github-production-release-asset/file.bin'}});
    if (url.startsWith('https://objects.githubusercontent.com/')) {
      return new Response(body, {status: 200, headers: {'content-length': String(body.length)}});
    }
    throw new Error(url);
  };
  const result = await downloadVerified({
    url: official, destination: dest, sha256, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: okFetch,
  });
  assert.equal(result.sha256, sha256);
  assert.equal(await readFile(dest, 'utf8'), 'fixture-bytes');

  const wrong = createHash('sha256').update('other').digest('hex');
  await assert.rejects(
    () => downloadVerified({url: official, destination: join(dir, 'bad.bin'), sha256: wrong, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: okFetch}),
    (error: unknown) => expectCode(error, 'DIGEST_MISMATCH'),
  );

  for (const location of ['https://127.0.0.1/stolen', 'https://192.168.1.8/stolen', 'http://objects.githubusercontent.com/x', 'https://evil.example/x', 'https://[::1]/x']) {
    const fetcher: typeof fetch = async () => new Response(null, {status: 302, headers: {location}});
    await assert.rejects(
      () => downloadVerified({url: official, destination: join(dir, 'redir.bin'), sha256, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: fetcher}),
      (error: unknown) => expectCode(error, 'UNOFFICIAL_URL'),
      location,
    );
  }
});

test('decoded gzip body is compared to identity length, not compressed Content-Length', async t => {
  const dir = await tempDir(t, 'appops-dl-gzip-');
  const body = Buffer.from('decompressed-publisher-bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const dest = join(dir, 'ok.bin');
  const gzipFetch: typeof fetch = async () => new Response(body, {
    status: 200,
    headers: {
      'content-encoding': 'gzip',
      'content-length': '9',
      'x-identity-content-length': String(body.length),
    },
  });
  const headers = new Headers({
    'content-encoding': 'gzip',
    'content-length': '9',
    'x-identity-content-length': String(body.length),
  });
  assert.equal(expectedDecodedLength(headers), body.length);
  const result = await downloadVerified({
    url: official, destination: dest, sha256, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: gzipFetch,
  });
  assert.equal(result.bytes, body.length);
  assert.equal(result.sha256, sha256);
  assert.equal(await readFile(dest, 'utf8'), 'decompressed-publisher-bytes');
});

test('truncated download resumes with Content-Range and If-Range, and 200 restarts instead of appending', async t => {
  const dir = await tempDir(t, 'appops-dl-resume-');
  const body = Buffer.from('abcdefghij0123456789');
  const sha256 = createHash('sha256').update(body).digest('hex');
  let resumeHeaders: string[] = [];
  let first = true;
  const resumeFetch: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (first) {
      first = false;
      return new Response(body.subarray(0, 8), {
        status: 200,
        headers: {'content-length': String(body.length), etag: '"part1"'},
      });
    }
    resumeHeaders.push(`${headers.get('range')}|${headers.get('if-range')}|${headers.get('accept-encoding')}`);
    if (headers.get('range') !== 'bytes=8-' || headers.get('if-range') !== '"part1"') {
      return new Response(null, {status: 416});
    }
    return new Response(body.subarray(8), {
      status: 206,
      headers: {
        'content-range': `bytes 8-${body.length - 1}/${body.length}`,
        'content-length': String(body.length - 8),
        etag: '"part1"',
      },
    });
  };
  const dest = join(dir, 'resumed.bin');
  const result = await downloadVerified({
    url: official, destination: dest, sha256, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: resumeFetch,
  });
  assert.equal(result.bytes, body.length);
  assert.equal(await readFile(dest, 'utf8'), body.toString());
  assert.equal(resumeHeaders[0], 'bytes=8-|"part1"|identity');

  let round = 0;
  const restartFetch: typeof fetch = async () => {
    round += 1;
    if (round === 1) {
      return new Response(body.subarray(0, 6), {status: 200, headers: {'content-length': String(body.length), etag: '"v1"'}});
    }
    return new Response(body, {status: 200, headers: {'content-length': String(body.length), etag: '"v1"'}});
  };
  const restarted = join(dir, 'restarted.bin');
  const second = await downloadVerified({
    url: official, destination: restarted, sha256, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: restartFetch,
  });
  assert.equal(second.bytes, body.length);
  assert.equal(await readFile(restarted, 'utf8'), body.toString());
});

test('digest mismatch and cancel remove partials and never leave an installed file', async t => {
  const dir = await tempDir(t, 'appops-dl-fail-');
  const body = Buffer.from('fixture-bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const wrong = createHash('sha256').update('other').digest('hex');
  const dest = join(dir, 'bad.bin');
  const fetchOk: typeof fetch = async () => new Response(body, {status: 200, headers: {'content-length': String(body.length)}});
  await assert.rejects(
    () => downloadVerified({url: official, destination: dest, sha256: wrong, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: fetchOk}),
    (error: unknown) => expectCode(error, 'DIGEST_MISMATCH'),
  );
  await assert.rejects(() => lstat(dest));
  await assert.rejects(() => lstat(dest + '.partial'));

  const controller = new AbortController();
  const destCancel = join(dir, 'cancel.bin');
  const slow: typeof fetch = async (_input, init) => {
    const abort = (): void => controller.abort();
    init?.signal?.addEventListener('abort', abort, {once: true});
    return new Response(new ReadableStream({
      start(publisher) {
        publisher.enqueue(body.subarray(0, 4));
        setTimeout(() => controller.abort(), 20);
      },
    }), {status: 200, headers: {'content-length': '100000'}});
  };
  await assert.rejects(
    () => downloadVerified({
      url: official, destination: destCancel, sha256, maxBytes: 1024 * 1024, allowedHosts: GITHUB_RELEASE_HOSTS,
      fetch: slow, signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  await assert.rejects(() => lstat(destCancel));
  await assert.rejects(() => lstat(destCancel + '.partial'));
});

test('invalid Content-Range and 404 do not append or leave an installed file', async t => {
  const dir = await tempDir(t, 'appops-dl-range-');
  const body = Buffer.from('abcdefghij0123456789');
  const sha256 = createHash('sha256').update(body).digest('hex');
  let n = 0;
  const badRange: typeof fetch = async () => {
    n += 1;
    if (n === 1) {
      return new Response(body.subarray(0, 8), {status: 200, headers: {'content-length': String(body.length), etag: '"x"'}});
    }
    return new Response(body.subarray(4), {
      status: 206,
      headers: {'content-range': `bytes 4-${body.length - 1}/${body.length}`, etag: '"x"'},
    });
  };
  const dest = join(dir, 'range.bin');
  await assert.rejects(
    () => downloadVerified({url: official, destination: dest, sha256, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: badRange}),
    (error: unknown) => expectCode(error, 'DOWNLOAD_FAILED'),
  );
  await assert.rejects(() => lstat(dest));

  const missing: typeof fetch = async () => new Response(null, {status: 404});
  await assert.rejects(
    () => downloadVerified({url: official, destination: join(dir, 'none.bin'), sha256, maxBytes: 1024, allowedHosts: GITHUB_RELEASE_HOSTS, fetch: missing}),
    (error: unknown) => expectCode(error, 'DOWNLOAD_FAILED'),
  );
});

test('extractZip rejects traversal, absolute paths, and writes a safe archive', async t => {
  const dir = await tempDir(t, 'appops-zip-');
  const safeZip = join(dir, 'safe.zip');
  await writeFile(safeZip, zipSync({'bin/tool': Buffer.from('ok')}));
  await extractZip(safeZip, join(dir, 'out'));
  assert.equal(await readFile(join(dir, 'out', 'bin', 'tool'), 'utf8'), 'ok');

  for (const name of ['../evil', '/tmp/evil', 'C:/windows/evil', 'a/../../b']) {
    const archive = join(dir, Buffer.from(name).toString('hex') + '.zip');
    await writeFile(archive, zipSync({[name]: Buffer.from('x')}));
    await assert.rejects(() => extractZip(archive, join(dir, 'x-' + Buffer.from(name).toString('hex'))), (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'), name);
  }
});

test('extractTarGz writes regular files and rejects traversal, symlink and hardlink', async t => {
  const dir = await tempDir(t, 'appops-tar-');
  const safe = join(dir, 'safe.tar.gz');
  await writeFile(safe, gzipSync(tarArchive([
    {name: 'jdk-21/bin/', type: '5'},
    {name: 'jdk-21/bin/java', content: Buffer.from('java-bin'), type: '0'},
  ])));
  await extractTarGz(safe, join(dir, 'jdk'));
  assert.equal(await readFile(join(dir, 'jdk', 'jdk-21', 'bin', 'java'), 'utf8'), 'java-bin');
  assert.equal((await lstat(join(dir, 'jdk', 'jdk-21', 'bin', 'java'))).isFile(), true);

  const symlink = join(dir, 'link.tar.gz');
  await writeFile(symlink, gzipSync(tarArchive([{name: 'link', type: '2', linkname: '/etc/passwd'}])));
  await assert.rejects(() => extractTarGz(symlink, join(dir, 'from-link')), (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'));

  const hard = join(dir, 'hard.tar.gz');
  await writeFile(hard, gzipSync(tarArchive([{name: 'hard', type: '1', linkname: 'other'}])));
  await assert.rejects(() => extractTarGz(hard, join(dir, 'from-hard')), (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'));

  const escape = join(dir, 'esc.tar.gz');
  await writeFile(escape, gzipSync(tarArchive([{name: '../outside', content: Buffer.from('no')}])));
  await assert.rejects(() => extractTarGz(escape, join(dir, 'from-esc')), (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'));
});

test('extractTarGz accepts real GNU, oldgnu, PAX and ustar archives including metadata-only PAX', {skip: process.platform !== 'linux'}, async t => {
  const dir = await tempDir(t, 'appops-tar-formats-');
  const source = join(dir, 'source');
  await mkdir(join(source, 'jdk', 'bin'), {recursive: true});
  await writeFile(join(source, 'jdk', 'bin', 'java'), 'executable fixture', {mode: 0o700});
  for (const format of ['gnu', 'oldgnu', 'pax', 'ustar']) {
    const archive = join(dir, `${format}.tar.gz`);
    await promisify(execFile)('/usr/bin/tar', [`--format=${format}`, '-czf', archive, '-C', source, '.']);
    const destination = join(dir, `out-${format}`);
    await extractTarGz(archive, destination);
    assert.equal(await readFile(join(destination, 'jdk/bin/java'), 'utf8'), 'executable fixture');
    assert.equal((await lstat(join(destination, 'jdk/bin/java'))).mode & 0o700, 0o700);
  }
});

function paxRecord(key: string, value: string): Buffer {
  const suffix = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(suffix) + 1;
  while (String(length).length + Buffer.byteLength(suffix) !== length) length = String(length).length + Buffer.byteLength(suffix);
  return Buffer.from(`${length}${suffix}`);
}

test('PAX uses byte lengths for Unicode names and effective size for following-header alignment', async t => {
  const dir = await tempDir(t, 'appops-pax-bytes-');
  const metadata = Buffer.concat([paxRecord('path', 'jdk/한글 파일.txt'), paxRecord('size', '3')]);
  const content = Buffer.from('abc');
  const bytes = Buffer.concat([
    tarHeader({name: 'PaxHeader', type: 'x', size: metadata.length}), metadata, Buffer.alloc(512 - metadata.length),
    tarHeader({name: 'unused-name', size: 0}), content, Buffer.alloc(509),
    tarArchive([{name: 'jdk/next.txt', content: Buffer.from('next')}]),
  ]);
  const archive = join(dir, 'pax.tar.gz');
  await writeFile(archive, gzipSync(bytes));
  await extractTarGz(archive, join(dir, 'out'));
  assert.equal(await readFile(join(dir, 'out/jdk/한글 파일.txt'), 'utf8'), 'abc');
  assert.equal(await readFile(join(dir, 'out/jdk/next.txt'), 'utf8'), 'next');

  const bad = join(dir, 'malformed.tar.gz');
  await writeFile(bad, gzipSync(tarArchive([{name: 'PaxHeader', type: 'x', content: Buffer.from('999 path=other\n')}])));
  await assert.rejects(() => extractTarGz(bad, join(dir, 'bad')), (error: unknown) => expectCode(error, 'INVALID_ARCHIVE'));
});

test('verified tool archives materialize internal license links without creating filesystem links', async t => {
  const dir = await tempDir(t, 'appops-tool-links-');
  const archive = join(dir, 'jdk.tar.gz');
  await writeFile(archive, gzipSync(tarArchive([
    {name: 'jdk/legal/module/LICENSE', type: '2', linkname: '../base/LICENSE'},
    {name: 'jdk/legal/alias', type: '1', linkname: 'jdk/legal/module/LICENSE'},
    {name: 'jdk/legal/base/LICENSE', content: Buffer.from('license text')},
  ])));
  const out = join(dir, 'out');
  await extractTarGz(archive, out, undefined, {materializeInternalLinks: true});
  assert.equal(await readFile(join(out, 'jdk/legal/alias'), 'utf8'), 'license text');
  assert.equal((await lstat(join(out, 'jdk/legal/module/LICENSE'))).isSymbolicLink(), false);
  for (const [name, entries] of Object.entries({
    escape: [{name: 'jdk/link', type: '2', linkname: '../../outside'}],
    cycle: [{name: 'jdk/a', type: '2', linkname: 'b'}, {name: 'jdk/b', type: '2', linkname: 'a'}],
    directory: [{name: 'jdk/folder/', type: '5'}, {name: 'jdk/link', type: '2', linkname: 'folder'}],
  })) {
    const bad = join(dir, name + '.tar.gz');
    await writeFile(bad, gzipSync(tarArchive(entries)));
    await assert.rejects(() => extractTarGz(bad, join(dir, name), undefined, {materializeInternalLinks: true}),
      (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'));
  }
});

test('downloadVerified pulls the pinned Android command-line tools zip through Node fetch', {timeout: 180_000}, async t => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return t.skip('linux x64 host required');
  if (process.env.APPOPS_SKIP_LIVE_INSTALL === '1') return t.skip('APPOPS_SKIP_LIVE_INSTALL=1');
  const pkg = packageFor('android-sdk', 'linux', 'x64');
  assert.deepEqual(pkg.allowedHosts.slice(), [...GOOGLE_DL_HOSTS]);
  const dir = await mkdtemp(join('/tmp', 'appops-dl-verified-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const dest = join(dir, pkg.name);
  const started = Date.now();
  const evidence = join('/tmp', 'appops-download-verified-cmdline.json');
  try {
    const result = await downloadVerified({
      url: pkg.url, destination: dest, sha256: pkg.sha256, maxBytes: pkg.maxBytes, allowedHosts: pkg.allowedHosts,
    });
    const info = await lstat(dest);
    const report = {
      ok: true, url: pkg.url, sha256: result.sha256, bytes: result.bytes, size: info.size,
      ms: Date.now() - started, dest, fetch: 'node-fetch-downloadVerified', injected: false,
    };
    await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
    t.diagnostic(`real-download bytes=${result.bytes} sha256=${result.sha256} ms=${report.ms}`);
    assert.equal(result.sha256, pkg.sha256);
    assert.equal(result.bytes, info.size);
    assert.ok(info.size > 100_000_000, `zip too small: ${info.size}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(evidence, `${JSON.stringify({
      ok: false, url: pkg.url, error: message, ms: Date.now() - started, fetch: 'node-fetch-downloadVerified',
      fallback: '/tmp/appops-cmdline-15859902.zip',
    }, null, 2)}\n`);
    if (/ECONN|ENOTFOUND|network|TLS|certificate|aborted/i.test(message)) {
      return t.skip(`official CDN unavailable: ${message}`);
    }
    throw error;
  }
});
