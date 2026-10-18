import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORCE_KEY_FRAMES_EXPR, buildJobArgs, encoderArgs } from '../../src/media/transcoder.js';

const rung = { id: '720p' as const, width: 1280, height: 720, bitrateKbps: 2800 };
const segDir = path.join('C:', 'cache', 'abcdefabcdefabcd', '720p');

function build(startSegment: number, encoder = 'h264_nvenc', audioIndex: number | null = 1) {
  return buildJobArgs({ file: 'C:\\m\\film.mkv', startSegment, videoIndex: 0, audioIndex, rung, encoder, x264Preset: 'veryfast', segDir, hlsSegmentOptionsFlag: 'hls_segment_options' });
}

function pair(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildJobArgs', () => {
  it('uses the exact force_key_frames expression and the documented HLS flags', () => {
    const args = build(10);
    expect(pair(args, '-force_key_frames')).toBe('expr:if(isnan(prev_forced_t),gte(t,0),gte(t,floor(prev_forced_t/4)*4+4))');
    expect(FORCE_KEY_FRAMES_EXPR).toBe('expr:if(isnan(prev_forced_t),gte(t,0),gte(t,floor(prev_forced_t/4)*4+4))');
    expect(args).toContain('-copyts');
    expect(args).toContain('-start_at_zero');
    expect(pair(args, '-hls_flags')).toBe('temp_file+independent_segments');
    expect(pair(args, '-hls_time')).toBe('4');
    expect(pair(args, '-hls_playlist_type')).toBe('vod');
    expect(pair(args, '-hls_list_size')).toBe('0');
    expect(pair(args, '-hls_segment_options')).toBe('mpegts_copyts=1');
    expect(pair(args, '-start_number')).toBe('10');
    expect(pair(args, '-hls_segment_filename')).toBe(path.join(segDir, 'seg%05d.ts'));
    expect(args[args.length - 1]).toBe(path.join(segDir, '_ffmpeg.m3u8'));
    expect(args.slice(0, 4)).toEqual(['-hide_banner', '-loglevel', 'warning', '-nostdin']);
  });

  it('seeks to k*4 before the input, including an explicit -ss 0 for k = 0', () => {
    const ten = build(10);
    expect(pair(ten, '-ss')).toBe('40');
    expect(ten.indexOf('-ss')).toBeLessThan(ten.indexOf('-i'));
    expect(pair(build(0), '-ss')).toBe('0');
  });

  it('maps the chosen streams by absolute index and transcodes audio to AAC stereo 48 kHz 128k', () => {
    const args = build(3);
    const maps = args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));
    expect(maps).toEqual(['0:0', '0:1']);
    expect(pair(args, '-c:a')).toBe('aac');
    expect(pair(args, '-b:a')).toBe('128k');
    expect(pair(args, '-ac')).toBe('2');
    expect(pair(args, '-ar')).toBe('48000');
    const silent = build(3, 'h264_nvenc', null);
    expect(silent.flatMap((a, i) => (a === '-map' ? [silent[i + 1]] : []))).toEqual(['0:0']);
    expect(silent).not.toContain('-c:a');
  });

  it('scales to the rung with lanczos, square pixels and 8-bit 4:2:0', () => {
    expect(pair(build(0), '-vf')).toBe('scale=1280:720:flags=lanczos,setsar=1,format=yuv420p');
  });

  it('trims the AAC priming only for the job that starts at segment 0', () => {
    expect(pair(build(0), '-af')).toBe('atrim=start=0.0215');
    expect(build(1)).not.toContain('-af');
    expect(build(0, 'h264_nvenc', null)).not.toContain('-af');
  });

  it('nvenc: documented rate control, IDR on forced keyframes, no B-frames', () => {
    const e = encoderArgs('h264_nvenc', 2800, 'veryfast');
    expect(pair(e, '-c:v')).toBe('h264_nvenc');
    expect(pair(e, '-preset')).toBe('p4');
    expect(pair(e, '-rc')).toBe('vbr');
    expect(pair(e, '-cq')).toBe('23');
    expect(pair(e, '-b:v')).toBe('2800k');
    expect(pair(e, '-maxrate')).toBe('3360k');
    expect(pair(e, '-bufsize')).toBe('5600k');
    expect(pair(e, '-profile:v')).toBe('high');
    expect(pair(e, '-forced-idr')).toBe('1');
    expect(pair(e, '-bf')).toBe('0');
    expect(pair(e, '-g')).toBe('240');
  });

  it('libx264 fallback: preset passthrough, crf 23, sc_threshold 0', () => {
    const e = encoderArgs('libx264', 1400, 'ultrafast');
    expect(pair(e, '-c:v')).toBe('libx264');
    expect(pair(e, '-preset')).toBe('ultrafast');
    expect(pair(e, '-crf')).toBe('23');
    expect(pair(e, '-sc_threshold')).toBe('0');
    expect(pair(e, '-maxrate')).toBe('1680k');
    expect(pair(e, '-bf')).toBe('0');
  });

  it('omits the segment options flag when the ffmpeg build has none', () => {
    const args = buildJobArgs({ file: 'f.mkv', startSegment: 0, videoIndex: 0, audioIndex: null, rung, encoder: 'libx264', x264Preset: 'veryfast', segDir, hlsSegmentOptionsFlag: null });
    expect(args).not.toContain('-hls_segment_options');
    expect(args).not.toContain('mpegts_copyts=1');
  });
});
