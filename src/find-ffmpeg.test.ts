import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { FFMPEG_STATIC, downloadDone, downloadFfmpeg, downloadedPath, findFfmpeg, onPath, systemKey } from './find-ffmpeg.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'kiosko-ffmpeg-'));
const posix = process.platform !== 'win32';

test('a build for every system Kiosko runs on, by the release’s names', () => {
  assert.equal(systemKey('win32', 'x64'), 'win32-x64');
  assert.equal(systemKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(systemKey('darwin', 'x64'), 'darwin-x64');
  assert.equal(systemKey('linux', 'arm'), 'linux-arm');
  assert.equal(systemKey('win32', 'arm64'), null);
  for (const sha of Object.values(FFMPEG_STATIC.sha256)) assert.match(sha, /^[0-9a-f]{64}$/);
});

test('the PATH is searched as a shell would', { skip: !posix && 'POSIX permissions' }, () => {
  const a = tmp(), b = tmp();
  writeFileSync(join(a, 'ffmpeg'), 'not executable');
  writeFileSync(join(b, 'ffmpeg'), '#!/bin/sh\n');
  chmodSync(join(b, 'ffmpeg'), 0o755);
  assert.equal(onPath('ffmpeg', `${a}:${b}`), join(b, 'ffmpeg'), 'skips the one that can’t run');
  assert.equal(onPath('ffmpeg', a), null);
  const w = tmp();
  writeFileSync(join(w, 'ffmpeg.exe'), 'MZ');
  assert.equal(onPath('ffmpeg', `C:\\nope;${w}`, 'win32'), join(w, 'ffmpeg.exe'));
});

test('the user’s ffmpeg first, then the PATH’s, then the one downloaded', { skip: !posix && 'POSIX permissions' }, () => {
  const data = tmp(), bin = tmp();
  const log = () => {};
  assert.deepEqual(findFfmpeg({ bin: '/opt/ff/ffmpeg', dataDir: data, log, path: '' }), { ready: true, bin: '/opt/ff/ffmpeg', from: 'option' });
  writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\n');
  chmodSync(join(bin, 'ffmpeg'), 0o755);
  assert.deepEqual(findFfmpeg({ bin: 'ffmpeg', dataDir: data, log, path: bin }), { ready: true, bin: join(bin, 'ffmpeg'), from: 'path' });
  mkdirSync(join(downloadedPath(data), '..'), { recursive: true });
  writeFileSync(downloadedPath(data), 'x');
  assert.deepEqual(findFfmpeg({ bin: '', dataDir: data, log, path: '' }), { ready: true, bin: downloadedPath(data), from: 'download' });
});

test('none anywhere, and no build for this system: it says to install one', () => {
  const r = findFfmpeg({ bin: '', dataDir: tmp(), log: () => {}, path: '', key: null });
  assert.equal(r.ready, false);
  assert.match((r as { reason: string }).reason, /install ffmpeg/);
});

test('the download: checked against its pinned SHA-256, unpacked, executable; a wrong one is refused', async () => {
  const program = Buffer.from('#!/bin/sh\necho fake ffmpeg\n');
  const gz = gzipSync(program);
  const table = { ...FFMPEG_STATIC, url: (k: string) => `https://example.test/${k}.gz`, sha256: { 'linux-x64': createHash('sha256').update(gz).digest('hex') } };
  const fake = (async () => new Response(gz)) as unknown as typeof fetch;
  const data = tmp();
  const at = await downloadFfmpeg(data, 'linux-x64', fake, table);
  assert.equal(at, downloadedPath(data));
  assert.deepEqual(readFileSync(at), program);
  if (posix) assert.ok(statSync(at).mode & 0o100, 'executable');
  const wrong = { ...table, sha256: { 'linux-x64': '0'.repeat(64) } };
  await assert.rejects(downloadFfmpeg(tmp(), 'linux-x64', fake, wrong), /does not match/);
});

test('nothing to run: the download starts in the background, and that time it doesn’t play', async () => {
  const logs: string[] = [];
  const failing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  const r = findFfmpeg({ bin: '', dataDir: tmp(), log: (m) => logs.push(m), get: failing, path: '', key: 'linux-x64' });
  assert.deepEqual(r, { ready: false, reason: 'downloading ffmpeg' });
  await downloadDone();
  assert.match(logs.join('\n'), /downloading ffmpeg 6\.1\.1 for linux-x64[\s\S]*download failed: HTTP 404/);
});
