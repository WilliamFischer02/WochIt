// Poster frame: one JPEG at 10 % of the duration, 480 px wide, quality 4.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run } from './ffmpeg.js';

export const POSTER_FILE = 'poster.jpg';
export const POSTER_WIDTH = 480;

export function posterArgs(mediaFile: string, videoIndex: number, atSec: number, out: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', atSec.toFixed(3), '-i', mediaFile,
    '-map', `0:${videoIndex}`, '-frames:v', '1',
    '-vf', `scale=${POSTER_WIDTH}:-2:flags=lanczos,format=yuvj420p`,
    '-q:v', '4', '-update', '1', '-f', 'image2', out,
  ];
}

export function posterTime(durationSec: number): number {
  return durationSec > 0 ? Math.max(0, durationSec * 0.1) : 0;
}

/** Returns the error text on failure, null on success. */
export async function generatePoster(ffmpeg: string, mediaFile: string, videoIndex: number, durationSec: number, outPath: string): Promise<string | null> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp.jpg`;
  const attempts = [posterTime(durationSec), 0];
  let lastError = 'no frame produced';
  try {
    for (const at of attempts) {
      const r = await run(ffmpeg, posterArgs(mediaFile, videoIndex, at, tmp), { timeoutMs: 60000 });
      let size = 0;
      try {
        size = (await fs.stat(tmp)).size;
      } catch {
        size = 0;
      }
      if (r.code === 0 && size > 0) {
        await fs.rename(tmp, outPath);
        return null;
      }
      lastError = r.stderr.trim() || `exit ${r.code}`;
    }
    return lastError;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
