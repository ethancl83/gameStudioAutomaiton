import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zipSync } from 'fflate';
import { AppError } from '../packages/domain/errors.js';
import { ZIP_LIMITS, extractZip } from '../packages/setup/archive.js';
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

function tarHeader(options: {name: string; size: number; type?: string; mode?: string; linkname?: string; format?: 'ustar' | 'gnu'; prefix?: string; gnuRegion?: string}): Buffer {
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
  if (options.format === 'gnu') {
    header.write('ustar ', 257, 6, 'ascii');
    header[263] = 0x20;
    header[264] = 0;
    header.write(options.gnuRegion ?? '../not-prefix', 345, 80, 'utf8');
  } else {
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (options.prefix) header.write(options.prefix, 345, 155, 'utf8');
  }
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

const official = 'https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64.zip';

test('catalog pins official Godot 4.7.2 and Temurin 21 digests', () => {
  const godot = packageFor('godot', 'linux', 'x64');
  assert.equal(godot.url, official);
  assert.equal(godot.sha512, '9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65');
  const templates = packageFor('godot-templates', 'linux', 'x64');
  assert.equal(templates.sha512, 'ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079');
  const android = packageFor('android-sdk', 'linux', 'x64');
  assert.equal(android.sha256, '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583');
  const armGodot = packageFor('godot', 'linux', 'arm64');
  assert.equal(armGodot.name, 'Godot_v4.7.2-stable_linux.arm64.zip');
  assert.equal(armGodot.entry, 'Godot_v4.7.2-stable_linux.arm64');
  assert.equal(armGodot.sha512, 'dd59918da086bd49bde2f5450b5e567ff8650cbde9abbd7b8f4ca1197ff8c609baa38834666d032deafb47099078d7822279e2a0e06e5665745468f26533e7e2');
  assert.notEqual(armGodot.sha512, godot.sha512);
  const jdk = packageFor('jdk', 'linux', 'x64');
  assert.equal(jdk.sha256, 'ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94');
  assert.equal(jdk.archive, 'tar.gz');
  assert.equal(packageFor('jdk', 'win32', 'x64').archive, 'zip');
  assert.deepEqual(packageFor('jdk', 'win32', 'x64').expectedLayout, ['bin/java.exe', 'bin/javac.exe']);
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

test('extractTarGz accepts portable ustar, GNU, oldgnu and metadata-only PAX fixtures', async t => {
  // macOS bsdtar emits ustar and pax only. GNU and oldgnu share the "ustar " magic
  // and store atime where ustar stores a path prefix. These fixtures are that branch.
  const dir = await tempDir(t, 'appops-tar-formats-');
  const content = Buffer.from('executable fixture');
  const cases: Array<{name: string; bytes: Buffer}> = [
    {
      name: 'ustar',
      bytes: Buffer.concat([
        tarHeader({name: 'bin/java', size: content.length, mode: '0000755', prefix: 'jdk'}),
        content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024),
      ]),
    },
    {
      name: 'gnu',
      bytes: Buffer.concat([
        tarHeader({name: 'jdk/bin/java', size: content.length, mode: '0000755', format: 'gnu', gnuRegion: '../not-prefix'}),
        content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024),
      ]),
    },
    {
      name: 'oldgnu',
      bytes: Buffer.concat([
        tarHeader({name: 'jdk/bin/java', size: content.length, mode: '0000755', format: 'gnu', gnuRegion: '../oldgnu-atime'}),
        content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024),
      ]),
    },
  ];
  const metadata = paxRecord('mtime', '1700000000');
  cases.push({
    name: 'pax-metadata',
    bytes: Buffer.concat([
      tarHeader({name: 'PaxHeader', type: 'x', size: metadata.length}),
      metadata, Buffer.alloc((512 - (metadata.length % 512)) % 512),
      tarHeader({name: 'jdk/bin/java', size: content.length, mode: '0000755'}),
      content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024),
    ]),
  });
  for (const item of cases) {
    const archive = join(dir, `${item.name}.tar.gz`);
    await writeFile(archive, gzipSync(item.bytes));
    const destination = join(dir, `out-${item.name}`);
    await extractTarGz(archive, destination);
    assert.equal(await readFile(join(destination, 'jdk/bin/java'), 'utf8'), 'executable fixture', item.name);
    assert.equal((await lstat(join(destination, 'jdk/bin/java'))).mode & 0o700, 0o700, item.name);
  }
});

