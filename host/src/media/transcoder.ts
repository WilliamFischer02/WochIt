// Just-in-time HLS transcoding. One ffmpeg job per (mediaId, rendition); a job starts at the
// requested segment and runs towards the end of the file, skipping over runs of segments that are
// already cached (it is restarted at the next gap rather than re-encoding them). Segment files
// appear atomically (hls temp_file flag), so "file exists" means "segment complete".
//
// Timestamp contract (verified by host/test/media/integration.test.ts): segment k starts at PTS
// k*4 s exactly, whichever job produced it. That needs `-copyts -start_at_zero`, keyframes forced
// as IDR at every multiple of 4 s of source time (`-forced-idr 1`: NVENC otherwise emits forced
// keyframes as non-IDR I-frames and the HLS muxer only splits at the 8 s GOP), `mpegts_copyts=1`
// on the segment muxer (else MPEG-TS adds its 1.4 s delay), NO B-frames and an explicit `-ss 0`
// plus a 21.5 ms audio trim for the job that starts at t=0: anything with a negative first
// timestamp (the B-frame DTS lead, the AAC priming packet) makes ffmpeg shift that whole job, and
// its segments would then disagree with a job started mid-file.
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HLS_SEGMENT_SEC, type RenditionId } from '@wochit/shared';
import { exists, fileSize } from './cache.js';
import { isAlive, killTree, tail } from './ffmpeg.js';
import { MediaError, type Logger, type TranscodeEvent } from './index.js';
import type { Rung } from './ladder.js';
import { parseSegmentFileName, segmentFileName } from './playlist.js';

/** A request for segment k waits on a running job when k ∈ [nextSegment, nextSegment + WINDOW]. */
export const SEGMENT_WINDOW = 8;

export const FORCE_KEY_FRAMES_EXPR = 'expr:if(isnan(prev_forced_t),gte(t,0),gte(t,floor(prev_forced_t/4)*4+4))';

/** Audio dropped at the very start of a job that begins at segment 0 (≥ the AAC priming of 1024/48000 s). */
export const AUDIO_START_TRIM_SEC = 0.0215;

export interface JobSource {
  mediaId: string;
  file: string;
  /** Absolute stream indexes. */
  videoIndex: number;
  audioIndex: number | null;
  rung: Rung;
  segmentCount: number;
  durationSec: number;
}

export interface TranscoderOptions {
  ffmpeg: string;
  encoder: string;
  cacheDir: string;
  log: Logger;
  maxJobs: number;
  pollMs: number;
  waitMs: number;
  idleMs: number;
  x264Preset: string;
  /** `hls_segment_options` (ffmpeg ≥ 6.1) or `hls_ts_options`; null disables mpegts_copyts. */
  hlsSegmentOptionsFlag: string | null;
  emit: (ev: TranscodeEvent) => void;
  /** Called with the byte size of each segment a job writes (for cache accounting). */
  onSegment?: (mediaId: string, bytes: number) => void;
}

export interface JobArgsInput {
  file: string;
  startSegment: number;
  videoIndex: number;
  audioIndex: number | null;
  rung: Rung;
  encoder: string;
  x264Preset: string;
  segDir: string;
  hlsSegmentOptionsFlag: string | null;
}

export function encoderArgs(encoder: string, kbps: number, x264Preset: string): string[] {
  const bv = `${kbps}k`;
  const maxrate = `${Math.round(kbps * 1.2)}k`;
  const bufsize = `${kbps * 2}k`;
  switch (encoder) {
    case 'h264_nvenc':
      return [
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23',
        '-b:v', bv, '-maxrate', maxrate, '-bufsize', bufsize,
        '-profile:v', 'high', '-bf', '0', '-spatial-aq', '1', '-temporal-aq', '1', '-no-scenecut', '1',
        '-forced-idr', '1', '-g', '240', '-keyint_min', '240',
      ];
    case 'h264_qsv':
      return [
        '-c:v', 'h264_qsv', '-preset', 'medium',
        '-b:v', bv, '-maxrate', maxrate, '-bufsize', bufsize,
        '-profile:v', 'high', '-bf', '0', '-forced_idr', '1', '-g', '240',
      ];
    case 'h264_amf':
      return [
        '-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak',
        '-b:v', bv, '-maxrate', maxrate, '-bufsize', bufsize,
        '-profile:v', 'high', '-bf', '0', '-g', '240',
      ];
    default:
      return [
        '-c:v', 'libx264', '-preset', x264Preset, '-crf', '23', '-maxrate', maxrate, '-bufsize', bufsize,
        '-profile:v', 'high', '-bf', '0', '-sc_threshold', '0', '-g', '240', '-keyint_min', '240',
      ];
  }
}

