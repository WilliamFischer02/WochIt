// DEV / TEST ONLY. An in-memory MediaService that needs no ffmpeg: generated playlists, tiny fake
// MPEG-TS segments written to a temp dir, a one-cue WebVTT, no poster. Used by `--fake-media`
// (so the server can be exercised before the real pipeline lands) and by host/test/**.
// Never the default; index.ts prints a loud warning when it is active.
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HLS_SEGMENT_SEC, RENDITION_LADDER, type LibraryResponse, type MediaInfo, type RenditionId } from '@wochit/shared';
import { MediaError, type MediaService, type TranscodeEvent } from '../media/index.js';

export interface FakeMediaItem {
  id: string;
  title: string;
  durationSec: number;
  /** Pretend absolute path; `resolvePath` matches on it (case-insensitively on Windows). */
  path: string;
  width?: number;
  height?: number;
  subtitles?: Array<{ id: string; label: string; lang: string | null }>;
}

export interface FakeMediaOptions {
  items?: FakeMediaItem[];
  /** Where fake segment files go. Default: <tmp>/wochit-fake-media. */
  dir?: string;
  ffmpegFound?: boolean;
  encoder?: string | null;
  /** Register unknown paths passed to resolvePath() as new 600 s items. Default true. */
  autoRegister?: boolean;
}

export interface FakeMediaService extends MediaService {
  /** Test helper: fire a transcode event to subscribers. */
  emitTranscode(ev: TranscodeEvent): void;
  /** Test helper: add an item at runtime. */
  addItem(item: FakeMediaItem): MediaInfo;
  /** Absolute path for an id (lets `open_in_vlc` work in dev). */
  getPath(mediaId: string): Promise<string | null>;
  readonly dir: string;
  readonly calls: string[];
}

export const DEFAULT_FAKE_ITEMS: FakeMediaItem[] = [
  { id: 'fake000000000001', title: 'Test Pattern (10 min)', durationSec: 600, path: 'C:\\FakeMedia\\Test Pattern.mkv', width: 1920, height: 1080 },
  {
    id: 'fake000000000002',
    title: 'Short Clip (90 s)',
    durationSec: 90,
    path: 'C:\\FakeMedia\\Clips\\Short Clip.mp4',
    width: 1280,
    height: 720,
    subtitles: [{ id: '0', label: 'English', lang: 'en' }],
  },
];

function normPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}

function ladderFor(height: number) {
  const rungs = RENDITION_LADDER.filter((r) => r.height <= height);
  const chosen = rungs.length ? rungs : [RENDITION_LADDER.at(-1)!];
  return chosen.map((r) => ({ id: r.id, height: r.height, bitrateKbps: r.bitrateKbps }));
}

function toInfo(item: FakeMediaItem): MediaInfo {
  const width = item.width ?? 1920;
  const height = item.height ?? 1080;
  const base = `/media/${item.id}`;
  return {
    id: item.id,
    title: item.title,
    durationSec: item.durationSec,
    width,
    height,
    fps: 24,
    masterUrl: `${base}/master.m3u8`,
    renditions: ladderFor(height).map((r) => ({
      id: r.id,
      width: Math.round((width / height) * r.height / 2) * 2,
      height: r.height,
      bitrateKbps: r.bitrateKbps,
      playlistUrl: `${base}/${r.id}/index.m3u8`,
    })),
    subtitles: (item.subtitles ?? []).map((s, i) => ({
      id: s.id,
      label: s.label,
      lang: s.lang,
      kind: 'embedded' as const,
      url: `${base}/subs/${encodeURIComponent(s.id)}.vtt`,
      isDefault: i === 0,
    })),
    audioLabel: 'Stereo',
    posterUrl: null,
  };
}

