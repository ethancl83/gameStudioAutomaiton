import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/storage/index.js';
import { addMedia, mediaArtifact } from '../apps/controller/media.js';
import type { Project } from '../packages/domain/index.js';

test('media registration accepts GIF/MP4/MOV by signature, large videos by path, and re-verifies before use', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'appops-media-')); const store = new Store(join(directory, 'data'), { heartbeat: false });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.put('project', 'p', { id: 'p' } as Project);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
  assert.equal((await addMedia(store, { projectId: 'p', name: 'a.gif', base64: gif.toString('base64') })).mimeType, 'image/gif');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2_000_000, 1)]);
  await assert.rejects(addMedia(store, { projectId: 'p', name: 'a.mov', base64: mp4.toString('base64') }), { code: 'INVALID_IMAGE' }, 'extension must match signature');
  const file = join(directory, 'preview.mp4'); writeFileSync(file, mp4);
  const video = await addMedia(store, { projectId: 'p', path: file });
  assert.equal(video.mimeType, 'video/mp4'); assert.equal(video.size, mp4.length);
  const artifact = await mediaArtifact(store, 'p', video.id);
  assert.equal(artifact.sha256, video.sha256);
  await assert.rejects(addMedia(store, { projectId: 'p', path: 'relative.mp4' }), { code: 'INVALID_IMAGE' });
  const link = join(directory, 'link.mp4'); symlinkSync(file, link);
  await assert.rejects(addMedia(store, { projectId: 'p', path: link }), { code: 'INVALID_IMAGE' });
  const text = join(directory, 'secret.mp4'); writeFileSync(text, 'PRIVATE KEY');
  await assert.rejects(addMedia(store, { projectId: 'p', path: text }), { code: 'INVALID_IMAGE' }, 'non-media files are never copied');
  await assert.rejects(mediaArtifact(store, 'other', video.id), { code: 'MEDIA_MISMATCH' });
});
