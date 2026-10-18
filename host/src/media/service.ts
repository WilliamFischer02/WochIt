// MediaService implementation: wires discovery, probing, the ladder, virtual playlists, the JIT
// transcoder, subtitles, posters and the LRU cache behind the interface in ./index.ts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LibraryResponse, MediaInfo, RenditionId } from '@wochit/shared';
import { MediaCache, exists, fileSize, type IndexEntry } from './cache.js';
import { detectEncoder, resolveFfmpeg, type EncoderDetection, type ResolvedFfmpeg } from './ffmpeg.js';
import { MEDIA_ID_RE, mediaIdFor } from './ids.js';
import { MediaError, type Logger, type MediaService, type MediaServiceOptions, type TranscodeEvent } from './index.js';
import { findRung, selectLadder, type Rung } from './ladder.js';
import { browseLibrary, findSidecars } from './library.js';
import { masterPlaylist, mediaPlaylist, segmentCount } from './playlist.js';
import { POSTER_FILE, generatePoster } from './poster.js';
import { pickAudio, probeFile, type AudioStreamInfo, type ProbeInfo } from './probe.js';
import { buildSubtitleTracks, extractSubtitle, languageName, type SubtitleSource } from './subtitles.js';
import { Transcoder, type JobSource } from './transcoder.js';

/** Knobs the server never needs; tests use them. All optional. */
export interface MediaServiceExtraOptions {
  /** libx264 preset (default `veryfast`; tests pass `ultrafast`). */
  x264Preset?: string;
  /** How long getSegment waits for a segment file (default 30 000 ms). */
  segmentWaitMs?: number;
  /** Segment-file poll interval (default 100 ms). */
  pollMs?: number;
  /** A job idle this long is the preferred victim when a slot is needed (default 60 000 ms). */
  idleKillMs?: number;
  /** Eviction sweep interval (default 60 000 ms). */
  evictIntervalMs?: number;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const SUBTITLE_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

export function createMediaService(opts: MediaServiceOptions & MediaServiceExtraOptions): MediaService {
  return new MediaServiceImpl(opts);
}

interface Resolved {
  id: string;
  entry: IndexEntry;
  probe: ProbeInfo;
  rungs: Rung[];
}

class MediaServiceImpl implements MediaService {
  ffmpegFound = false;
  encoder: string | null = null;

  private readonly log: Logger;
  private readonly roots: string[];
  private readonly cache: MediaCache;
  private readonly listeners = new Set<(ev: TranscodeEvent) => void>();
  private paths: ResolvedFfmpeg | null = null;
  private detection: EncoderDetection | null = null;
  private transcoder: Transcoder | null = null;
  private evictTimer: NodeJS.Timeout | null = null;
  private evicting = false;
  private closed = false;
  private readonly probing = new Map<string, Promise<ProbeInfo | null>>();
  private readonly extracting = new Map<string, Promise<string>>();
  private readonly postering = new Map<string, Promise<string | null>>();