export function buildJobArgs(p: JobArgsInput): string[] {
  const startSec = p.startSegment * HLS_SEGMENT_SEC;
  // `-ss 0` is not a no-op: without it the AAC priming packet of a file whose audio starts at 0
  // comes out at -21 ms and the segment muxer shifts the whole k=0 job by one audio frame.
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-ss', String(startSec)];
  args.push('-i', p.file, '-map', `0:${p.videoIndex}`);
  if (p.audioIndex !== null) args.push('-map', `0:${p.audioIndex}`);
  args.push('-copyts', '-start_at_zero');
  args.push('-vf', `scale=${p.rung.width}:${p.rung.height}:flags=lanczos,setsar=1,format=yuv420p`);
  if (p.audioIndex !== null && p.startSegment === 0) {
    // The AAC encoder stamps its first (priming) packet 1024 samples = 21.33 ms before the first
    // audio frame. At t=0 that is negative, and ffmpeg then shifts every stream of this job by
    // that amount, so its segments would not line up with the ones a job started mid-file makes.
    // Dropping the first 21.5 ms of audio keeps every timestamp of the k=0 job ≥ 0 and exact.
    args.push('-af', `atrim=start=${AUDIO_START_TRIM_SEC}`);
  }
  args.push(...encoderArgs(p.encoder, p.rung.bitrateKbps, p.x264Preset));
  args.push('-force_key_frames', FORCE_KEY_FRAMES_EXPR);
  if (p.audioIndex !== null) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000');
  args.push(
    '-f', 'hls', '-hls_time', String(HLS_SEGMENT_SEC), '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_flags', 'temp_file+independent_segments',
  );
  if (p.hlsSegmentOptionsFlag) args.push(`-${p.hlsSegmentOptionsFlag}`, 'mpegts_copyts=1');
  args.push('-start_number', String(p.startSegment), '-hls_segment_filename', path.join(p.segDir, 'seg%05d.ts'), path.join(p.segDir, '_ffmpeg.m3u8'));
  return args;
}

interface Waiter {
  index: number;
  deadline: number;
  resolve: (file: string) => void;
  reject: (err: Error) => void;
}

interface Job {
  key: string;
  mediaId: string;
  rendition: RenditionId;
  src: JobSource;
  dir: string;
  startedAt: number;
  lastRequestAt: number;
  /** Segment the current ffmpeg process started at. */
  procStart: number;
  /** First segment not yet complete. Advances through cached segments too. */
  nextSegment: number;
  /** First already-cached segment at/after procStart (or segmentCount): ffmpeg stops there. */
  stopAt: number;
  proc: ChildProcess | null;
  procExited: boolean;
  exitCode: number | null;
  killing: boolean;
  stderr: string;
  waiters: Waiter[];
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  ended: boolean;
  lastEmitAt: number;
}

export interface JobSummary {
  mediaId: string;
  rendition: RenditionId;
  nextSegment: number;
  startedAt: number;
}

