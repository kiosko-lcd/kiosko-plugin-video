/**
 * Your own videos as an interlude: a clip, or one from a folder (a different
 * one each time slot), played on the whole panel. The user's ffmpeg decodes
 * it straight to the panel's size; nothing is copied or converted to disk.
 */
import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { defineInterlude, definePlugin, t } from '@kiosko/sdk';
import { FrameReader, decodeArgs, probe, type Fit } from './ffmpeg.ts';
import { findFfmpeg } from './find-ffmpeg.ts';

/** Frames per second asked of ffmpeg; the screen plays at most its own `maxFps`. */
export const FPS = 24;
/** The runtime cuts at the slot's `maxSeconds` (600 at most): the ceiling for a video of unknown length. */
const MAX_FRAMES = 600 * FPS;
export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.gif', '.mpg', '.mpeg', '.ts'];

/** The file to play: `source` itself, or one of the videos in it, chosen by the slot's seed. */
export function pickVideo(source: string, seed: number): string | null {
  const st = statSync(source, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isFile()) return source;
  if (!st.isDirectory()) return null;
  const videos = readdirSync(source)
    .filter((f) => !f.startsWith('.') && VIDEO_EXTENSIONS.includes(extname(f).toLowerCase()) && statSync(join(source, f), { throwIfNoEntry: false })?.isFile())
    .sort();
  return videos.length ? join(source, videos[Math.abs(Math.floor(seed)) % videos.length]!) : null;
}

const home = () => process.env.HOME ?? process.env.USERPROFILE ?? '~';
const expand = (p: string) => p.trim().replace(/^~(?=$|[\\/])/, home());

