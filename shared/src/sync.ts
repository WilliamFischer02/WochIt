// Pure functions for keeping a local <video> on the room's clock. No DOM here, so both the web
// app and unit tests use the same code. docs/ARCHITECTURE.md § Sync explains the policy.
import type { PlaybackState } from './protocol.js';

/** Where the room says the media is at host-clock time `serverNow` (ms). */
export function expectedPosition(state: PlaybackState, serverNow: number): number {
  if (!state.playing) return state.position;
  const elapsed = Math.max(0, serverNow - state.updatedAt) / 1000;
  return state.position + elapsed * state.rate;
}

/** Below this the player leaves the clock alone (seeking constantly stutters more than it helps). */
export const DRIFT_IGNORE_SEC = 0.15;
/** Up to here the player nudges playbackRate instead of seeking, so audio never pops. */
export const DRIFT_NUDGE_SEC = 1.0;
/** How hard to nudge. 1.05x for 1 s of drift closes it in 20 s; invisible to the eye. */
export const NUDGE_RATE = 0.05;

export type DriftAction =
  | { kind: 'none'; rate: 1 }
  | { kind: 'nudge'; rate: number }
  | { kind: 'seek'; to: number };

/**
 * Decide what the local player should do given its currentTime and the room state.
 * `drift` > 0 means the local player is ahead of the room.
 */
export function driftAction(localTime: number, target: number, playing: boolean): DriftAction {
  const drift = localTime - target;
  const abs = Math.abs(drift);
  if (!playing) {
    // Paused: positions must match exactly or the two screens show different frames.
    return abs > DRIFT_IGNORE_SEC ? { kind: 'seek', to: target } : { kind: 'none', rate: 1 };
  }
  if (abs <= DRIFT_IGNORE_SEC) return { kind: 'none', rate: 1 };
  if (abs <= DRIFT_NUDGE_SEC) return { kind: 'nudge', rate: drift > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE };
  return { kind: 'seek', to: target };
}

/**
 * Clock offset = serverTime - localTime, estimated from ping/pong round trips.
 * Keeps the samples with the smallest round-trip (least queueing noise) and returns their median.
 */
export class ClockSync {
  private samples: Array<{ offset: number; rtt: number }> = [];
  constructor(private readonly keep = 8) {}

  addSample(sentLocal: number, serverTime: number, receivedLocal: number): void {
    const rtt = receivedLocal - sentLocal;
    const offset = serverTime - (sentLocal + rtt / 2);
    this.samples.push({ offset, rtt });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  /** ms to add to Date.now() to get host-server time. 0 until the first sample. */
  get offset(): number {
    if (this.samples.length === 0) return 0;
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    const offs = best.map((s) => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(offs.length / 2);
    return offs.length % 2 ? offs[mid]! : (offs[mid - 1]! + offs[mid]!) / 2;
  }

  get rtt(): number {
    if (this.samples.length === 0) return 0;
    return Math.min(...this.samples.map((s) => s.rtt));
  }

  get ready(): boolean {
    return this.samples.length >= 2;
  }

  serverNow(localNow = Date.now()): number {
    return localNow + this.offset;
  }
}
