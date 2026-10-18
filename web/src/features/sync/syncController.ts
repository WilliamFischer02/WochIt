// The sync controller from docs/ARCHITECTURE.md § Sync, as a plain class over a video-like object
// so vitest can drive it with a fake element and fake timers. `useSyncController` wires it to a
// real <video>, the store and the socket.
import {
  ClockSync,
  DRIFT_IGNORE_SEC,
  driftAction,
  expectedPosition,
  type C2S,
  type PlaybackState,
} from '@wochit/shared';

export type SyncStatus = 'in-sync' | 'catching-up' | 'seeking' | 'paused' | 'waiting';

export interface SyncSnapshot {
  syncStatus: SyncStatus;
  /** local − target, seconds. Positive = this player is ahead of the room. */
  driftSec: number;
  /** Where the room says we should be right now, or null without media. */
  target: number | null;
}

/** The subset of HTMLVideoElement the controller touches. */
export interface VideoLike {
  currentTime: number;
  readonly paused: boolean;
  playbackRate: number;
  readonly readyState: number;
  readonly seeking: boolean;
  play(): Promise<void> | void;
  pause(): void;
}

export type ControlAction = 'play' | 'pause' | 'toggle' | 'seek';

export interface SyncControllerDeps {
  video: VideoLike;
  /** Server-authoritative state from the store (null before welcome). */
  getState(): PlaybackState | null;
  send(msg: C2S): boolean;
  /** Subscribe to pong frames. Returns the unsubscribe. */
  onPong(handler: (pong: { t: number; serverTime: number }) => void): () => void;
  onOffset?(offsetMs: number): void;
  onSnapshot?(snap: SyncSnapshot): void;
  /** Local wall clock, ms. Defaults to Date.now (fake timers patch it). */
  now?(): number;
  /** Seconds added to seek targets while playing, to cover seek latency on phones. */
  seekLeadSec?: number;
  /** iOS gesture gate: while false the controller never calls play(). */
  canPlay?(): boolean;
}

export const PING_FAST_MS = 2000;
export const PING_FAST_COUNT = 5;
export const PING_SLOW_MS = 10_000;
export const TICK_MS = 500;
/** How long an optimistic local intent stands before the server state wins regardless. */
export const OPTIMISTIC_TTL_MS = 1500;

const HAVE_METADATA = 1;

export class SyncController {
  readonly clock = new ClockSync();
  snapshot: SyncSnapshot = { syncStatus: 'waiting', driftSec: 0, target: null };

  private optimistic: { state: PlaybackState; baseSeq: number; expiresAt: number } | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pingsSent = 0;
  private unsubPong: (() => void) | null = null;
  private running = false;

