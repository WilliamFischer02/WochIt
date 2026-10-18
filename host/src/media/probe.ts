// ffprobe → ProbeInfo. The zod schema doubles as the validator for entries loaded from index.json.
import { z } from 'zod';
import { run } from './ffmpeg.js';

export const VideoStreamInfo = z.object({
  /** Absolute stream index (for `-map 0:<index>`). */
  index: z.number().int().nonnegative(),
  codec: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Width after applying the sample aspect ratio (anamorphic sources). */
  displayWidth: z.number().int().positive(),
  fps: z.number().positive().nullable(),
  pixFmt: z.string().nullable(),
  /** The video stream's own duration when the container reports one; null otherwise. */
  durationSec: z.number().nonnegative().nullable(),
});
export type VideoStreamInfo = z.infer<typeof VideoStreamInfo>;

export const AudioStreamInfo = z.object({
  index: z.number().int().nonnegative(),
  /** Index among audio streams (for `0:a:<rel>`). */
  rel: z.number().int().nonnegative(),
  codec: z.string(),
  channels: z.number().int().nonnegative(),
  channelLayout: z.string().nullable(),
  sampleRate: z.number().positive().nullable(),
  bitrateKbps: z.number().nonnegative().nullable(),
  lang: z.string().nullable(),
  title: z.string().nullable(),
  isDefault: z.boolean(),
});
export type AudioStreamInfo = z.infer<typeof AudioStreamInfo>;

export const SubtitleStreamInfo = z.object({
  index: z.number().int().nonnegative(),
  rel: z.number().int().nonnegative(),
  codec: z.string(),
  lang: z.string().nullable(),
  title: z.string().nullable(),
  isDefault: z.boolean(),
  forced: z.boolean(),
  hearingImpaired: z.boolean(),
  /** Text-based (convertible to WebVTT) vs bitmap. */
  text: z.boolean(),
});
export type SubtitleStreamInfo = z.infer<typeof SubtitleStreamInfo>;

export const ProbeInfo = z.object({
  durationSec: z.number().nonnegative(),
  startTime: z.number(),
  container: z.string(),
  video: VideoStreamInfo,
  audio: z.array(AudioStreamInfo),
  subtitles: z.array(SubtitleStreamInfo),
});
export type ProbeInfo = z.infer<typeof ProbeInfo>;

export const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd', 'subviewer', 'sami', 'realtext', 'jacosub', 'mpl2', 'vplayer', 'pjs', 'stl']);

export function probeArgs(file: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
}

/** Null when ffprobe fails or the file has no usable video stream. */
export async function probeFile(ffprobe: string, file: string): Promise<ProbeInfo | null> {
  const r = await run(ffprobe, probeArgs(file), { timeoutMs: 60000 });
  if (r.code !== 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  return parseProbe(json);
}

// ------------------------------------------------------------------ parsing helpers

type Dict = Record<string, unknown>;

function dict(v: unknown): Dict {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function flag(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

/** "24000/1001" → 23.976; "0/0" → null. */
export function parseRate(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!b || !a) return null;
    return Math.round((a / b) * 1000) / 1000;
  }
  const n = num(s);
  return n && n > 0 ? Math.round(n * 1000) / 1000 : null;
}

/** "00:01:30.000000000" → 90. */
export function parseHms(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return num(s);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function tagsOf(stream: Dict): Dict {
  const t = dict(stream['tags']);
  // ffprobe emits tag keys as written in the container; normalise to lower case for lookups.
  const out: Dict = {};
  for (const [k, v] of Object.entries(t)) out[k.toLowerCase()] = v;
  return out;
}

function streamDuration(stream: Dict, tags: Dict): number | null {
  const d = num(stream['duration']);
  if (d !== null && d > 0) return d;
  const t = parseHms(tags['duration']);
  return t !== null && t > 0 ? t : null;
}

export function parseProbe(json: unknown): ProbeInfo | null {
  const root = dict(json);
  const format = dict(root['format']);
  const streams = Array.isArray(root['streams']) ? root['streams'].map(dict) : [];

  let video: VideoStreamInfo | null = null;
  const audio: AudioStreamInfo[] = [];
  const subtitles: SubtitleStreamInfo[] = [];
  let audioRel = 0;
  let subRel = 0;

  for (const s of streams) {
    const type = str(s['codec_type']);
    const index = num(s['index']);
    if (index === null) continue;
    const disp = dict(s['disposition']);
    const tags = tagsOf(s);
    const codec = str(s['codec_name']) ?? 'unknown';
    if (type === 'video') {
      if (flag(disp['attached_pic']) || codec === 'mjpeg' || codec === 'png') continue;
      if (video) continue;
      const width = num(s['width']);
      const height = num(s['height']);
      if (!width || !height || width <= 0 || height <= 0) continue;
      let displayWidth = width;
      const sar = str(s['sample_aspect_ratio']);
      const sm = sar ? /^(\d+):(\d+)$/.exec(sar) : null;
      if (sm) {
        const n = Number(sm[1]);
        const d = Number(sm[2]);
        if (n > 0 && d > 0 && n !== d) displayWidth = Math.max(2, Math.round((width * n) / d));
      }
      video = {
        index,
        codec,
        width: Math.round(width),
        height: Math.round(height),
        displayWidth,
        fps: parseRate(s['avg_frame_rate']) ?? parseRate(s['r_frame_rate']),
        pixFmt: str(s['pix_fmt']),
        durationSec: streamDuration(s, tags),
      };
    } else if (type === 'audio') {
      audio.push({
        index,
        rel: audioRel++,
        codec,
        channels: Math.max(0, Math.round(num(s['channels']) ?? 0)),
        channelLayout: str(s['channel_layout']),
        sampleRate: num(s['sample_rate']),
        bitrateKbps: num(s['bit_rate']) !== null ? Math.round((num(s['bit_rate']) as number) / 1000) : null,
        lang: str(tags['language']),
        title: str(tags['title']),
        isDefault: flag(disp['default']),
      });
    } else if (type === 'subtitle') {
      subtitles.push({
        index,
        rel: subRel++,
        codec,
        lang: str(tags['language']),
        title: str(tags['title']),
        isDefault: flag(disp['default']),
        forced: flag(disp['forced']),
        hearingImpaired: flag(disp['hearing_impaired']),
        text: TEXT_SUBTITLE_CODECS.has(codec),
      });
    }
  }

  if (!video) return null;

  let durationSec = num(format['duration']);
  if (durationSec === null || durationSec <= 0) {
    const candidates = [video.durationSec, ...streams.map((s) => streamDuration(s, tagsOf(s)))].filter((d): d is number => d !== null && d > 0);
    durationSec = candidates.length ? Math.max(...candidates) : 0;
  }

  return {
    durationSec,
    startTime: num(format['start_time']) ?? 0,
    container: str(format['format_name']) ?? 'unknown',
    video,
    audio,
    subtitles,
  };
}

/** Default audio stream: first with the `default` disposition, else the first one; null if none. */
export function pickAudio(probe: ProbeInfo): AudioStreamInfo | null {
  return probe.audio.find((a) => a.isDefault) ?? probe.audio[0] ?? null;
}
