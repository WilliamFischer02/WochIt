// What a guest's player tells the host with every ping (PlayerTelemetry in shared/src/protocol.ts),
// as a pure function over a video-like object and the player store's view of hls.js, so vitest
// can pin the rules down without a DOM. `useSyncController` feeds it the real <video>.
import type { PlayerTelemetry, RenditionId } from '@wochit/shared';

/** The subset of HTMLVideoElement the builder reads. */
export interface TelemetryVideoLike {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly buffered: { readonly length: number; start(i: number): number; end(i: number): number };
}

/** The player store's knowledge of the engine, mirrored here so the builder stays store-free. */
export interface TelemetryPlayerState {
  engine: 'hls' | 'native' | null;
  /** A source is attached (manifest parsed / native src set). */
  hasVideo: boolean;
  /** hls.js: height of the level actually rendering (LEVEL_SWITCHED), null until the first switch. */
  activeHeight: number | null;
  /** hls.js: the level the user asked for; -1 = auto. */
  currentLevel: number;
  /** hls.js levels by index, each with the rendition it corresponds to in the room's media. */
  levels: ReadonlyArray<{ height: number; renditionId: RenditionId | null }>;
  /** A `waiting` fired since the last `playing` / advancing `timeupdate`. */
  stalled: boolean;
  /** Last measured ping round trip, ms; null before the first pong. */
  rttMs: number | null;
}

/** HAVE_FUTURE_DATA: the element has enough to advance at least a little. */
const HAVE_FUTURE_DATA = 3;
/** hls.js buffers often start a frame or two after currentTime; treat that as "containing". */
const BUFFER_START_TOLERANCE_SEC = 0.25;

/** Seconds buffered past `t`: end of the buffered range containing `t` minus `t`; 0 when none does. */
export function bufferedAheadSec(buffered: TelemetryVideoLike['buffered'], t: number): number {
  let ahead = 0;
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (t >= start - BUFFER_START_TOLERANCE_SEC && t <= end) ahead = Math.max(ahead, end - t);
  }
  return ahead;
}

/** Which rendition the player is really on; see PlayerTelemetry.rendition for the vocabulary. */
export function currentRendition(p: TelemetryPlayerState): PlayerTelemetry['rendition'] {
  if (!p.engine || !p.hasVideo) return null;
  if (p.engine === 'native') return 'native';
  if (p.activeHeight !== null) {
    const level = p.levels.find((l) => l.height === p.activeHeight);
    if (level?.renditionId) return level.renditionId;
  }
  if (p.currentLevel >= 0) {
    const chosen = p.levels[p.currentLevel];
    if (chosen?.renditionId) return chosen.renditionId;
  }
  return 'auto';
}

export function buildTelemetry(video: TelemetryVideoLike, p: TelemetryPlayerState): PlayerTelemetry {
  const position = Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : 0;
  const playing = !video.paused && !video.ended && video.readyState >= HAVE_FUTURE_DATA && !p.stalled;
  return {
    position: Math.round(position * 1000) / 1000,
    playing,
    bufferedAheadSec: Math.round(bufferedAheadSec(video.buffered, position) * 100) / 100,
    rendition: currentRendition(p),
    stalled: p.stalled,
    rttMs: p.rttMs === null ? null : Math.max(0, Math.round(p.rttMs)),
  };
}