test('extractTarGz skips AppleDouble sidecars and still rejects other trailing-dot names', async t => {
  const dir = await tempDir(t, 'appops-appledouble-');
  const archive = join(dir, 'apple.tar.gz');
  await writeFile(archive, gzipSync(tarArchive([
    {name: '._.', content: Buffer.from('sidecar')},
    {name: './._sidecar', content: Buffer.from('sidecar')},
    {name: 'jdk/bin/java', content: Buffer.from('java-bin')},
  ])));
  await extractTarGz(archive, join(dir, 'out'));
  assert.equal(await readFile(join(dir, 'out/jdk/bin/java'), 'utf8'), 'java-bin');
  await assert.rejects(() => lstat(join(dir, 'out/._.')));
  await assert.rejects(() => lstat(join(dir, 'out/._sidecar')));
  const dotted = join(dir, 'dotted.tar.gz');
  await writeFile(dotted, gzipSync(tarArchive([{name: 'jdk/readme.', content: Buffer.from('no')}])));
  await assert.rejects(() => extractTarGz(dotted, join(dir, 'dotted')), (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'));

  const escape = join(dir, 'escape.tar.gz');
  await writeFile(escape, gzipSync(tarArchive([{name: '../._x', content: Buffer.from('no')}])));
  await assert.rejects(() => extractTarGz(escape, join(dir, 'escape')), (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'));

  const special = join(dir, 'special.tar.gz');
  await writeFile(special, gzipSync(Buffer.concat([
    tarHeader({name: '._x', size: 0, type: '6'}),
    Buffer.alloc(1024),
  ])));
  await assert.rejects(() => extractTarGz(special, join(dir, 'special')), (error: unknown) => expectCode(error, 'UNSAFE_ARCHIVE'));

  const huge = join(dir, 'huge.tar.gz');
  await writeFile(huge, gzipSync(Buffer.concat([
    tarHeader({name: '._huge', size: ZIP_LIMITS.file + 1}),
    Buffer.alloc(1024),
  ])));
  await assert.rejects(() => extractTarGz(huge, join(dir, 'huge')), (error: unknown) => expectCode(error, 'ARCHIVE_LIMIT'));
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
  let pkg;
  try { pkg = packageFor('android-sdk'); }
  catch (error) {
    if (error instanceof AppError && error.code === 'INSTALL_PLATFORM') return t.skip(error.message);
    throw error;
  }
  if (process.env.APPOPS_SKIP_LIVE_INSTALL === '1') return t.skip('APPOPS_SKIP_LIVE_INSTALL=1');
  const legacyLinux = process.platform === 'linux' && process.arch === 'x64';
  if (!legacyLinux && process.env.APPOPS_RUN_LIVE_DOWNLOAD !== '1') {
    return t.skip(`이 호스트의 Android cmdline 실다운로드는 APPOPS_RUN_LIVE_DOWNLOAD=1 입니다 (${process.platform}/${process.arch}).`);
  }
  assert.deepEqual(pkg.allowedHosts.slice(), [...GOOGLE_DL_HOSTS]);
  const dir = await mkdtemp(join(tmpdir(), 'appops-dl-verified-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const dest = join(dir, pkg.name);
  const started = Date.now();
  const evidence = join(process.cwd(), 'tmp/cross-platform-sdk-20260922/download-verified-cmdline.json');
  await mkdir(join(process.cwd(), 'tmp/cross-platform-sdk-20260922'), {recursive: true});
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
      fallback: pkg.name,
    }, null, 2)}\n`);
    if (/ECONN|ENOTFOUND|network|TLS|certificate|aborted/i.test(message)) {
      return t.skip(`official CDN unavailable: ${message}`);
    }
    throw error;
  }
});

function descriptorZip(payload: Buffer, method = 8, trailing = Buffer.alloc(0)): Buffer {
  const name = Buffer.from('lib/nested.jar');
  const compressed = Buffer.concat([method === 8 ? deflateRawSync(payload, { level: 0 }) : payload, trailing]);
  const checksum = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6);
  local.writeUInt16LE(method, 8); local.writeUInt16LE(name.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4);
  descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(payload.length, 12);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 8);
  central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length + descriptor.length, 16);
  return Buffer.concat([local, name, compressed, descriptor, central, name, end]);
}

test('ZIP extraction uses central ranges for nested JARs with data descriptors, stored and empty entries', async t => {
  const root = await tempDir(t, 'appops-zip-descriptor-');
  const payload = Buffer.from(zipSync({ 'inside.txt': Buffer.from('nested archive') }, { level: 0 }));
  for (const [index, [content, method]] of ([[payload, 8], [payload, 0], [Buffer.alloc(0), 0]] as const).entries()) {
    const archive = join(root, `${index}.zip`), output = join(root, `${index}`);
    await writeFile(archive, descriptorZip(content, method));
    await extractZip(archive, output);
    assert.deepEqual(await readFile(join(output, 'lib/nested.jar')), content);
  }
});

test('ZIP extraction rejects unused compressed bytes, local filename mismatch and corrupt CRC', async t => {
  const root = await tempDir(t, 'appops-zip-corrupt-');
  const payload = Buffer.from('verified payload');
  const cases = [descriptorZip(payload, 8, Buffer.from('junk')), descriptorZip(payload), descriptorZip(payload)];
  cases[1]![30] = 'X'.charCodeAt(0);
  const central = cases[2]!.readUInt32LE(cases[2]!.length - 6);
  cases[2]!.writeUInt32LE(0, central + 16);
  for (const [index, archive] of cases.entries()) {
    const path = join(root, `${index}.zip`); await writeFile(path, archive);
    await assert.rejects(extractZip(path, join(root, String(index))), { code: 'INVALID_ARCHIVE' });
  }
  const path = join(root, 'cancel.zip'); await writeFile(path, descriptorZip(payload));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(extractZip(path, join(root, 'cancelled'), abort.signal), { name: 'AbortError' });
  await assert.rejects(lstat(join(root, 'cancelled')), { code: 'ENOENT' });
});

test('ZIP extraction rejects out-of-bounds ranges, truncated streams and expanded-size mismatches', async t => {
  const root = await tempDir(t, 'appops-zip-ranges-');
  const cases = [descriptorZip(Buffer.from('payload')), descriptorZip(Buffer.from('payload')), descriptorZip(Buffer.from('payload'))];
  for (const [index, archive] of cases.entries()) {
    const central = archive.readUInt32LE(archive.length - 6);
    if (index === 0) archive.writeUInt32LE(central, central + 42);
    if (index === 1) archive.writeUInt32LE(archive.readUInt32LE(central + 20) - 1, central + 20);
    if (index === 2) archive.writeUInt32LE(1, central + 24);
    const path = join(root, `${index}.zip`); await writeFile(path, archive);
    await assert.rejects(extractZip(path, join(root, String(index))));
  }
});
