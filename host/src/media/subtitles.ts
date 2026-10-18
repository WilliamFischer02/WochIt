// Subtitle tracks: embedded text streams and sidecar files become WebVTT on first request;
// bitmap streams are listed (so the UI can explain) but serve a placeholder VTT.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubtitleTrack } from '@wochit/shared';
import { run } from './ffmpeg.js';
import type { Sidecar } from './library.js';
import type { ProbeInfo, SubtitleStreamInfo } from './probe.js';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', eng: 'English',
  es: 'Spanish', spa: 'Spanish',
  fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German',
  it: 'Italian', ita: 'Italian',
  pt: 'Portuguese', por: 'Portuguese',
  ja: 'Japanese', jpn: 'Japanese',
  ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  ru: 'Russian', rus: 'Russian',
  ar: 'Arabic', ara: 'Arabic',
  hi: 'Hindi', hin: 'Hindi',
  nl: 'Dutch', dut: 'Dutch', nld: 'Dutch',
  sv: 'Swedish', swe: 'Swedish',
  no: 'Norwegian', nor: 'Norwegian', nob: 'Norwegian',
  da: 'Danish', dan: 'Danish',
  fi: 'Finnish', fin: 'Finnish',
  pl: 'Polish', pol: 'Polish',
  tr: 'Turkish', tur: 'Turkish',
  cs: 'Czech', cze: 'Czech', ces: 'Czech',
  hu: 'Hungarian', hun: 'Hungarian',
  el: 'Greek', gre: 'Greek', ell: 'Greek',
  he: 'Hebrew', heb: 'Hebrew',
  th: 'Thai', tha: 'Thai',
  vi: 'Vietnamese', vie: 'Vietnamese',
  id: 'Indonesian', ind: 'Indonesian',
  uk: 'Ukrainian', ukr: 'Ukrainian',
  ro: 'Romanian', rum: 'Romanian', ron: 'Romanian',
  bg: 'Bulgarian', bul: 'Bulgarian',
  hr: 'Croatian', hrv: 'Croatian',
  sr: 'Serbian', srp: 'Serbian',
  sk: 'Slovak', slo: 'Slovak', slk: 'Slovak',
  sl: 'Slovenian', slv: 'Slovenian',
  ms: 'Malay', may: 'Malay', msa: 'Malay',
  fa: 'Persian', per: 'Persian', fas: 'Persian',
  ta: 'Tamil', tam: 'Tamil',
  te: 'Telugu', tel: 'Telugu',
  tl: 'Filipino', tgl: 'Filipino', fil: 'Filipino',
};

/** "eng" → "English"; unknown codes come back upper-cased; "und"/null → null. */
export function languageName(code: string | null): string | null {
  if (!code) return null;
  const base = code.toLowerCase().split(/[-_]/)[0] ?? '';
  if (base === '' || base === 'und') return null;
  return LANGUAGE_NAMES[base] ?? code.toUpperCase();
}

const BITMAP_LABELS: Record<string, string> = {
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
  xsub: 'XSUB',
  dvb_teletext: 'Teletext',
  arib_caption: 'ARIB',
};

export const UNSUPPORTED_SUFFIX = ' — not supported yet';

export function embeddedLabel(s: SubtitleStreamInfo): string {
  const lang = languageName(s.lang);
  let label: string;
  const title = s.title?.trim() ?? '';
  if (title) {
    label = lang && !title.toLowerCase().includes(lang.toLowerCase()) ? `${lang} (${title})` : title;
  } else {
    label = lang ?? (s.lang ? s.lang.toUpperCase() : 'Subtitles');
  }
  if (s.hearingImpaired && !/\b(sdh|hearing|hi)\b/i.test(label)) label += ' (SDH)';
  if (s.forced && !/forced/i.test(label)) label += ' (forced)';
  if (!s.text) label += ` (${BITMAP_LABELS[s.codec] ?? s.codec.toUpperCase()})${UNSUPPORTED_SUFFIX}`;
  return label;
}

export function sidecarLabel(sc: Sidecar): string {
  let label = languageName(sc.lang) ?? (sc.lang ? sc.lang.toUpperCase() : 'Subtitles');
  if (sc.sdh) label += ' (SDH)';
  if (sc.forced) label += ' (forced)';
  return `${label} · ${sc.ext.slice(1)}`;
}

export function subtitleUrl(mediaId: string, subtitleId: string): string {
  return `/media/${mediaId}/subs/${subtitleId}.vtt`;
}

export function embeddedSubtitleId(s: SubtitleStreamInfo): string {
  return String(s.rel);
}

export function buildSubtitleTracks(mediaId: string, probe: ProbeInfo, sidecars: Sidecar[]): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  let defaultSeen = false;
  for (const s of probe.subtitles) {
    const isDefault = s.isDefault && !defaultSeen && s.text;
    if (isDefault) defaultSeen = true;
    const id = embeddedSubtitleId(s);
    tracks.push({ id, label: embeddedLabel(s), lang: s.lang, kind: 'embedded', url: subtitleUrl(mediaId, id), isDefault });
  }
  for (const sc of sidecars) {
    tracks.push({ id: sc.id, label: sidecarLabel(sc), lang: sc.lang, kind: 'sidecar', url: subtitleUrl(mediaId, sc.id), isDefault: false });
  }
  return tracks;
}

export type SubtitleSource =
  | { kind: 'embedded'; stream: SubtitleStreamInfo; mediaFile: string }
  | { kind: 'sidecar'; sidecar: Sidecar };

export function placeholderVtt(reason: string): string {
  return `WEBVTT\n\nNOTE ${reason}\n`;
}

async function convert(ffmpeg: string, inputArgs: string[], out: string): Promise<{ ok: boolean; error: string }> {
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputArgs, '-f', 'webvtt', out], { timeoutMs: 180000 });
  return { ok: r.code === 0 && !r.timedOut, error: r.stderr.trim() };
}

/**
 * Write `outPath` (WebVTT). Text streams and sidecars are converted with ffmpeg (sidecars retried
 * as Windows-1252 when they are not UTF-8); bitmap streams get a placeholder with a NOTE.
 * Throws with ffmpeg's message when conversion fails.
 */
export async function extractSubtitle(ffmpeg: string, src: SubtitleSource, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp.vtt`;
  try {
    if (src.kind === 'embedded') {
      if (!src.stream.text) {
        await fs.writeFile(tmp, placeholderVtt(`${BITMAP_LABELS[src.stream.codec] ?? src.stream.codec} bitmap subtitles are not supported yet`), 'utf8');
      } else {
        const r = await convert(ffmpeg, ['-i', src.mediaFile, '-map', `0:${src.stream.index}`], tmp);
        if (!r.ok) throw new Error(r.error || 'ffmpeg failed to extract the subtitle stream');
      }
    } else {
      let r = await convert(ffmpeg, ['-i', src.sidecar.path], tmp);
      if (!r.ok && /utf-?8|charenc|invalid/i.test(r.error)) {
        r = await convert(ffmpeg, ['-sub_charenc', 'CP1252', '-i', src.sidecar.path], tmp);
      }
      if (!r.ok) {
        if (src.sidecar.ext === '.vtt') {
          // Already WebVTT but ffmpeg disliked it: serve the file as is.
          await fs.copyFile(src.sidecar.path, tmp);
        } else {
          throw new Error(r.error || 'ffmpeg failed to convert the sidecar subtitle');
        }
      }
    }
    await fs.rename(tmp, outPath);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