export class Transcoder {
  private readonly jobs = new Map<string, Job>();
  private readonly locks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly o: TranscoderOptions) {}

  renditionDir(mediaId: string, rendition: RenditionId): string {
    return path.join(this.o.cacheDir, mediaId, rendition);
  }

  segmentPath(mediaId: string, rendition: RenditionId, index: number): string {
    return path.join(this.renditionDir(mediaId, rendition), segmentFileName(index));
  }

  hasJob(mediaId: string): boolean {
    for (const j of this.jobs.values()) if (j.mediaId === mediaId) return true;
    return false;
  }

  list(): JobSummary[] {
    return [...this.jobs.values()].map((j) => ({ mediaId: j.mediaId, rendition: j.rendition, nextSegment: j.nextSegment, startedAt: j.startedAt }));
  }

  /** Resolve with the complete segment file, starting/redirecting a job when needed. */
  async getSegment(src: JobSource, index: number): Promise<string> {
    if (!Number.isInteger(index) || index < 0 || index >= src.segmentCount) {
      throw new MediaError('not_found', `segment ${index} is outside 0..${src.segmentCount - 1}`);
    }
    const segPath = this.segmentPath(src.mediaId, src.rung.id, index);
    if (await exists(segPath)) return segPath;
    if (this.closed) throw new MediaError('transcode_failed', 'media service is shutting down');

    const key = `${src.mediaId}/${src.rung.id}`;
    const job = await this.withLock(key, async (): Promise<Job | null> => {
      if (await exists(segPath)) return null;
      const now = Date.now();
      const current = this.jobs.get(key);
      if (current && !current.ended && index >= current.nextSegment && index <= current.nextSegment + SEGMENT_WINDOW) {
        current.lastRequestAt = now;
        return current;
      }
      if (current) {
        this.o.log.debug(`transcode ${key}: segment ${index} is outside [${current.nextSegment}, ${current.nextSegment + SEGMENT_WINDOW}]; restarting at ${index}`);
        await this.endJob(current, 'restarted');
      }
      await this.ensureCapacity();
      return this.startJob(src, key, index, now);
    });
    if (!job) return segPath;
    return this.waitFor(job, index);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const all = [...this.jobs.values()];
    await Promise.all(all.map((j) => this.endJob(j, 'shut down')));
  }

  // ---------------------------------------------------------------- internals

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => mine);
    this.locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  private waitFor(job: Job, index: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (job.ended) {
        reject(new MediaError('transcode_failed', 'transcode job ended before the segment was produced'));
        return;
      }
      job.waiters.push({ index, deadline: Date.now() + this.o.waitMs, resolve, reject });
      void this.tick(job);
    });
  }

  private async ensureCapacity(): Promise<void> {
    while (this.jobs.size >= Math.max(1, this.o.maxJobs)) {
      let victim: Job | null = null;
      for (const j of this.jobs.values()) {
        if (!victim || j.lastRequestAt < victim.lastRequestAt) victim = j;
      }
      if (!victim) return;
      const idleMs = Date.now() - victim.lastRequestAt;
      const msg = `transcode ${victim.key}: killed to free a slot (idle ${(idleMs / 1000).toFixed(0)} s)`;
      if (idleMs >= this.o.idleMs) this.o.log.debug(msg);
      else this.o.log.warn(msg);
      await this.endJob(victim, 'preempted');
    }
  }

  private async existingSegments(dir: string): Promise<Set<number>> {
    const set = new Set<number>();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return set;
    }
    for (const n of names) {
      const k = parseSegmentFileName(n);
      if (k !== null) set.add(k);
    }
    return set;
  }

  private async cleanTemp(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((n) => n.endsWith('.tmp'))
        .map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => undefined)),
    );
  }

  private async startJob(src: JobSource, key: string, index: number, now: number): Promise<Job> {
    const dir = this.renditionDir(src.mediaId, src.rung.id);
    await fs.mkdir(dir, { recursive: true });
    await this.cleanTemp(dir);
    const have = await this.existingSegments(dir);
    let stopAt = index + 1;
    while (stopAt < src.segmentCount && !have.has(stopAt)) stopAt++;
    const job: Job = {
      key,
      mediaId: src.mediaId,
      rendition: src.rung.id,
      src,
      dir,
      startedAt: now,
      lastRequestAt: now,
      procStart: index,
      nextSegment: index,
      stopAt,
      proc: null,
      procExited: false,
      exitCode: null,
      killing: false,
      stderr: '',
      waiters: [],
      timer: null,
      ticking: false,
      ended: false,
      lastEmitAt: 0,
    };
    this.jobs.set(key, job);
    this.spawnProc(job, index);
    job.timer = setInterval(() => void this.tick(job), this.o.pollMs);
    return job;
  }

  private spawnProc(job: Job, startSegment: number): void {
    const args = buildJobArgs({
      file: job.src.file,
      startSegment,
      videoIndex: job.src.videoIndex,
      audioIndex: job.src.audioIndex,
      rung: job.src.rung,
      encoder: this.o.encoder,
      x264Preset: this.o.x264Preset,
      segDir: job.dir,
      hlsSegmentOptionsFlag: this.o.hlsSegmentOptionsFlag,
    });
    job.procStart = startSegment;
    job.procExited = false;
    job.exitCode = null;
    job.killing = false;
    job.stderr = '';
    this.o.log.debug(`transcode ${job.key}: ffmpeg from segment ${startSegment} to ${job.stopAt} (${this.o.encoder})`);
    this.o.log.debug(`transcode ${job.key}: ${this.o.ffmpeg} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    let proc: ChildProcess;
    try {
      proc = spawn(this.o.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      job.procExited = true;
      job.exitCode = -1;
      job.stderr = String(err);
      return;
    }
    job.proc = proc;
    proc.stderr?.on('data', (d: Buffer) => {
      job.stderr = tail(job.stderr + d.toString('utf8'), 8192);
    });
    proc.on('error', (err) => {
      job.stderr = tail(`${job.stderr}\n${String(err)}`, 8192);
      job.procExited = true;
      job.exitCode = job.exitCode ?? -1;
    });
    proc.on('close', (code, signal) => {
      job.procExited = true;
      job.exitCode = code ?? (signal ? 128 : -1);
      if (!job.killing && code !== 0) {
        this.o.log.warn(`transcode ${job.key}: ffmpeg exited with ${code ?? signal}: ${lastLines(job.stderr)}`);
      }
      void this.tick(job);
    });
    this.o.emit({ mediaId: job.mediaId, rendition: job.rendition, status: 'starting', readyToSec: this.readyToSec(job) });
  }

  private readyToSec(job: Job): number {
    return Math.min(job.src.durationSec, job.nextSegment * HLS_SEGMENT_SEC);
  }

  private async stopProc(job: Job): Promise<void> {
    const proc = job.proc;
    if (proc && isAlive(proc)) {
      job.killing = true;
      await killTree(proc);
    }
    job.proc = null;
    job.procExited = true;
  }

  private async tick(job: Job): Promise<void> {
    if (job.ticking || job.ended) return;
    job.ticking = true;
    try {
      const n = job.src.segmentCount;
      // Advance the cursor over every complete segment (ours or previously cached).
      let advanced = false;
      while (job.nextSegment < n) {
        const file = this.segmentPath(job.mediaId, job.rendition, job.nextSegment);
        const size = await fileSize(file);
        if (size <= 0 && !(await exists(file))) break;
        if (job.nextSegment >= job.procStart && job.nextSegment < job.stopAt && size > 0) this.o.onSegment?.(job.mediaId, size);
        job.nextSegment++;
        advanced = true;
      }
      const now = Date.now();
      if (advanced && (now - job.lastEmitAt >= 1000 || job.nextSegment >= n)) {
        job.lastEmitAt = now;
        this.o.emit({ mediaId: job.mediaId, rendition: job.rendition, status: 'running', readyToSec: this.readyToSec(job) });
      }

      // Serve waiters.
      if (job.waiters.length) {
        const keep: Waiter[] = [];
        for (const w of job.waiters) {
          const file = this.segmentPath(job.mediaId, job.rendition, w.index);
          if (w.index < job.nextSegment || (await exists(file))) w.resolve(file);
          else if (now >= w.deadline) w.reject(new MediaError('timeout', `segment ${w.index} of ${job.key} not ready after ${this.o.waitMs} ms`));
          else keep.push(w);
        }
        job.waiters = keep;
      }
      if (job.ended) return;

      if (job.nextSegment >= job.stopAt) {
        // ffmpeg has covered its range; the rest is cached or we restart it at the next gap.
        await this.stopProc(job);
        const have = await this.existingSegments(job.dir);
        let m = job.nextSegment;
        while (m < n && have.has(m)) m++;
        if (m >= n) {
          job.nextSegment = n;
          this.finish(job, 'done');
          return;
        }
        let stop = m + 1;
        while (stop < n && !have.has(stop)) stop++;
        job.nextSegment = m;
        job.stopAt = stop;
        this.spawnProc(job, m);
      } else if (job.procExited && !job.killing) {
        if (job.exitCode === 0) {
          // Fewer segments than the playlist promised (a trailing sliver): done anyway.
          this.finish(job, 'done');
        } else {
          this.finish(job, 'error');
        }
      }
    } catch (err) {
      this.o.log.warn(`transcode ${job.key}: tick failed: ${String(err)}`);
    } finally {
      job.ticking = false;
    }
  }

  private finish(job: Job, status: 'done' | 'error'): void {
    if (job.ended) return;
    job.ended = true;
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    const message = status === 'error' ? `ffmpeg exited with ${job.exitCode}: ${lastLines(job.stderr)}` : undefined;
    const waiters = job.waiters;
    job.waiters = [];
    for (const w of waiters) {
      w.reject(
        status === 'done'
          ? new MediaError('not_found', `segment ${w.index} of ${job.key} was not produced`)
          : new MediaError('transcode_failed', message ?? 'transcode failed'),
      );
    }
    const ev: TranscodeEvent = { mediaId: job.mediaId, rendition: job.rendition, status, readyToSec: this.readyToSec(job) };
    if (message) ev.message = message;
    this.o.emit(ev);
    if (status === 'done') this.o.log.debug(`transcode ${job.key}: done`);
  }

  /** Kill a job because of a restart, a slot shortage or shutdown (no done/error event). */
  private async endJob(job: Job, reason: string): Promise<void> {
    if (job.ended) return;
    job.ended = true;
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    await this.stopProc(job);
    const waiters = job.waiters;
    job.waiters = [];
    for (const w of waiters) w.reject(new MediaError('transcode_failed', `transcode job was ${reason}`));
  }
}

function lastLines(s: string, n = 3): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ');
}
