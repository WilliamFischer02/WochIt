import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { C2S, PlaybackState } from '@wochit/shared';
import { OPTIMISTIC_TTL_MS, PING_FAST_COUNT, PING_FAST_MS, PING_SLOW_MS, SyncController, type VideoLike } from './syncController';
import { useApp } from '../../app/store';

class FakeVideo implements VideoLike {
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  readyState = 4;
  seeking = false;
  plays = 0;
  pauses = 0;
  play() {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.pauses++;
  }
}

function playing(position: number, updatedAt: number, seq = 1): PlaybackState {
  return { seq, source: 'browser', mediaId: 'm', playing: true, position, rate: 1, updatedAt };
}
function paused(position: number, updatedAt: number, seq = 1): PlaybackState {
  return { ...playing(position, updatedAt, seq), playing: false };
}

function harness(initial: PlaybackState | null, opts: { lead?: number; canPlay?: () => boolean } = {}) {
  let now = 100_000;
  let state = initial;
  const sent: C2S[] = [];
  let pongHandler: ((p: { t: number; serverTime: number }) => void) | null = null;
  const offsets: number[] = [];
  const video = new FakeVideo();
  const ctl = new SyncController({
    video,
    getState: () => state,
    send: (m) => {
      sent.push(m);
      return true;
    },
    onPong: (h) => {
      pongHandler = h;
      return () => {
        pongHandler = null;
      };
    },
    onOffset: (ms) => offsets.push(ms),
    now: () => now,
    seekLeadSec: opts.lead ?? 0,
    canPlay: opts.canPlay,
  });
  return {
    ctl,
    video,
    sent,
    offsets,
    setState: (s: PlaybackState | null) => {
      state = s;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
    pong: (p: { t: number; serverTime: number }) => pongHandler?.(p),
  };
}

describe('SyncController drift policy', () => {
  it('nudges the rate for small drift and returns to 1 once in range', () => {
    const h = harness(playing(10, 100_000));
    h.video.paused = false;
    h.video.currentTime = 9.7; // 0.3 s behind the room
    h.ctl.tick();
    expect(h.video.playbackRate).toBeCloseTo(1.05);
    expect(h.ctl.snapshot.syncStatus).toBe('catching-up');
    expect(h.ctl.snapshot.driftSec).toBeCloseTo(-0.3);

    h.video.currentTime = 10;
    h.ctl.tick();
    expect(h.video.playbackRate).toBe(1);
    expect(h.ctl.snapshot.syncStatus).toBe('in-sync');
  });

  it('slows down when ahead', () => {
    const h = harness(playing(10, 100_000));
    h.video.paused = false;
    h.video.currentTime = 10.5;
    h.ctl.tick();
    expect(h.video.playbackRate).toBeCloseTo(0.95);
  });

  it('seeks for large drift', () => {
    const h = harness(playing(10, 100_000));
    h.video.paused = false;
    h.video.currentTime = 12;
    h.ctl.tick();
    expect(h.video.currentTime).toBe(10);
    expect(h.video.playbackRate).toBe(1);
    expect(h.ctl.snapshot.syncStatus).toBe('seeking');
  });

  it('adds the seek lead while playing on a phone', () => {
    const h = harness(playing(10, 100_000), { lead: 0.3 });
    h.video.paused = false;
    h.video.currentTime = 20;
    h.ctl.tick();
    expect(h.video.currentTime).toBeCloseTo(10.3);
  });

  it('projects the room clock forward while playing', () => {
    const h = harness(playing(10, 100_000));
    h.video.paused = false;
    h.advance(5000);
    h.video.currentTime = 15;
    h.ctl.tick();
    expect(h.ctl.snapshot.syncStatus).toBe('in-sync');
    expect(h.ctl.snapshot.target).toBeCloseTo(15);
  });

  it('seeks exactly when paused with an offset, and pauses a running video', () => {
    const h = harness(paused(30, 100_000));
    h.video.paused = false;
    h.video.currentTime = 30.5;
    h.ctl.tick();
    expect(h.video.pauses).toBe(1);
    expect(h.video.currentTime).toBe(30);
    h.ctl.tick();
    expect(h.ctl.snapshot.syncStatus).toBe('paused');
  });

  it('starts a paused video when the room plays, and never before the gesture gate opens', () => {
    let gate = false;
    const h = harness(playing(10, 100_000), { canPlay: () => gate });
    h.video.currentTime = 0;
    h.ctl.tick();
    expect(h.video.plays).toBe(0);
    expect(h.ctl.snapshot.syncStatus).toBe('waiting');
    gate = true;
    h.ctl.tick();
    expect(h.video.plays).toBe(1);
    expect(h.video.currentTime).toBe(10);
  });

  it('does nothing without media', () => {
    const h = harness({ ...paused(0, 100_000), mediaId: null, source: 'none' });
    h.ctl.tick();
    expect(h.ctl.snapshot.syncStatus).toBe('waiting');
    expect(h.ctl.snapshot.target).toBeNull();
  });
});

describe('SyncController intents (optimistic, reconciled by seq)', () => {
  it('pause: sends control, pauses at once, holds until the server echoes a newer seq', () => {
    const h = harness(playing(10, 100_000, 7));
    h.video.paused = false;
    h.video.currentTime = 10;
    h.ctl.intent('pause');
    expect(h.sent.at(-1)).toEqual({ type: 'control', action: 'pause' });
    expect(h.video.paused).toBe(true);
    expect(h.ctl.snapshot.syncStatus).toBe('paused');

    // A heartbeat with the same seq (stale relative to the intent) must not resume us.
    h.setState(playing(10, 100_000, 7));
    h.ctl.tick();
    expect(h.video.paused).toBe(true);
    expect(h.video.plays).toBe(0);

    // The echo with a newer seq wins.
    h.setState(paused(10, h.now, 8));
    h.ctl.tick();
    expect(h.ctl.effectiveState()?.seq).toBe(8);
    expect(h.video.paused).toBe(true);
  });

  it('seek: moves the video and reports position', () => {
    const h = harness(paused(10, 100_000, 3));
    h.video.currentTime = 10;
    h.ctl.intent('seek', 30);
    expect(h.sent.at(-1)).toEqual({ type: 'control', action: 'seek', position: 30 });
    expect(h.video.currentTime).toBe(30);
    expect(h.ctl.effectiveState()?.position).toBe(30);
  });

  it('expires the optimistic state after the TTL when no echo comes', () => {
    const h = harness(playing(10, 100_000, 3));
    h.video.paused = false;
    h.ctl.intent('pause');
    expect(h.ctl.effectiveState()?.playing).toBe(false);
    h.advance(OPTIMISTIC_TTL_MS + 1);
    expect(h.ctl.effectiveState()?.playing).toBe(true);
  });

  it('a stale server state (lower seq) is dropped by the store', () => {
    useApp.getState().applyS2C({ type: 'state', state: playing(5, 1, 5) });
    useApp.getState().applyS2C({ type: 'state', state: playing(99, 1, 3) });
    expect(useApp.getState().playback?.seq).toBe(5);
    expect(useApp.getState().playback?.position).toBe(5);
    useApp.getState().applyS2C({ type: 'state', state: playing(42, 1, 6) });
    expect(useApp.getState().playback?.position).toBe(42);
  });
});

describe('SyncController clock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pings 2 s × 5 then every 10 s', () => {
    const h = harness(null);
    h.ctl.start();
    const pings = () => h.sent.filter((m) => m.type === 'ping').length;
    expect(pings()).toBe(1);
    vi.advanceTimersByTime(PING_FAST_MS * (PING_FAST_COUNT - 1));
    expect(pings()).toBe(PING_FAST_COUNT);
    vi.advanceTimersByTime(PING_SLOW_MS - 1);
    expect(pings()).toBe(PING_FAST_COUNT);
    vi.advanceTimersByTime(1);
    expect(pings()).toBe(PING_FAST_COUNT + 1);
    h.ctl.stop();
    vi.advanceTimersByTime(60_000);
    expect(pings()).toBe(PING_FAST_COUNT + 1);
  });

  it('turns pongs into a server offset', () => {
    const h = harness(null);
    h.ctl.start();
    const t = h.now;
    h.advance(40); // 40 ms round trip
    h.pong({ t, serverTime: t + 20 + 500 }); // server is 500 ms ahead
    expect(h.offsets.at(-1)).toBeCloseTo(500);
    expect(h.ctl.serverNow()).toBeCloseTo(h.now + 500);
    h.ctl.stop();
  });
});
