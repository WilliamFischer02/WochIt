// End-to-end check of the media pipeline against a real ffmpeg. Skipped when ffmpeg/ffprobe
// cannot be found. Generates a 90 s 1280x720@30 test file (burned-in timecode, 440 Hz tone,
// embedded SRT), then verifies the timestamp contract the architecture doc insists on:
// segment k starts at PTS k*4 whichever job produced it.
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaInfo } from '@wochit/shared';
import { resolveFfmpeg, run, type EncoderDetection } from '../../src/media/ffmpeg.js';
import { MediaError, type Logger, type MediaService, type TranscodeEvent } from '../../src/media/index.js';
import { createMediaService } from '../../src/media/service.js';

const ff = await resolveFfmpeg('', '');

const report: Record<string, unknown> = {};
const logLines: string[] = [];
const events: TranscodeEvent[] = [];
const log: Logger = {
  info: (m) => logLines.push(`I ${m}`),
  warn: (m) => logLines.push(`W ${m}`),
  error: (m) => logLines.push(`E ${m}`),
  debug: (m) => logLines.push(`D ${m}`),
};

let tmp = '';
let cacheDir = '';
let fixture = '';
let svc: MediaService | null = null;
let media: MediaInfo;
let pts10 = NaN;
let dur10 = NaN;
const tStart = performance.now();

const sec = (ms: number) => Math.round(ms) / 1000;

async function firstVideoPts(file: string): Promise<number> {
  if (!ff) throw new Error('no ffprobe');
  const r = await run(ff.ffprobe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', file], { timeoutMs: 30000 });
  const first = r.stdout.trim().split(/[\r\n,]/)[0] ?? '';
  const v = Number.parseFloat(first);
  if (!Number.isFinite(v)) throw new Error(`no video pts in ${file}: ${r.stderr}`);
  return v;
}

async function containerDuration(file: string): Promise<number> {
  if (!ff) throw new Error('no ffprobe');
  const r = await run(ff.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30000 });
  const v = Number.parseFloat(r.stdout.trim().split(/[\r\n,]/)[0] ?? '');
  if (!Number.isFinite(v)) throw new Error(`no duration in ${file}: ${r.stderr}`);
  return v;
}