  constructor(private readonly opts: MediaServiceOptions & MediaServiceExtraOptions) {
    this.log = opts.log ?? noopLogger;
    this.roots = [...new Set(opts.roots.map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r)))];
    this.cache = new MediaCache(opts.cacheDir, this.log);
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    await this.cache.load();
    this.paths = await resolveFfmpeg(this.opts.ffmpegPath, this.opts.ffprobePath);
    if (!this.paths) {
      this.log.warn('ffmpeg/ffprobe not found (option, WOCHIT_FFMPEG, PATH, winget); media playback is disabled');
    } else {
      this.ffmpegFound = true;
      const det = await detectEncoder(this.paths.ffmpeg, this.opts.encoder, this.log);
      this.detection = det;
      if (det.error) this.log.error(det.error);
      this.encoder = det.encoder;
      if (det.encoder) {
        this.transcoder = new Transcoder({
          ffmpeg: this.paths.ffmpeg,
          encoder: det.encoder,
          cacheDir: this.cache.dir,
          log: this.log,
          maxJobs: this.opts.maxJobs ?? 3,
          pollMs: this.opts.pollMs ?? 100,
          waitMs: this.opts.segmentWaitMs ?? 30000,
          idleMs: this.opts.idleKillMs ?? 60000,
          x264Preset: this.opts.x264Preset ?? 'veryfast',
          hlsSegmentOptionsFlag: det.hlsSegmentOptionsFlag,
          emit: (ev) => this.emit(ev),
          onSegment: (mediaId, bytes) => this.cache.addBytes(mediaId, bytes),
        });
      } else {
        this.log.error('no working H.264 encoder (tried ' + det.tests.map((t) => t.encoder).join(', ') + '); media playback is disabled');
      }
      const tests = det.tests.map((t) => `${t.encoder}=${t.ok ? `ok ${t.ms}ms` : t.listed ? `fail ${t.ms}ms` : 'absent'}`).join(' ');
      this.log.info(`ffmpeg ${this.paths.ffmpeg} (${this.paths.ffmpegSource}); ffprobe ${this.paths.ffprobe} (${this.paths.ffprobeSource})`);
      this.log.info(`encoder ${det.encoder ?? 'none'} [${tests}]; segment options flag ${det.hlsSegmentOptionsFlag ?? 'none'}`);
    }
    this.log.info(`cache ${this.cache.dir}: ${(this.cache.totalBytes() / 1e9).toFixed(2)} GB of ${(this.opts.cacheMaxBytes / 1e9).toFixed(1)} GB, ${this.cache.ids().length} known media`);
    const every = this.opts.evictIntervalMs ?? 60000;
    this.evictTimer = setInterval(() => void this.maybeEvict(), every);
    this.evictTimer.unref();
    void this.maybeEvict();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.evictTimer) clearInterval(this.evictTimer);
    this.evictTimer = null;
    if (this.transcoder) await this.transcoder.shutdown();
    await this.cache.flush();
  }

  /** Exposed for diagnostics/tests. */
  get encoderDetection(): EncoderDetection | null {
    return this.detection;
  }

  get ffmpegPaths(): ResolvedFfmpeg | null {
    return this.paths;
  }

  // ---------------------------------------------------------------- library

  browse(parentId: string | null): Promise<LibraryResponse> {
    return browseLibrary(this.roots, parentId, (abs, st) => {
      const id = this.register(abs, st.size, st.mtimeMs);
      const dur = this.cache.get(id)?.probe?.durationSec;
      return dur !== undefined ? { id, durationSec: dur } : { id };
    });
  }

  private register(absPath: string, size: number, mtimeMs: number): string {
    const id = mediaIdFor(absPath, size, mtimeMs);
    const existing = this.cache.get(id);
    if (!existing || existing.path !== absPath || existing.size !== size || existing.mtimeMs !== mtimeMs) {
      this.cache.set(id, { path: absPath, size, mtimeMs, probe: existing?.probe ?? null, lastAccess: existing?.lastAccess ?? 0 });
    }
    return id;
  }

  async resolvePath(absolutePath: string): Promise<MediaInfo | null> {
    let p = absolutePath.trim();
    if (/^file:/i.test(p)) {
      try {
        p = fileURLToPath(p);
      } catch {
        return null;
      }
    }
    if (!p) return null;
    p = path.resolve(p);
    let st;
    try {
      st = await fs.stat(p);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const id = this.register(p, st.size, st.mtimeMs);
    return this.getMedia(id);
  }

  async getMedia(mediaId: string): Promise<MediaInfo | null> {
    const r = await this.resolve(mediaId);
    if (!r) return null;
    this.cache.touch(mediaId);
    return this.toMediaInfo(r);
  }

  /** Host-only: the registered absolute path, as long as the file is still there. */
  async getPath(mediaId: string): Promise<string | null> {
    if (!MEDIA_ID_RE.test(mediaId)) return null;
    const entry = this.cache.get(mediaId);
    if (!entry) return null;
    try {
      const st = await fs.stat(entry.path);
      return st.isFile() ? entry.path : null;
    } catch {
      return null;
    }
  }

  private async resolve(mediaId: string): Promise<Resolved | null> {
    if (!MEDIA_ID_RE.test(mediaId)) return null;
    const entry = this.cache.get(mediaId);
    if (!entry) return null;
    const probe = await this.ensureProbe(mediaId, entry);
    if (!probe) return null;
    return { id: mediaId, entry, probe, rungs: selectLadder(probe.video.displayWidth, probe.video.height) };
  }

  private async require(mediaId: string): Promise<Resolved> {
    const r = await this.resolve(mediaId);
    if (!r) throw new MediaError('unknown_media', `unknown media ${mediaId}`);
    return r;
  }

  private ensureProbe(id: string, entry: IndexEntry): Promise<ProbeInfo | null> {
    if (entry.probe) return Promise.resolve(entry.probe);
    const inflight = this.probing.get(id);
    if (inflight) return inflight;
    const p = (async (): Promise<ProbeInfo | null> => {
      let st;
      try {
        st = await fs.stat(entry.path);
      } catch {
        this.cache.delete(id);
        return null;
      }
      if (!st.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) {
        this.log.info(`media ${id}: ${entry.path} changed on disk; id retired`);
        this.cache.delete(id);
        return null;
      }
      if (!this.paths) {
        this.log.warn(`media ${id}: cannot probe ${entry.path} without ffprobe`);
        return null;
      }
      const probe = await probeFile(this.paths.ffprobe, entry.path);
      if (!probe) {
        this.log.warn(`media ${id}: ffprobe found no usable video stream in ${entry.path}`);
        this.cache.delete(id);
        return null;
      }
      entry.probe = probe;
      this.cache.set(id, entry);
      return probe;
    })();
    this.probing.set(id, p);
    p.finally(() => this.probing.delete(id)).catch(() => undefined);
    return p;
  }

  private async toMediaInfo(r: Resolved): Promise<MediaInfo> {
    const { id, entry, probe, rungs } = r;
    const sidecars = await findSidecars(entry.path);
    const audio = pickAudio(probe);
    return {
      id,
      title: titleOf(entry.path),
      durationSec: probe.durationSec,
      width: probe.video.displayWidth,
      height: probe.video.height,
      fps: probe.video.fps,
      masterUrl: `/media/${id}/master.m3u8`,
      renditions: rungs.map((g) => ({ id: g.id, width: g.width, height: g.height, bitrateKbps: g.bitrateKbps, playlistUrl: `/media/${id}/${g.id}/index.m3u8` })),
      subtitles: buildSubtitleTracks(id, probe, sidecars),
      audioLabel: audio ? audioLabel(audio) : null,
      posterUrl: `/media/${id}/poster.jpg`,
    };
  }

  // ---------------------------------------------------------------- playlists & segments

  async masterPlaylist(mediaId: string, tokenQuery: string): Promise<string> {
    const r = await this.require(mediaId);
    this.cache.touch(mediaId);
    return masterPlaylist(r.rungs, { fps: r.probe.video.fps, hasAudio: r.probe.audio.length > 0 }, tokenQuery);
  }

  async mediaPlaylist(mediaId: string, rendition: RenditionId, tokenQuery: string): Promise<string> {
    const r = await this.require(mediaId);
    if (!findRung(r.rungs, rendition)) throw new MediaError('unknown_rendition', `no ${rendition} rendition for ${mediaId}`);
    this.cache.touch(mediaId);
    return mediaPlaylist(r.probe.durationSec, tokenQuery, segmentableSec(r.probe));
  }

  async getSegment(mediaId: string, rendition: RenditionId, index: number): Promise<string> {
    const r = await this.require(mediaId);
    const rung = findRung(r.rungs, rendition);
    if (!rung) throw new MediaError('unknown_rendition', `no ${rendition} rendition for ${mediaId}`);
    if (!this.transcoder) throw new MediaError('unsupported', this.ffmpegFound ? 'no working H.264 encoder' : 'ffmpeg not found');
    const src: JobSource = {
      mediaId,
      file: r.entry.path,
      videoIndex: r.probe.video.index,
      audioIndex: pickAudio(r.probe)?.index ?? null,
      rung,
      segmentCount: segmentCount(r.probe.durationSec, segmentableSec(r.probe)),
      durationSec: r.probe.durationSec,
    };
    const file = await this.transcoder.getSegment(src, index);
    this.cache.touch(mediaId);
    void this.maybeEvict(mediaId);
    return file;
  }

  // ---------------------------------------------------------------- subtitles & poster

  async getSubtitle(mediaId: string, subtitleId: string): Promise<string> {
    const r = await this.require(mediaId);
    if (!SUBTITLE_ID_RE.test(subtitleId)) throw new MediaError('not_found', 'unknown subtitle track');
    const out = path.join(this.cache.mediaDir(mediaId), 'subs', `${subtitleId}.vtt`);
    this.cache.touch(mediaId);
    if (await exists(out)) return out;
    const key = `${mediaId}/${subtitleId}`;
    const inflight = this.extracting.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      let src: SubtitleSource | null = null;
      const stream = r.probe.subtitles.find((s) => String(s.rel) === subtitleId);
      if (stream) src = { kind: 'embedded', stream, mediaFile: r.entry.path };
      else {
        const sc = (await findSidecars(r.entry.path)).find((s) => s.id === subtitleId);
        if (sc) src = { kind: 'sidecar', sidecar: sc };
      }
      if (!src) throw new MediaError('not_found', 'unknown subtitle track');
      if (!this.paths) throw new MediaError('unsupported', 'ffmpeg not found');
      try {
        await extractSubtitle(this.paths.ffmpeg, src, out);
      } catch (err) {
        throw new MediaError('transcode_failed', `subtitle extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.cache.addBytes(mediaId, await fileSize(out));
      return out;
    })();
    this.extracting.set(key, p);
    p.finally(() => this.extracting.delete(key)).catch(() => undefined);
    return p;
  }

  async getPoster(mediaId: string): Promise<string | null> {
    const r = await this.require(mediaId);
    const out = path.join(this.cache.mediaDir(mediaId), POSTER_FILE);
    this.cache.touch(mediaId);
    if (await exists(out)) return out;
    if (!this.paths) return null;
    const inflight = this.postering.get(mediaId);
    if (inflight) return inflight;
    const ffmpeg = this.paths.ffmpeg;
    const p = (async () => {
      const err = await generatePoster(ffmpeg, r.entry.path, r.probe.video.index, r.probe.durationSec, out);
      if (err) {
        this.log.warn(`media ${mediaId}: poster failed: ${err}`);
        return null;
      }
      this.cache.addBytes(mediaId, await fileSize(out));
      return out;
    })();
    this.postering.set(mediaId, p);
    p.finally(() => this.postering.delete(mediaId)).catch(() => undefined);
    return p;
  }

  // ---------------------------------------------------------------- events, stats, eviction

  onTranscode(cb: (ev: TranscodeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(ev: TranscodeEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch (err) {
        this.log.warn(`transcode listener threw: ${String(err)}`);
      }
    }
  }

  stats(): { cacheBytes: number; cacheMaxBytes: number; jobs: Array<{ mediaId: string; rendition: RenditionId; nextSegment: number; startedAt: number }> } {
    return { cacheBytes: this.cache.totalBytes(), cacheMaxBytes: this.opts.cacheMaxBytes, jobs: this.transcoder?.list() ?? [] };
  }

  private async maybeEvict(protectId?: string): Promise<void> {
    if (this.evicting || this.closed) return;
    if (this.cache.totalBytes() <= this.opts.cacheMaxBytes) return;
    this.evicting = true;
    try {
      await this.cache.evict(this.opts.cacheMaxBytes, (id) => id === protectId || (this.transcoder?.hasJob(id) ?? false));
    } catch (err) {
      this.log.warn(`cache eviction failed: ${String(err)}`);
    } finally {
      this.evicting = false;
    }
  }
}

// ------------------------------------------------------------------ helpers

function segmentableSec(probe: ProbeInfo): number {
  return probe.video.durationSec ?? probe.durationSec;
}

export function titleOf(file: string): string {
  const base = path.basename(file, path.extname(file));
  return base.replace(/_/g, ' ').trim() || path.basename(file);
}

function channelLabel(a: AudioStreamInfo): string {
  const layout = a.channelLayout?.replace(/\(.*\)$/, '') ?? '';
  if (layout === 'mono' || layout === 'stereo') return layout;
  if (/^\d+\.\d$/.test(layout)) return layout;
  if (a.channels === 1) return 'mono';
  if (a.channels === 2) return 'stereo';
  if (a.channels === 6) return '5.1';
  if (a.channels === 8) return '7.1';
  return a.channels > 0 ? `${a.channels}ch` : '';
}

export function audioLabel(a: AudioStreamInfo): string {
  const lang = languageName(a.lang);
  const title = a.title?.trim() ?? '';
  let name: string;
  if (title) name = lang && !title.toLowerCase().includes(lang.toLowerCase()) ? `${lang} (${title})` : title;
  else name = lang ?? (a.lang ? a.lang.toUpperCase() : 'Audio');
  const codec = a.codec === 'dts' ? 'DTS' : a.codec === 'ac3' ? 'AC-3' : a.codec === 'eac3' ? 'E-AC-3' : a.codec === 'truehd' ? 'TrueHD' : a.codec.toUpperCase();
  const ch = channelLabel(a);
  return `${name} · ${codec}${ch ? ` ${ch}` : ''}`;
}
