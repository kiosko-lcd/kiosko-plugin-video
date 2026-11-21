import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createBaseContext, themeById } from '@kiosko/sdk';
import plugin, { FPS, clip, pickVideo } from './index.ts';
import { decodeArgs, filter, parseDuration } from './ffmpeg.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-ffmpeg.mjs', import.meta.url));
// The fake is a script run by its shebang: not on Windows.
const noFake = process.platform === 'win32' && 'the fake ffmpeg is a shebang script';
/** A real ffmpeg to try too (a path, or a wrapper around a container); skipped without one. */
const REAL = process.env.KIOSKO_FFMPEG;
const tmp = () => mkdtempSync(join(tmpdir(), 'kiosko-video-'));

test('ffmpeg’s duration line, in seconds; none for a stream', () => {
  assert.equal(parseDuration('  Duration: 00:01:02.50, start: 0.000000'), 62.5);
  assert.equal(parseDuration('  Duration: 01:00:00.00'), 3600);
  assert.equal(parseDuration('  Duration: N/A, bitrate: N/A'), null);
});

test('the filter makes exactly the panel’s size: cropped to fill, or padded to show it whole', () => {
  assert.equal(filter(1920, 462, 24, 'cover'), 'fps=24,scale=1920:462:force_original_aspect_ratio=increase:flags=bicubic,crop=1920:462,setsar=1');
  assert.equal(filter(480, 480, 12, 'contain'), 'fps=12,scale=480:480:force_original_aspect_ratio=decrease:flags=bicubic,pad=480:480:(ow-iw)/2:(oh-ih)/2:black,setsar=1');
  const args = decodeArgs('/v/a.mp4', 640, 172, 24, 'cover');
  assert.deepEqual(args.slice(args.indexOf('-f')), ['-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  assert.ok(args.includes('-an'), 'no audio decoded');
});

test('a file is itself; a folder gives one of its videos, the slot choosing which', () => {
  const dir = tmp();
  for (const f of ['b.mp4', 'a.webm', 'notes.txt', '.hidden.mp4', 'C.MOV']) writeFileSync(join(dir, f), 'x');
  mkdirSync(join(dir, 'sub.mp4'));
  assert.equal(pickVideo(join(dir, 'b.mp4'), 7), join(dir, 'b.mp4'));
  const picked = [0, 1, 2, 3].map((s) => pickVideo(dir, s)!.split(/[\\/]/).pop());
  assert.deepEqual(picked, ['C.MOV', 'a.webm', 'b.mp4', 'C.MOV']);
  assert.equal(pickVideo(join(dir, 'nope'), 0), null);
  const empty = tmp();
  assert.equal(pickVideo(empty, 0), null);
});

async function prepare(options: Record<string, unknown>, size = { width: 64, height: 16 }) {
  const logs: string[] = [];
  const base = createBaseContext({ now: Date.now(), log: (m) => logs.push(m), dataDir: tmp() });
  const player = await clip.prepare({ ...base, options: { source: '', fit: 'cover', bin: '', ...options } as never, ...size, seed: 0, theme: themeById(undefined), canvas: { createCanvas, loadImage } as never, sources: {} });
  return { player, logs };
}

test('no source, nothing in it, or no ffmpeg: it says why and doesn’t play', { skip: noFake }, async () => {
  assert.equal((await prepare({})).player, null);
  const empty = tmp();
  const none = await prepare({ source: empty });
  assert.equal(none.player, null);
  assert.match(none.logs.join('\n'), /nothing to play/);
  const dir = tmp();
  writeFileSync(join(dir, 'a.mp4'), 'x');
  const missing = await prepare({ source: join(dir, 'a.mp4'), bin: join(dir, 'no-such-ffmpeg') });
  assert.equal(missing.player, null);
  assert.match(missing.logs.join('\n'), /ffmpeg not found at/);
  writeFileSync(join(dir, 'broken.mp4'), 'x');
  const broken = await prepare({ source: join(dir, 'broken.mp4'), bin: FAKE });
  assert.equal(broken.player, null);
  assert.match(broken.logs.join('\n'), /cannot read .*Invalid data/);
});

test('it plays the video’s frames by the clock, skipping the ones a slow panel misses', { skip: noFake }, async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.mp4'), 'x');
  process.env.FAKE_DURATION = '2';
  const { player, logs } = await prepare({ source: join(dir, 'a.mp4'), bin: FAKE });
  assert.ok(player, logs.join('\n'));
  assert.equal(player.frames, 2 * FPS);
  const canvas = createCanvas(64, 16);
  const g = canvas.getContext('2d');
  const grey = () => g.getImageData(10, 5, 1, 1).data[0]!;
  await player.draw(g, 0);
  assert.equal(grey(), 0, 'the first frame first');
  // Half a second later the frame due is the 12th: the ones in between are skipped.
  await new Promise((r) => setTimeout(r, 500));
  await player.draw(g, 1);
  assert.ok(grey() >= 10 && grey() <= 14, `frame ${grey()} after 0.5 s`);
  await player.draw(g, player.frames - 1);
});

test('the plugin: one interlude, runs ffmpeg (downloading it if need be), reads the path given', () => {
  assert.equal(plugin.id, 'video');
  assert.deepEqual(plugin.interludes!.map((i) => i.id), ['clip']);
  assert.deepEqual(plugin.permissions, { exec: ['ffmpeg'], files: ['user'], network: ['github.com', 'release-assets.githubusercontent.com'] });
});

test('with a real ffmpeg: a generated clip comes out at the panel’s size', { skip: !REAL && 'set KIOSKO_FFMPEG to an ffmpeg' }, async () => {
  const dir = process.env.KIOSKO_FFMPEG_DIR ?? tmp();
  const { player, logs } = await prepare({ source: join(dir, 'clip.mp4'), bin: REAL!, fit: 'contain' }, { width: 320, height: 120 });
  assert.ok(player, logs.join('\n'));
  assert.ok(player.frames >= FPS, `${player.frames} frames`);
  const canvas = createCanvas(320, 120);
  const g = canvas.getContext('2d');
  await player.draw(g, 0);
  // Contain: a 4:3 clip in the middle of a wide panel, black on both sides.
  assert.deepEqual([...g.getImageData(5, 60, 1, 1).data], [0, 0, 0, 255]);
  assert.ok(g.getImageData(160, 60, 1, 1).data.slice(0, 3).some((v) => v > 30), 'the clip in the middle');
  await player.draw(g, player.frames - 1);
});
