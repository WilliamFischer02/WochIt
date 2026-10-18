// Virtual HLS playlists. Nothing here touches the disk: the master lists the ladder, each media
// playlist lists every 4 s segment of the file; segments are produced on request.
import { HLS_SEGMENT_SEC } from '@wochit/shared';
import type { Rung } from './ladder.js';

export const AUDIO_KBPS = 128;
export const VIDEO_CODEC_STRING = 'avc1.640028';
export const AUDIO_CODEC_STRING = 'mp4a.40.2';

/** Trailing slivers shorter than this are folded into the previous segment. */
const SLIVER_SEC = 0.1;

/**
 * Number of segments for a media. `segmentableSec` is the span video frames actually cover (the
 * video stream's own duration when known); `durationSec` is the container duration.
 */
export function segmentCount(durationSec: number, segmentableSec: number = durationSec): number {
  const span = Math.min(durationSec, segmentableSec > 0 ? segmentableSec : durationSec);
  return Math.max(1, Math.ceil((span - SLIVER_SEC) / HLS_SEGMENT_SEC));
}

export function segmentFileName(index: number): string {
  return `seg${String(index).padStart(5, '0')}.ts`;
}

export function parseSegmentFileName(name: string): number | null {
  const m = /^seg(\d{5,})\.ts$/.exec(name);
  return m?.[1] ? Number(m[1]) : null;
}

function fmt3(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

export function mediaPlaylist(durationSec: number, tokenQuery: string, segmentableSec: number = durationSec): string {
  const n = segmentCount(durationSec, segmentableSec);
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${HLS_SEGMENT_SEC}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  for (let k = 0; k < n; k++) {
    const isLast = k === n - 1;
    const len = isLast ? Math.max(SLIVER_SEC, durationSec - k * HLS_SEGMENT_SEC) : HLS_SEGMENT_SEC;
    lines.push(`#EXTINF:${fmt3(len)},`);
    lines.push(`${segmentFileName(k)}${tokenQuery}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

export interface MasterOptions {
  fps: number | null;
  hasAudio: boolean;
}

export function masterPlaylist(rungs: Rung[], opts: MasterOptions, tokenQuery: string): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const codecs = opts.hasAudio ? `${VIDEO_CODEC_STRING},${AUDIO_CODEC_STRING}` : VIDEO_CODEC_STRING;
  const audioKbps = opts.hasAudio ? AUDIO_KBPS : 0;
  for (const r of rungs) {
    const peak = Math.round((r.bitrateKbps * 1.2 + audioKbps) * 1000);
    const avg = Math.round((r.bitrateKbps + audioKbps) * 1000);
    const attrs = [
      `BANDWIDTH=${peak}`,
      `AVERAGE-BANDWIDTH=${avg}`,
      `RESOLUTION=${r.width}x${r.height}`,
      `CODECS="${codecs}"`,
    ];
    if (opts.fps && opts.fps > 0) attrs.push(`FRAME-RATE=${fmt3(opts.fps).replace(/\.?0+$/, '')}`);
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`);
    lines.push(`${r.id}/index.m3u8${tokenQuery}`);
  }
  return lines.join('\n') + '\n';
}
