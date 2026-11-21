# kiosko-plugin-video

Your own videos as an interlude, on the whole panel: one clip, or a folder
of them (a different one each time slot). Your ffmpeg decodes it straight to
the panel's size, cropped to fill it or whole with black bars; nothing is
copied or converted to disk.

A plugin for [Kiosko](https://github.com/kiosko-lcd/kiosko), the widget mosaic
for small USB LCD panels. **Optional:** Kiosko doesn't install it.

## Install

```sh
npm install --prefix ~/.config/kiosko/plugins kiosko-plugin-video
```

(macOS: `~/Library/Application Support/Kiosko/plugins`, Windows: `%APPDATA%\Kiosko\plugins`.)

It decodes with **ffmpeg**, and finds one in this order:

1. the program you name in the `bin` option;
2. `ffmpeg` on the PATH;
3. otherwise (most Windows and Mac machines have none) a copy it downloads
   once into its data folder: ffmpeg 6.1.1 from the
   [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) project's
   GitHub release (about 30 MB), checked against the SHA-256 pinned in
   `src/find-ffmpeg.ts`. Builds for Windows x64, macOS (Apple silicon and
   Intel) and Linux (x64, arm64, arm). That first time the interlude doesn't
   play; from the next one on it does.

Then add the interlude to a screen: **Screens → Interludes → Your videos**.
Like any interlude it plays at its time slot (every 15 min = at :00, :15,
:30, :45) for up to `maxSeconds`, or right away from the editor or Home
Assistant.

## What it does on your machine

- **Runs** `ffmpeg` (or the program in `bin`): once to read the video's
  length, once to decode it while it plays. It stops when the interlude
  ends, or 10 s after the last frame when an interlude is cut short.
- **Contacts** `github.com` and `release-assets.githubusercontent.com`, once,
  only when there is no ffmpeg to use, to download one.
- **Reads** the video or folder you name in `source`.

Decoded at 24 frames a second; the screen shows at most its `maxFps`,
skipping frames rather than slowing the video down.

## Interludes

### Your videos — `video/clip`

| Option | Type | Default | |
|---|---|---|---|
| `source` | path | `""` | A video file (mp4, webm, mkv, mov, gif…), or a folder: then a different one of its videos each time. |
| `fit` | `cover` \| `contain` | `"cover"` | Fill the panel (crop), or the whole video with black bars. |
| `bin` | string | `""` | The ffmpeg program to use, by its full path. Empty: the one on the PATH, or else one downloaded once. |

## Testing

`npm test` runs against a stand-in for ffmpeg (`src/fixtures/fake-ffmpeg.mjs`).
With a real one: `KIOSKO_FFMPEG=/path/to/ffmpeg KIOSKO_FFMPEG_DIR=<folder with clip.mp4> npm test`.

## Licence

MIT. The ffmpeg it may download is ffmpeg's own build, under ffmpeg's
licence (GPL); it runs as a program of its own.