  constructor(private readonly deps: SyncControllerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  serverNow(): number {
    return this.clock.serverNow(this.now());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pingsSent = 0;
    this.unsubPong = this.deps.onPong((pong) => this.handlePong(pong));
    this.ping();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pingTimer = null;
    this.tickTimer = null;
    this.unsubPong?.();
    this.unsubPong = null;
    this.deps.video.playbackRate = 1;
  }

  /** Re-arm the fast ping burst, e.g. after a reconnect. */
  resyncClock(): void {
    this.pingsSent = 0;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.ping();
  }

  private ping(): void {
    if (!this.running) return;
    this.deps.send({ type: 'ping', t: this.now() });
    this.pingsSent++;
    const delay = this.pingsSent < PING_FAST_COUNT ? PING_FAST_MS : PING_SLOW_MS;
    this.pingTimer = setTimeout(() => this.ping(), delay);
  }

  private handlePong(pong: { t: number; serverTime: number }): void {
    this.clock.addSample(pong.t, pong.serverTime, this.now());
    this.deps.onOffset?.(this.clock.offset);
  }

  /** Server state, unless a fresh local intent is still waiting for its echo. */
  effectiveState(): PlaybackState | null {
    const server = this.deps.getState();
    if (this.optimistic) {
      const superseded = server !== null && server.seq > this.optimistic.baseSeq;
      const expired = this.now() >= this.optimistic.expiresAt;
      if (superseded || expired) this.optimistic = null;
      else return this.optimistic.state;
    }
    return server;
  }

  /**
   * A local intent: send `control`, apply it to the video at once, and hold the predicted state
   * until the server's next `state` (seq above ours) or OPTIMISTIC_TTL_MS, whichever first.
   */
  intent(action: ControlAction, position?: number): void {
    const base = this.effectiveState();
    const msg: C2S = action === 'seek' ? { type: 'control', action, position: Math.max(0, position ?? 0) } : { type: 'control', action };
    this.deps.send(msg);
    if (!base || !base.mediaId) return;

    const serverNow = this.serverNow();
    const cur = expectedPosition(base, serverNow);
    let next: PlaybackState;
    switch (action) {
      case 'play':
        next = { ...base, playing: true, position: cur, updatedAt: serverNow };
        break;
      case 'pause':
        next = { ...base, playing: false, position: cur, updatedAt: serverNow };
        break;
      case 'toggle':
        next = { ...base, playing: !base.playing, position: cur, updatedAt: serverNow };
        break;
      case 'seek':
        next = { ...base, position: Math.max(0, position ?? 0), updatedAt: serverNow };
        break;
    }
    const serverSeq = this.deps.getState()?.seq ?? base.seq;
    this.optimistic = { state: next, baseSeq: serverSeq, expiresAt: this.now() + OPTIMISTIC_TTL_MS };

    const v = this.deps.video;
    if (action === 'seek') v.currentTime = next.position + (next.playing ? this.lead() : 0);
    if (next.playing && v.paused && this.gateOpen()) void Promise.resolve(v.play()).catch(() => undefined);
    if (!next.playing && !v.paused) v.pause();
    this.tick();
  }

  private lead(): number {
    return this.deps.seekLeadSec ?? 0;
  }

  private gateOpen(): boolean {
    return this.deps.canPlay ? this.deps.canPlay() : true;
  }

  private publish(syncStatus: SyncStatus, driftSec: number, target: number | null): void {
    const prev = this.snapshot;
    if (prev.syncStatus === syncStatus && prev.target === target && Math.abs(prev.driftSec - driftSec) < 0.01) return;
    this.snapshot = { syncStatus, driftSec, target };
    this.deps.onSnapshot?.(this.snapshot);
  }

  /** One evaluation of the policy. Runs every TICK_MS and after every state change / intent. */
  tick(): void {
    const v = this.deps.video;
    const state = this.effectiveState();
    if (!state || !state.mediaId) {
      if (!v.paused) v.pause();
      v.playbackRate = 1;
      this.publish('waiting', 0, null);
      return;
    }
    const target = expectedPosition(state, this.serverNow());
    if (v.readyState < HAVE_METADATA) {
      this.publish('waiting', 0, target);
      return;
    }
    const drift = v.currentTime - target;

    if (!state.playing) {
      if (!v.paused) v.pause();
      v.playbackRate = 1;
      const a = driftAction(v.currentTime, target, false);
      if (a.kind === 'seek' && !v.seeking) {
        v.currentTime = a.to;
        this.publish('seeking', drift, target);
      } else {
        this.publish(v.seeking ? 'seeking' : 'paused', drift, target);
      }
      return;
    }

    // Room is playing.
    if (!this.gateOpen()) {
      if (!v.paused) v.pause();
      this.publish('waiting', drift, target);
      return;
    }
    if (v.paused) {
      // Joining playback: land where the room is (plus lead), then play.
      if (Math.abs(drift) > DRIFT_IGNORE_SEC && !v.seeking) v.currentTime = target + this.lead();
      v.playbackRate = 1;
      void Promise.resolve(v.play()).catch(() => undefined);
      this.publish('seeking', drift, target);
      return;
    }
    if (v.seeking) {
      this.publish('seeking', drift, target);
      return;
    }
    const a = driftAction(v.currentTime, target, true);
    switch (a.kind) {
      case 'none':
        v.playbackRate = 1;
        this.publish('in-sync', drift, target);
        return;
      case 'nudge':
        v.playbackRate = a.rate;
        this.publish('catching-up', drift, target);
        return;
      case 'seek':
        v.playbackRate = 1;
        v.currentTime = a.to + this.lead();
        this.publish('seeking', drift, target);
        return;
    }
  }
}