export const clip = defineInterlude({
  id: 'clip',
  name: { en: 'Your videos', es: 'Tus vídeos', de: 'Deine Videos', 'zh-Hans': '你的视频', 'zh-Hant': '你的影片' },
  description: {
    en: 'A video of yours on the whole panel: one file, or a folder of them (a different one each time). Uses your ffmpeg, or downloads one the first time.',
    es: 'Un vídeo tuyo en todo el panel: un archivo, o una carpeta de ellos (cada vez uno distinto). Usa tu ffmpeg, o descarga uno la primera vez.',
    de: 'Ein eigenes Video auf dem ganzen Panel: eine Datei oder ein Ordner voller Videos (jedes Mal ein anderes). Nutzt dein ffmpeg oder lädt beim ersten Mal eines herunter.',
    'zh-Hans': '在整个面板上播放你自己的视频：一个文件，或一个文件夹（每次换一个）。使用你的 ffmpeg，没有则首次自动下载。',
    'zh-Hant': '在整個面板上播放你自己的影片：一個檔案，或一個資料夾（每次換一個）。使用你的 ffmpeg，沒有則第一次自動下載。',
  },
  icon: 'clapperboard',
  fps: FPS,
  options: t.object({
    source: t.string({
      default: '',
      format: 'path',
      risk: 'path',
      label: { en: 'Video or folder', es: 'Vídeo o carpeta', de: 'Video oder Ordner', 'zh-Hans': '视频或文件夹', 'zh-Hant': '影片或資料夾' },
      help: {
        en: 'A video file (mp4, webm, mkv, mov, gif…), or a folder: then a different one of its videos each time.',
        es: 'Un archivo de vídeo (mp4, webm, mkv, mov, gif…), o una carpeta: entonces, cada vez uno de sus vídeos.',
        de: 'Eine Videodatei (mp4, webm, mkv, mov, gif…) oder ein Ordner: dann jedes Mal eines seiner Videos.',
        'zh-Hans': '一个视频文件（mp4、webm、mkv、mov、gif…），或一个文件夹：每次播放其中不同的一个。',
        'zh-Hant': '一個影片檔（mp4、webm、mkv、mov、gif…），或一個資料夾：每次播放其中不同的一個。',
      },
      placeholder: '~/Videos/panel',
    }),
    fit: t.enum(['cover', 'contain'], {
      default: 'cover',
      label: { en: 'Fit', es: 'Encaje', de: 'Einpassen', 'zh-Hans': '填充方式', 'zh-Hant': '填滿方式' },
      labels: {
        cover: { en: 'Fill the panel (crop)', es: 'Llenar el panel (recortar)', de: 'Panel füllen (beschneiden)', 'zh-Hans': '铺满面板（裁剪）', 'zh-Hant': '鋪滿面板（裁切）' },
        contain: { en: 'Whole video (black bars)', es: 'Vídeo entero (bandas negras)', de: 'Ganzes Video (schwarze Balken)', 'zh-Hans': '完整视频（黑边）', 'zh-Hant': '完整影片（黑邊）' },
      },
    }),
    bin: t.string({
      default: '',
      risk: 'exec',
      advanced: true,
      label: { en: 'ffmpeg', es: 'ffmpeg', de: 'ffmpeg', 'zh-Hans': 'ffmpeg', 'zh-Hant': 'ffmpeg' },
      help: {
        en: 'The ffmpeg program to use, by its full path. Empty: the one on the PATH, or else one downloaded once (about 30 MB).',
        es: 'El programa ffmpeg que usar, con su ruta completa. Vacío: el del PATH, o si no, uno descargado una vez (unos 30 MB).',
        de: 'Das zu verwendende ffmpeg mit vollständigem Pfad. Leer: das im PATH, sonst eines, das einmal heruntergeladen wird (etwa 30 MB).',
        'zh-Hans': '要使用的 ffmpeg 程序的完整路径。留空：使用 PATH 中的；没有则下载一次（约 30 MB）。',
        'zh-Hant': '要使用的 ffmpeg 程式的完整路徑。留空：使用 PATH 中的；沒有則下載一次（約 30 MB）。',
      },
    }),
  }),
  async prepare(ctx) {
    const say = (msg: string) => ctx.log(`video: ${msg}`);
    const source = expand(ctx.options.source);
    if (!source) {
      say('no video or folder set');
      return null;
    }
    const file = pickVideo(source, ctx.seed);
    if (!file) {
      say(`nothing to play in ${source}`);
      return null;
    }
    const ff = findFfmpeg({ bin: expand(ctx.options.bin), dataDir: ctx.dataDir, log: say });
    if (!ff.ready) {
      say(`not playing: ${ff.reason}`);
      return null;
    }
    const bin = ff.bin;
    let seconds: number | null;
    try {
      seconds = await probe(bin, file, AbortSignal.timeout(15_000));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      say(e.code === 'ENOENT' ? `ffmpeg not found at "${bin}": fix its path in the interlude's options, or leave it empty` : `cannot read ${file}: ${e.message}`);
      return null;
    }
    const { width, height } = ctx;
    const frames = seconds ? Math.max(1, Math.min(MAX_FRAMES, Math.ceil(seconds * FPS))) : MAX_FRAMES;
    const reader = new FrameReader(bin, decodeArgs(file, width, height, FPS, ctx.options.fit as Fit), width * height * 4);
    say(`playing ${file}${seconds ? ` (${seconds.toFixed(1)} s)` : ''}`);
    const image = ctx.canvas.createCanvas(width, height).getContext('2d').createImageData(width, height);
    let t0 = 0;
    let shown = -1;
    let last: Buffer | null = null;
    // Cut short (another slot, the user stopped it): ffmpeg goes once nobody asks.
    let idle: NodeJS.Timeout | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => reader.close(), 10_000);
      idle.unref();
    };
    return {
      frames,
      async draw(g, i) {
        touch();
        if (i === 0) {
          // The clock starts with the first picture, not with ffmpeg starting.
          last = await reader.next();
          shown = last ? 0 : -1;
          t0 = Date.now();
        }
        // The frame due now, by the clock: a panel slower than the video skips frames, never slows it.
        const due = Math.min(frames - 1, Math.floor(((Date.now() - t0) * FPS) / 1000));
        while (shown < due) {
          const f = await reader.next();
          if (!f) break;
          last = f;
          shown++;
        }
        if (last) {
          image.data.set(last);
          g.putImageData(image, 0, 0);
        } else {
          g.fillStyle = '#000';
          g.fillRect(0, 0, width, height);
          if (i === 0) say(`no picture from ffmpeg: ${reader.said}`);
        }
        if (i >= frames - 1) {
          if (idle) clearTimeout(idle);
          reader.close();
        }
      },
    };
  },
});

export default definePlugin({
  id: 'video',
  name: { en: 'Video', es: 'Vídeo', de: 'Video', 'zh-Hans': '视频', 'zh-Hant': '影片' },
  version: '0.1.0',
  description: {
    en: 'Your own videos as an interlude, on the whole panel, decoded by your ffmpeg to the panel’s size.',
    es: 'Tus propios vídeos como interludio, en todo el panel, decodificados por tu ffmpeg al tamaño del panel.',
    de: 'Deine eigenen Videos als Zwischenspiel, auf dem ganzen Panel, von deinem ffmpeg auf Panelgröße dekodiert.',
    'zh-Hans': '把你自己的视频作为插曲在整个面板上播放，由你的 ffmpeg 解码成面板的尺寸。',
    'zh-Hant': '把你自己的影片當作插曲在整個面板上播放，由你的 ffmpeg 解碼成面板的尺寸。',
  },
  author: 'Loksly',
  license: 'MIT',
  homepage: 'https://github.com/kiosko-lcd/kiosko-plugin-video#readme',
  repository: 'https://github.com/kiosko-lcd/kiosko-plugin-video',
  sdk: '^0.2.0',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  permissions: { exec: ['ffmpeg'], files: ['user'], network: ['github.com', 'release-assets.githubusercontent.com'] },
  interludes: [clip],
});
