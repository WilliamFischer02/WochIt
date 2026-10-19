import { describe, expect, it } from 'vitest';
import { PlayerTelemetry } from '@wochit/shared';
import { buildTelemetry, bufferedAheadSec, currentRendition, type TelemetryPlayerState, type TelemetryVideoLike } from './telemetry';

function ranges(...r: Array<[number, number]>): TelemetryVideoLike['buffered'] {
  return { length: r.length, start: (i) => r[i]![0], end: (i) => r[i]![1] };
}

function video(over: Partial<TelemetryVideoLike> = {}): TelemetryVideoLike {
  return { currentTime: 12.25, paused: false, ended: false, readyState: 4, buffered: ranges([0, 30]), ...over };
}

const LEVELS = [
  { height: 720, renditionId: '720p' as const },
  { height: 360, renditionId: '360p' as const },
];

function hls(over: Partial<TelemetryPlayerState> = {}): TelemetryPlayerState {
  return { engine: 'hls', hasVideo: true, activeHeight: null, currentLevel: -1, levels: LEVELS, stalled: false, rttMs: 41.6, ...over };
}

describe('bufferedAheadSec', () => {
  it('is the end of the range containing currentTime minus currentTime', () => {
    expect(bufferedAheadSec(ranges([0, 10], [20, 50]), 25)).toBeCloseTo(25);
    expect(bufferedAheadSec(ranges([0, 10], [20, 50]), 5)).toBeCloseTo(5);
  });
  it('is 0 when no range contains currentTime', () => {
    expect(bufferedAheadSec(ranges([0, 10], [20, 50]), 15)).toBe(0);
    expect(bufferedAheadSec(ranges(), 3)).toBe(0);
  });
  it('tolerates a buffer that starts a frame after the playhead', () => {
    expect(bufferedAheadSec(ranges([0.08, 8]), 0)).toBeCloseTo(8);
    expect(bufferedAheadSec(ranges([1, 8]), 0)).toBe(0);
  });
});

describe('currentRendition', () => {
  it('is null without an attached source', () => {
    expect(currentRendition(hls({ engine: null, hasVideo: false }))).toBeNull();
    expect(currentRendition(hls({ hasVideo: false }))).toBeNull();
  });
  it("is 'native' on Safari's own HLS", () => {
    expect(currentRendition(hls({ engine: 'native' }))).toBe('native');
  });
  it('maps the level actually playing to its rendition id', () => {
    expect(currentRendition(hls({ activeHeight: 360 }))).toBe('360p');
    expect(currentRendition(hls({ activeHeight: 720, currentLevel: 1 }))).toBe('720p');
  });
  it('falls back to the chosen level before the first switch, else auto', () => {
    expect(currentRendition(hls({ currentLevel: 1 }))).toBe('360p');
    expect(currentRendition(hls())).toBe('auto');
    expect(currentRendition(hls({ activeHeight: 1080 }))).toBe('auto');
  });
});

describe('buildTelemetry', () => {
  it('reports a healthy playing guest', () => {
    const t = buildTelemetry(video(), hls({ activeHeight: 720 }));
    expect(t).toEqual({ position: 12.25, playing: true, bufferedAheadSec: 17.75, rendition: '720p', stalled: false, rttMs: 42 });
    expect(PlayerTelemetry.safeParse(t).success).toBe(true);
  });
  it('is not playing when paused, ended, starved, or stalled', () => {
    expect(buildTelemetry(video({ paused: true }), hls()).playing).toBe(false);
    expect(buildTelemetry(video({ ended: true }), hls()).playing).toBe(false);
    expect(buildTelemetry(video({ readyState: 2 }), hls()).playing).toBe(false);
    const stalled = buildTelemetry(video(), hls({ stalled: true }));
    expect(stalled.playing).toBe(false);
    expect(stalled.stalled).toBe(true);
  });
  it('has a null rtt before the first pong and null rendition with nothing loaded', () => {
    const t = buildTelemetry(video({ currentTime: 0, buffered: ranges() }), hls({ engine: null, hasVideo: false, rttMs: null }));
    expect(t.rttMs).toBeNull();
    expect(t.rendition).toBeNull();
    expect(t.bufferedAheadSec).toBe(0);
    expect(PlayerTelemetry.safeParse(t).success).toBe(true);
  });
  it('never emits a negative position', () => {
    expect(buildTelemetry(video({ currentTime: -0.2 }), hls()).position).toBe(0);
    expect(buildTelemetry(video({ currentTime: Number.NaN }), hls()).position).toBe(0);
  });
});
