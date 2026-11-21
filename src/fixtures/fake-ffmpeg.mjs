#!/usr/bin/env node
// Stands in for ffmpeg in the tests. Asked about a file (`-i f` and nothing else) it reports a
// duration (FAKE_DURATION seconds) and exits 1, as ffmpeg does with no output; asked to decode,
// it writes FAKE_DURATION × fps raw RGBA frames of the -vf size, frame k all of grey k, opaque.
const args = process.argv.slice(2);
const file = args[args.indexOf('-i') + 1] ?? '';
if (file.includes('broken')) {
  process.stderr.write(`${file}: Invalid data found when processing input\n`);
  process.exit(1);
}
const seconds = Number(process.env.FAKE_DURATION ?? 2);
if (!args.includes('rawvideo')) {
  process.stderr.write(`Input #0, mov,mp4, from '${file}':\n  Duration: 00:00:${seconds.toFixed(2).padStart(5, '0')}, start: 0.000000, bitrate: 1000 kb/s\n`);
  process.exit(1);
}
const vf = args[args.indexOf('-vf') + 1];
const fps = Number(/fps=(\d+)/.exec(vf)[1]);
const [, w, h] = /scale=(\d+):(\d+)/.exec(vf).map(Number);
const frames = Math.round(seconds * fps);
let k = 0;
const write = () => {
  while (k < frames) {
    // Opaque, as ffmpeg's RGBA is: grey k.
    const f = Buffer.alloc(w * h * 4, 255);
    for (let i = 0; i < f.length; i += 4) f[i] = f[i + 1] = f[i + 2] = k % 256;
    k++;
    if (!process.stdout.write(f)) return process.stdout.once('drain', write);
  }
  process.stdout.end();
};
write();
