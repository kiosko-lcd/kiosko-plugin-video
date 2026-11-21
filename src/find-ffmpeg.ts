/**
 * Which ffmpeg to run. Most Windows and Mac machines have none, so:
 *
 * 1. the one the user names in `bin`, if any;
 * 2. else `ffmpeg` on the PATH;
 * 3. else a copy this plugin downloaded once into its dataDir, from the
 *    ffmpeg-static project's GitHub release, checked against the SHA-256
 *    pinned here (computed when this version was written).
 *
 * The download starts the first time there is nothing to run, in the
 * background: that time the interlude doesn't play, the next ones do.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const FFMPEG_STATIC = {
  release: 'b6.1.1',
  /** ffmpeg 6.1.1 builds, gzipped, one per system (https://github.com/eugeneware/ffmpeg-static). */
  url: (key: string) => `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-${key}.gz`,
  sha256: {
    'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
    'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
    'linux-arm': '64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172',
    'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
  } as Record<string, string>,
};

export type FfmpegState = { ready: true; bin: string; from: 'option' | 'path' | 'download' } | { ready: false; reason: string };

/** The release's name for this system ("win32-x64", "darwin-arm64"…), or null when it has no build for it. */
export function systemKey(platform: string = process.platform, arch: string = process.arch): string | null {
  const key = `${platform}-${arch}`;
  return key in FFMPEG_STATIC.sha256 ? key : null;
}

const exe = (platform = process.platform) => (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

/** `name` on the PATH, as the shell would find it; null if it isn't there. */
export function onPath(name: string, path = process.env.PATH ?? process.env.Path ?? '', platform = process.platform): string | null {
  const names = platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of path.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const f = join(dir, n);
      try {
        if (!statSync(f).isFile()) continue;
        if (platform !== 'win32') accessSync(f, constants.X_OK);
        return f;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Where the downloaded copy lives. */
export const downloadedPath = (dataDir: string, platform = process.platform) => join(dataDir, `ffmpeg-${FFMPEG_STATIC.release}`, exe(platform));

let downloading: Promise<void> | null = null;
let lastError: string | null = null;

/** Waits for a download in progress (tests). */
export const downloadDone = () => downloading ?? Promise.resolve();

export async function downloadFfmpeg(dataDir: string, key: string, get: typeof fetch = fetch, table = FFMPEG_STATIC): Promise<string> {
  const expected = table.sha256[key];
  if (!expected) throw new Error(`no ffmpeg build for ${key}`);
  const res = await get(table.url(key), { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${table.url(key)}`);
  const gz = new Uint8Array(await res.arrayBuffer());
  if (createHash('sha256').update(gz).digest('hex') !== expected) throw new Error('the ffmpeg download does not match its pinned SHA-256');
  const target = downloadedPath(dataDir);
  // Written beside and renamed: a half-written file is never taken for a ready one.
  const tmp = `${target}.part`;
  await mkdir(join(target, '..'), { recursive: true });
  await rm(tmp, { force: true });
  await writeFile(tmp, gunzipSync(gz));
  await chmod(tmp, 0o755);
  await rename(tmp, target);
  return target;
}

/** The ffmpeg to run now, or why there is none yet (starting the download when that is the way). */
export function findFfmpeg(o: { bin: string; dataDir: string; log: (msg: string) => void; get?: typeof fetch; path?: string; key?: string | null }): FfmpegState {
  const bin = o.bin.trim();
  if (bin && bin !== 'ffmpeg') return { ready: true, bin, from: 'option' };
  const found = onPath('ffmpeg', o.path);
  if (found) return { ready: true, bin: found, from: 'path' };
  const own = downloadedPath(o.dataDir);
  if (existsSync(own)) return { ready: true, bin: own, from: 'download' };
  const key = o.key === undefined ? systemKey() : o.key;
  if (!key) return { ready: false, reason: `no ffmpeg on this system and no build to download for ${process.platform}-${process.arch}: install ffmpeg, or set its path` };
  if (!downloading) {
    lastError = null;
    o.log(`no ffmpeg here: downloading ffmpeg 6.1.1 for ${key} (about 30 MB) from GitHub`);
    downloading = downloadFfmpeg(o.dataDir, key, o.get)
      .then((p) => o.log(`ffmpeg ready in ${p}`))
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        o.log(`ffmpeg download failed: ${lastError}`);
      })
      .finally(() => (downloading = null));
  }
  return { ready: false, reason: lastError ?? 'downloading ffmpeg' };
}