export function createFakeMediaService(opts: FakeMediaOptions = {}): FakeMediaService {
  const items = new Map<string, FakeMediaItem>();
  for (const it of opts.items ?? DEFAULT_FAKE_ITEMS) items.set(it.id, it);
  const dir = opts.dir ?? path.join(os.tmpdir(), 'wochit-fake-media');
  const listeners = new Set<(ev: TranscodeEvent) => void>();
  const calls: string[] = [];
  const autoRegister = opts.autoRegister ?? true;
  let counter = 0;

  const byId = (id: string): FakeMediaItem => {
    const it = items.get(id);
    if (!it) throw new MediaError('unknown_media', `unknown media ${id}`);
    return it;
  };
  const renditionOf = (item: FakeMediaItem, r: RenditionId) => {
    const found = toInfo(item).renditions.find((x) => x.id === r);
    if (!found) throw new MediaError('unknown_rendition', `no ${r} for ${item.id}`);
    return found;
  };
  const segmentCount = (item: FakeMediaItem): number => Math.max(1, Math.ceil(item.durationSec / HLS_SEGMENT_SEC));

  return {
    dir,
    calls,
    ffmpegFound: opts.ffmpegFound ?? false,
    encoder: opts.encoder ?? null,

    async init() {
      calls.push('init');
      await mkdir(dir, { recursive: true });
    },

    async browse(parentId): Promise<LibraryResponse> {
      calls.push(`browse:${parentId ?? 'null'}`);
      if (parentId === null) {
        return { parentId: null, entries: [{ kind: 'dir', id: 'root-fake', name: 'FakeMedia', displayPath: 'FakeMedia' }] };
      }
      if (parentId !== 'root-fake') return { parentId, entries: [] };
      return {
        parentId,
        entries: [...items.values()].map((it) => ({
          kind: 'file',
          id: it.id,
          name: path.basename(it.path),
          displayPath: `FakeMedia / ${path.basename(it.path)}`,
          sizeBytes: 1_000_000,
          durationSec: it.durationSec,
        })),
      };
    },

    async resolvePath(absolutePath) {
      calls.push(`resolvePath:${absolutePath}`);
      const want = normPath(absolutePath);
      for (const it of items.values()) if (normPath(it.path) === want) return toInfo(it);
      if (!autoRegister) return null;
      const id = `fakeauto${String(++counter).padStart(8, '0')}`;
      const item: FakeMediaItem = { id, title: path.basename(absolutePath), durationSec: 600, path: absolutePath };
      items.set(id, item);
      return toInfo(item);
    },

    async getMedia(mediaId) {
      calls.push(`getMedia:${mediaId}`);
      const it = items.get(mediaId);
      return it ? toInfo(it) : null;
    },

    async getPath(mediaId) {
      return items.get(mediaId)?.path ?? null;
    },

    async masterPlaylist(mediaId, tokenQuery) {
      const info = toInfo(byId(mediaId));
      const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
      for (const r of info.renditions) {
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrateKbps * 1000},RESOLUTION=${r.width}x${r.height},CODECS="avc1.640028,mp4a.40.2"`);
        lines.push(`${r.id}/index.m3u8${tokenQuery}`);
      }
      return lines.join('\n') + '\n';
    },

    async mediaPlaylist(mediaId, rendition, tokenQuery) {
      const item = byId(mediaId);
      renditionOf(item, rendition);
      const n = segmentCount(item);
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        `#EXT-X-TARGETDURATION:${HLS_SEGMENT_SEC}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
      ];
      for (let k = 0; k < n; k++) {
        const dur = k === n - 1 ? item.durationSec - k * HLS_SEGMENT_SEC || HLS_SEGMENT_SEC : HLS_SEGMENT_SEC;
        lines.push(`#EXTINF:${dur.toFixed(3)},`);
        lines.push(`seg${String(k).padStart(5, '0')}.ts${tokenQuery}`);
      }
      lines.push('#EXT-X-ENDLIST');
      return lines.join('\n') + '\n';
    },

    async getSegment(mediaId, rendition, index) {
      calls.push(`getSegment:${mediaId}/${rendition}/${index}`);
      const item = byId(mediaId);
      renditionOf(item, rendition);
      if (!Number.isInteger(index) || index < 0 || index >= segmentCount(item)) {
        throw new MediaError('not_found', `segment ${index} is past the end`);
      }
      const segDir = path.join(dir, mediaId, rendition);
      await mkdir(segDir, { recursive: true });
      const file = path.join(segDir, `seg${String(index).padStart(5, '0')}.ts`);
      // Four 188-byte TS packets: sync byte, then a recognisable payload that encodes the index.
      const buf = Buffer.alloc(188 * 4, 0xff);
      for (let p = 0; p < 4; p++) {
        buf[p * 188] = 0x47;
        buf.write(`WOCHIT ${mediaId} ${rendition} seg ${index} pkt ${p}`, p * 188 + 4, 'ascii');
      }
      await writeFile(file, buf);
      return file;
    },

    async getSubtitle(mediaId, subtitleId) {
      const item = byId(mediaId);
      const track = (item.subtitles ?? []).find((s) => s.id === subtitleId);
      if (!track) throw new MediaError('not_found', `no subtitle ${subtitleId}`);
      const subsDir = path.join(dir, mediaId, 'subs');
      await mkdir(subsDir, { recursive: true });
      const file = path.join(subsDir, `${subtitleId}.vtt`);
      await writeFile(file, `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${item.title} (${track.label})\n`, 'utf8');
      return file;
    },

    async getPoster() {
      return null;
    },

    onTranscode(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    emitTranscode(ev) {
      for (const cb of listeners) cb(ev);
    },

    addItem(item) {
      items.set(item.id, item);
      return toInfo(item);
    },

    stats() {
      return { cacheBytes: 0, cacheMaxBytes: 0, jobs: [] };
    },

    async shutdown() {
      calls.push('shutdown');
    },
  };
}
