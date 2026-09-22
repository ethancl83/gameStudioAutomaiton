import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OUTPUT_CAP, acceptHelp, acceptVersion, argvShapeError, discardDiagnosticDirs, hasModelEvent, helpArgv, listenLoopback, parseArgs, productArgs, redact, runProcess, verifyMcpBoundary,
} from '../scripts/verify-agent-cli.js';

const directory = '/tmp/appops-cli-verify';

test('diagnostic argv is the product command plus help, with resume ids and without the bridge token', () => {
  const saved = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = '{';
  try {
    for (const provider of ['codex', 'opencode'] as const) {
      for (const kind of ['new', 'resume'] as const) {
        const args = helpArgv(productArgs(provider, kind, directory));
        assert.equal(argvShapeError(provider, kind, args), null);
        assert.equal(args.at(-1), '--help');
      }
    }
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, '{');
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = saved;
  }
});

test('help acceptance reads Codex stdout and OpenCode stderr, and rejects model events', () => {
  assert.equal(parseArgs(['--execute-model']).ok, false);
  assert.equal(parseArgs(['positional']).ok, false);
  assert.equal(parseArgs([]).ok, true);
  const codex = acceptHelp('codex', 'Usage: codex exec [OPTIONS]\n', '', 0);
  assert.equal(codex.ok, true);
  assert.equal(acceptHelp('codex', '', 'Usage: codex exec [OPTIONS]\n', 0).code, 'help-missing');
  const opencode = acceptHelp('opencode', '', 'opencode run [message..]\n--format\n--session\n', 0);
  assert.equal(opencode.ok, true);
  assert.equal(opencode.detail.includes('stderr'), true);
  assert.equal(acceptHelp('opencode', '', '', 0).code, 'help-missing');
  assert.equal(acceptHelp('codex', 'Usage: codex exec\n{"type":"thread.started","thread_id":"11111111-1111-4111-8111-111111111111"}\n', '', 0).code, 'model-event');
  assert.equal(hasModelEvent('plain help'), false);
  assert.equal(acceptVersion('codex', 'codex-cli 0.155.1\n', '', 0).detail, 'codex 0.155.1');
  assert.equal(acceptVersion('opencode', '1.18.31\n', '', 0).ok, true);
  assert.equal(acceptVersion('codex', '', 'not a version', 1).ok, false);
  assert.equal(redact('keep diagnostic-bridge-token out', ['diagnostic-bridge-token']).includes('diagnostic-bridge-token'), false);
});

test('process output keeps stderr when stdout is empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cli-fake-'));
  try {
    const executable = join(directory, 'fake-cli.mjs');
    await writeFile(executable, `#!/usr/bin/env node
process.stderr.write('opencode run\\n--format\\n--session\\n');
process.exit(0);
`);
    await chmod(executable, 0o700);
    const result = await runProcess(process.execPath, [executable], { cwd: directory, env: { PATH: process.env.PATH }, stdin: 'appops-cli-verify-fixture', timeoutMs: 5000 });
    const help = acceptHelp('opencode', result.stdout, result.stderr, result.code, result.timedOut);
    assert.equal(result.stdout, '');
    assert.equal(help.ok, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('process timeout and output cap stop the child', async () => {
  const hanging = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), env: { PATH: process.env.PATH }, timeoutMs: 200 });
  assert.equal(hanging.timedOut, true);
  assert.equal(hanging.capped, false);
  const capped = await runProcess(process.execPath, ['-e', `process.stdout.write('x'.repeat(${OUTPUT_CAP + 4096}))`], { cwd: tmpdir(), env: { PATH: process.env.PATH }, timeoutMs: 5000 });
  assert.equal(capped.capped, true);
  assert.equal(capped.stdout.length <= OUTPUT_CAP, true);
});

test('diagnostic directories remove only the two created paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'appops-cli-home-'));
  const work = await mkdtemp(join(tmpdir(), 'appops-cli-work-'));
  const sibling = await mkdtemp(join(tmpdir(), 'appops-cli-keep-'));
  try {
    await discardDiagnosticDirs(home, work);
    await assert.rejects(stat(home));
    await assert.rejects(stat(work));
    assert.equal((await stat(sibling)).isDirectory(), true);
  } finally { await rm(sibling, { recursive: true, force: true }); }
});

test('loopback listen failure rejects', async () => {
  const first = createServer();
  const port = await listenLoopback(first);
  const second = createServer();
  try { await assert.rejects(listenLoopback(second, port)); }
  finally { first.close(); second.close(); }
});

test('stdio MCP bridge initializes, lists tools, calls context, and rejects mutations', async () => {
  const check = await verifyMcpBoundary();
  assert.equal(check.ok, true, check.detail);
  assert.equal(check.code, 'mcp-ok');
});
