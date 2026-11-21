/**
 * The user's ffmpeg, as Kiosko needs it: how long a video is, and its
 * pictures already at the panel's size, one RGBA frame after another,
 * through a pipe. Nothing is written to disk.
 */
import { type ChildProcess, spawn } from 'node:child_process';

export type Fit = 'contain' | 'cover';

/** Seconds, from ffmpeg's own report ("Duration: 00:01:02.50"); null when it says none (a stream). */
export function parseDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** How long the video lasts, asking ffmpeg itself (no ffprobe needed). */
export function probe(bin: string, file: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-20_000)));
    child.on('error', reject);
    // With no output file ffmpeg always exits with an error: what matters is what it said.
    child.on('close', () => {
      const d = parseDuration(err);
      if (d !== null) resolve(d);
      else if (/Invalid data|No such file|does not contain any stream|Permission denied/i.test(err)) reject(new Error(err.trim().split('\n').pop() ?? 'ffmpeg cannot read it'));
      else resolve(null);
    });
  });
}

/** The filter that turns any video into `fps` frames of exactly `width × height`. */
export function filter(width: number, height: number, fps: number, fit: Fit): string {
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=${fit === 'cover' ? 'increase' : 'decrease'}:flags=bicubic`;
  const shape = fit === 'cover' ? `crop=${width}:${height}` : `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
  return `fps=${fps},${scale},${shape},setsar=1`;
}

/**
 * Frames from a running ffmpeg, in order. Reads ahead a few and then lets
 * the pipe fill (ffmpeg waits), so a long video never piles up in memory.
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private have = 0;
  private ended = false;
  private wake: (() => void) | null = null;
  private stderr = '';
  readonly child: ChildProcess;
  readonly frameBytes: number;
  private readonly ahead: number;

  constructor(bin: string, args: string[], frameBytes: number, ahead = 3) {
    this.frameBytes = frameBytes;
    this.ahead = ahead;
    this.child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = this.child.stdout!;
    out.on('data', (b: Buffer) => {
      this.chunks.push(b);
      this.have += b.length;
      if (this.have >= this.frameBytes * this.ahead) out.pause();
      this.poke();
    });
    this.child.stderr!.on('data', (b: Buffer) => (this.stderr = (this.stderr + b.toString()).slice(-4000)));
    const end = () => {
      this.ended = true;
      this.poke();
    };
    out.on('end', end);
    this.child.on('error', (err) => {
      this.stderr += String(err.message);
      end();
    });
  }

  /** What ffmpeg said on stderr, last lines: for the log when there were no frames. */
  get said(): string {
    return this.stderr.trim().split('\n').slice(-2).join(' | ');
  }

  /** The next frame, or null once the video is over. */
  async next(): Promise<Buffer | null> {
    while (this.have < this.frameBytes) {
      if (this.ended) return null;
      this.child.stdout!.resume();
      await new Promise<void>((r) => (this.wake = r));
    }
    const frame = this.take(this.frameBytes);
    if (this.have < this.frameBytes * this.ahead) this.child.stdout!.resume();
    return frame;
  }

  /** Stops ffmpeg and lets go of it: Kiosko never waits for it, even one that ignores the signal. */
  close(): void {
    this.ended = true;
    this.poke();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.unref();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill();
    setTimeout(() => this.child.exitCode === null && this.child.signalCode === null && this.child.kill('SIGKILL'), 2000).unref();
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const k = Math.min(c.length, n - at);
      c.copy(out, at, 0, k);
      at += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.have -= n;
    return out;
  }
}

/** ffmpeg's arguments to decode `file` into RGBA frames on stdout. */
export function decodeArgs(file: string, width: number, height: number, fps: number, fit: Fit): string[] {
  return ['-hide_banner', '-v', 'error', '-nostdin', '-i', file, '-an', '-sn', '-vf', filter(width, height, fps, fit), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
}