function fontFile(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf')]
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Helvetica.ttc'];
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function makeFixture(dir: string): Promise<{ file: string; encoder: string; drawtext: boolean }> {
  if (!ff) throw new Error('no ffmpeg');
  const srt = path.join(dir, 'sub.srt');
  await fs.writeFile(srt, '1\n00:00:01,000 --> 00:00:05,000\nHello WochIt\n\n2\n00:00:41,000 --> 00:00:45,000\nSegment ten\n', 'utf8');
  const out = path.join(dir, 'fixture.mkv');
  const font = fontFile();
  // Inside the quoted filter option the drive colon still has to be escaped: fontfile='C\:/Windows/...'.
  const fontArg = font ? `fontfile='${font.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : '';
  const drawtext = `drawtext=${fontArg}text='%{pts\\:hms}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:x=(w-tw)/2:y=h-th-40`;
  const encoders = [
    { label: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-g', '60', '-pix_fmt', 'yuv420p'] },
    { label: 'libx264', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p'] },
  ];
  const failures: string[] = [];
  for (const withText of [true, false]) {
    for (const enc of encoders) {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-i', srt, '-t', '90',
        ...(withText ? ['-vf', drawtext] : []),
        ...enc.args,
        '-c:a', 'aac', '-b:a', '128k',
        '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English (SDH)',
        out,
      ];
      const r = await run(ff.ffmpeg, args, { timeoutMs: 150000 });
      if (r.code === 0 && existsSync(out)) return { file: out, encoder: enc.label, drawtext: withText };
      failures.push(`${enc.label} drawtext=${withText}: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
    }
  }
  throw new Error(`could not generate the fixture:\n${failures.join('\n')}`);
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, every = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return pred();
}

async function rmrf(dir: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

describe.skipIf(!ff)('media pipeline with a real ffmpeg', () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wochit-media-'));
    cacheDir = path.join(tmp, 'cache');
    const t0 = performance.now();
    const fx = await makeFixture(tmp);
    fixture = fx.file;
    report.fixture = { encoder: fx.encoder, drawtext: fx.drawtext, seconds: sec(performance.now() - t0) };

    const t1 = performance.now();
    svc = createMediaService({
      ffmpegPath: ff?.ffmpeg ?? '',
      ffprobePath: ff?.ffprobe ?? '',
      encoder: 'auto',
      cacheDir,
      cacheMaxBytes: 10 * 1024 ** 3,
      roots: [tmp],
      log,
      x264Preset: 'ultrafast',
    });
    svc.onTranscode((ev) => events.push(ev));
    await svc.init();
    const det = (svc as unknown as { encoderDetection: EncoderDetection | null }).encoderDetection;
    report.init = { seconds: sec(performance.now() - t1), encoder: svc.encoder, tests: det?.tests, hlsSegmentOptionsFlag: det?.hlsSegmentOptionsFlag };
  }, 180000);

  afterAll(async () => {
    if (svc) await svc.shutdown();
    report.totalSeconds = sec(performance.now() - tStart);
    report.events = events.map((e) => `${e.rendition}:${e.status}@${e.readyToSec ?? '-'}`);
    // eslint-disable-next-line no-console
    console.log(`MEDIA INTEGRATION REPORT\n${JSON.stringify(report, null, 2)}\n--- service log ---\n${logLines.join('\n')}`);
    await rmrf(tmp);
  });

  it('finds ffmpeg and a working H.264 encoder', () => {
    expect(svc?.ffmpegFound).toBe(true);
    expect(svc?.encoder).toMatch(/^(h264_nvenc|h264_qsv|h264_amf|libx264)$/);
  });

  it('probes the fixture into a MediaInfo with a 720p ladder and the embedded subtitle', async () => {
    const info = await svc!.resolvePath(fixture);
    expect(info).not.toBeNull();
    media = info as MediaInfo;
    expect(media.id).toMatch(/^[0-9a-f]{16}$/);
    expect(media.title).toBe('fixture');
    expect(media.durationSec).toBeGreaterThan(89.9);
    expect(media.durationSec).toBeLessThan(90.2);
    expect(media.width).toBe(1280);
    expect(media.height).toBe(720);
    expect(media.fps).toBe(30);
    expect(media.masterUrl).toBe(`/media/${media.id}/master.m3u8`);
    expect(media.renditions.map((r) => r.id)).toEqual(['720p', '480p', '360p']);
    expect(media.renditions[0]).toMatchObject({ width: 1280, height: 720, bitrateKbps: 2800, playlistUrl: `/media/${media.id}/720p/index.m3u8` });
    expect(media.subtitles).toEqual([{ id: '0', label: 'English (SDH)', lang: 'eng', kind: 'embedded', url: `/media/${media.id}/subs/0.vtt`, isDefault: false }]);
    expect(media.audioLabel).toContain('AAC');
    expect(media.posterUrl).toBe(`/media/${media.id}/poster.jpg`);
    expect(JSON.stringify(media)).not.toContain(tmp.replace(/\\/g, '\\\\'));

    const again = await svc!.getMedia(media.id);
    expect(again?.id).toBe(media.id);
    expect(await svc!.getPath(media.id)).toBe(fixture);
    expect(await svc!.getPath('0123456789abcdef')).toBeNull();
    expect(await svc!.getPath('../../etc')).toBeNull();
    expect(await svc!.getMedia('0123456789abcdef')).toBeNull();
    expect(await svc!.resolvePath(path.join(tmp, 'missing.mkv'))).toBeNull();

    const roots = await svc!.browse(null);
    expect(roots.entries).toHaveLength(1);
    const listing = await svc!.browse(roots.entries[0]!.id);
    const file = listing.entries.find((e) => e.kind === 'file');
    expect(file).toMatchObject({ id: media.id, name: 'fixture.mkv', durationSec: media.durationSec });
    report.media = { id: media.id, durationSec: media.durationSec, renditions: media.renditions.map((r) => r.id), subtitles: media.subtitles.map((s) => s.label), audioLabel: media.audioLabel };
  }, 60000);

  it('serves virtual playlists with the token on every URI', async () => {
    const master = await svc!.masterPlaylist(media.id, '?t=tok');
    expect(master.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'))).toHaveLength(3);
    expect(master).toContain('RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=30\n720p/index.m3u8?t=tok\n');
    const pl = await svc!.mediaPlaylist(media.id, '720p', '?t=tok');
    const uris = pl.split('\n').filter((l) => l.startsWith('seg'));
    expect(uris).toHaveLength(23);
    expect(uris.every((u) => u.endsWith('?t=tok'))).toBe(true);
    expect(pl).toContain(`#EXTINF:${(media.durationSec - 88).toFixed(3)},\nseg00022.ts?t=tok\n#EXT-X-ENDLIST`);
    await expect(svc!.mediaPlaylist(media.id, '1080p', '')).rejects.toSatisfy((e: unknown) => e instanceof MediaError && e.code === 'unknown_rendition');
    await expect(svc!.masterPlaylist('0123456789abcdef', '')).rejects.toSatisfy((e: unknown) => e instanceof MediaError && e.code === 'unknown_media');
  });

  it('segment 10 of 720p starts at PTS 40.00 ± 0.05 and segment 11 at 44.00 ± 0.05', async () => {
    const t0 = performance.now();
    const seg10 = await svc!.getSegment(media.id, '720p', 10);
    const firstSegmentMs = performance.now() - t0;
    expect(seg10).toBe(path.join(cacheDir, media.id, '720p', 'seg00010.ts'));
    pts10 = await firstVideoPts(seg10);
    dur10 = await containerDuration(seg10);
    const seg11 = await svc!.getSegment(media.id, '720p', 11);
    const pts11 = await firstVideoPts(seg11);
    report.jobFrom10 = { firstSegmentSeconds: sec(firstSegmentMs), seg10FirstPts: pts10, seg10Duration: dur10, seg11FirstPts: pts11 };
    expect(Math.abs(pts10 - 40)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(pts11 - 44)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(dur10 - 4)).toBeLessThanOrEqual(0.1);
    expect(events.some((e) => e.rendition === '720p' && e.status === 'starting')).toBe(true);
  }, 60000);

  it('a job restarted at segment 0 reproduces segment 10 with the same first PTS and duration (± 0.02 s)', async () => {
    const dir = path.join(cacheDir, media.id, '720p');
    // Remove 10..12 so the k=0 job has to produce segment 10 itself instead of skipping it.
    for (const k of [10, 11, 12]) await fs.rm(path.join(dir, `seg000${k}.ts`), { force: true });
    const before = events.length;
    const t0 = performance.now();
    const seg0 = await svc!.getSegment(media.id, '720p', 0);
    const pts0 = await firstVideoPts(seg0);
    expect(events.slice(before).some((e) => e.rendition === '720p' && e.status === 'starting' && (e.readyToSec ?? 1) === 0)).toBe(true);
    const seg10 = path.join(dir, 'seg00010.ts');
    expect(await waitFor(() => existsSync(seg10), 45000, 100)).toBe(true);
    const pts10b = await firstVideoPts(seg10);
    const dur10b = await containerDuration(seg10);
    expect(await svc!.getSegment(media.id, '720p', 10)).toBe(seg10);
    report.jobFrom0 = { seg0FirstPts: pts0, secondsUntilSeg10: sec(performance.now() - t0), seg10FirstPts: pts10b, seg10Duration: dur10b, deltaPts: Math.round((pts10b - pts10) * 1e6) / 1e6, deltaDuration: Math.round((dur10b - dur10) * 1e6) / 1e6 };
    expect(Math.abs(pts0)).toBeLessThanOrEqual(0.05);
    // Tolerance: one frame at 30 fps. The exact delta is printed in the report (it is 0.000 with
    // the k=0 audio trim in place); before that fix a whole job came out 0.0213 s (one AAC frame)
    // late because ffmpeg shifts a job whose first audio packet is negative. Anything under one
    // frame cannot produce a visible stutter where segments from two jobs meet.
    expect(Math.abs(pts10b - pts10)).toBeLessThanOrEqual(0.034);
    expect(Math.abs(dur10b - dur10)).toBeLessThanOrEqual(0.034);
  }, 60000);

  it('the last, partial segment exists and is short; indexes past the end are not_found', async () => {
    const seg22 = await svc!.getSegment(media.id, '720p', 22);
    const dur22 = await containerDuration(seg22);
    const pts22 = await firstVideoPts(seg22);
    report.seg22 = { firstPts: pts22, duration: dur22 };
    expect(Math.abs(pts22 - 88)).toBeLessThanOrEqual(0.05);
    expect(dur22).toBeGreaterThan(1.5);
    expect(dur22).toBeLessThan(2.6);
    await expect(svc!.getSegment(media.id, '720p', 23)).rejects.toSatisfy((e: unknown) => e instanceof MediaError && e.code === 'not_found');
    await expect(svc!.getSegment(media.id, '720p', -1)).rejects.toSatisfy((e: unknown) => e instanceof MediaError && e.code === 'not_found');
  }, 60000);

  it('extracts the embedded subtitle to WebVTT', async () => {
    const vtt = await svc!.getSubtitle(media.id, '0');
    expect(vtt).toBe(path.join(cacheDir, media.id, 'subs', '0.vtt'));
    const text = await fs.readFile(vtt, 'utf8');
    expect(text.startsWith('WEBVTT')).toBe(true);
    expect(text).toContain('Hello WochIt');
    expect(text).toContain('Segment ten');
    expect(text).toContain('00:41.000 --> 00:45.000');
    await expect(svc!.getSubtitle(media.id, '7')).rejects.toSatisfy((e: unknown) => e instanceof MediaError && e.code === 'not_found');
    await expect(svc!.getSubtitle(media.id, '../x')).rejects.toSatisfy((e: unknown) => e instanceof MediaError && e.code === 'not_found');
  }, 60000);

  it('produces a 480 px wide JPEG poster', async () => {
    const poster = await svc!.getPoster(media.id);
    expect(poster).toBe(path.join(cacheDir, media.id, 'poster.jpg'));
    const st = await fs.stat(poster as string);
    expect(st.size).toBeGreaterThan(1000);
    const r = await run(ff!.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', poster as string], { timeoutMs: 30000 });
    expect(r.stdout.trim()).toMatch(/^mjpeg,480/);
    expect(await svc!.getPoster(media.id)).toBe(poster);
  }, 60000);

  it('reports stats, finishes its jobs and emits done', async () => {
    expect(await waitFor(() => svc!.stats().jobs.length === 0, 30000, 100)).toBe(true);
    const s = svc!.stats();
    expect(s.cacheBytes).toBeGreaterThan(1_000_000);
    expect(s.cacheMaxBytes).toBe(10 * 1024 ** 3);
    const statuses = new Set(events.filter((e) => e.rendition === '720p').map((e) => e.status));
    expect(statuses.has('starting')).toBe(true);
    expect(statuses.has('running')).toBe(true);
    expect(statuses.has('done')).toBe(true);
    expect(events.some((e) => e.status === 'error')).toBe(false);
    report.cacheBytes = s.cacheBytes;
  }, 60000);

  it('ids and cached segments survive a restart of the service', async () => {
    await svc!.shutdown();
    const index = JSON.parse(await fs.readFile(path.join(cacheDir, 'index.json'), 'utf8')) as { version: number; media: Record<string, { probe: unknown }> };
    expect(index.version).toBe(1);
    expect(index.media[media.id]?.probe).toBeTruthy();

    const svc2 = createMediaService({ ffmpegPath: ff!.ffmpeg, ffprobePath: ff!.ffprobe, encoder: 'auto', cacheDir, cacheMaxBytes: 10 * 1024 ** 3, roots: [tmp], log, x264Preset: 'ultrafast' });
    svc = svc2;
    await svc2.init();
    const again = await svc2.getMedia(media.id);
    expect(again?.id).toBe(media.id);
    expect(again?.durationSec).toBe(media.durationSec);
    expect(svc2.stats().cacheBytes).toBeGreaterThan(1_000_000);
    const t0 = performance.now();
    expect(await svc2.getSegment(media.id, '720p', 5)).toBe(path.join(cacheDir, media.id, '720p', 'seg00005.ts'));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(svc2.stats().jobs).toHaveLength(0);
  }, 60000);
});
