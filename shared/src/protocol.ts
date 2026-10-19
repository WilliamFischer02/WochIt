// The one source of truth for everything that crosses the wire between the host agent and the
// web app. Both sides validate with these schemas. docs/PROTOCOL.md explains the semantics.
// Change a message here first, then on both sides, then bump PROTOCOL_VERSION if it is breaking.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ------------------------------------------------------------------ primitives

export const RenditionId = z.enum(['1080p', '720p', '480p', '360p']);
export type RenditionId = z.infer<typeof RenditionId>;

export const ReactionKind = z.enum(['cheer', 'boo', 'heart']);
export type ReactionKind = z.infer<typeof ReactionKind>;

/** Who drives the clock. vlc: VLC on the host PC is the master. browser: the host agent holds a
 *  virtual clock and every browser follows it. none: nothing selected yet. */
export const PlaybackSource = z.enum(['vlc', 'browser', 'none']);
export type PlaybackSource = z.infer<typeof PlaybackSource>;

export const ClientMode = z.enum(['auto', 'host', 'guest']);
export type ClientMode = z.infer<typeof ClientMode>;

export const Nick = z.string().trim().min(1).max(24);
export const Pin = z.string().regex(/^\d{4,8}$/);

// ------------------------------------------------------------------ media

export const SubtitleTrack = z.object({
  id: z.string(),
  label: z.string(),
  lang: z.string().nullable(),
  kind: z.enum(['embedded', 'sidecar']),
  /** WebVTT, relative to the host origin, already carrying the media token query. */
  url: z.string(),
  isDefault: z.boolean(),
});
export type SubtitleTrack = z.infer<typeof SubtitleTrack>;

export const RenditionInfo = z.object({
  id: RenditionId,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bitrateKbps: z.number().int().positive(),
  /** Media playlist for this rendition alone (used for manual quality on iOS). */
  playlistUrl: z.string(),
});
export type RenditionInfo = z.infer<typeof RenditionInfo>;

export const MediaInfo = z.object({
  /** Opaque, stable per file (hash of path + size + mtime). Never a filesystem path. */
  id: z.string(),
  title: z.string(),
  durationSec: z.number().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive().nullable(),
  /** Master playlist listing every rendition; the default thing to hand hls.js / Safari. */
  masterUrl: z.string(),
  renditions: z.array(RenditionInfo).min(1),
  subtitles: z.array(SubtitleTrack),
  audioLabel: z.string().nullable(),
  posterUrl: z.string().nullable(),
});
export type MediaInfo = z.infer<typeof MediaInfo>;

// ------------------------------------------------------------------ room state

export const PlaybackState = z.object({
  /** Monotonic per room; clients ignore anything with a lower seq than they have. */
  seq: z.number().int().nonnegative(),
  source: PlaybackSource,
  mediaId: z.string().nullable(),
  playing: z.boolean(),
  /** Seconds into the media at `updatedAt`. */
  position: z.number().nonnegative(),
  /** 1 for normal playback. Kept for completeness; the UI never exposes it. */
  rate: z.number().positive(),
  /** Host server clock, ms. Clients convert with their measured offset (see sync.ts). */
  updatedAt: z.number(),
});
export type PlaybackState = z.infer<typeof PlaybackState>;

export const Member = z.object({
  id: z.string(),
  nick: Nick,
  isHost: z.boolean(),
  typing: z.boolean(),
});
export type Member = z.infer<typeof Member>;

/** What a guest's player reports with each ping. Host connections receive it (relayed as
 *  `telemetry`) so the host console can confirm that the other device is loading and following. */
export const PlayerTelemetry = z.object({
  /** The video element's current media time, seconds. */
  position: z.number().nonnegative(),
  /** True when the element is actually advancing: not paused, not ended, not waiting for data. */
  playing: z.boolean(),
  /** Seconds of media buffered ahead of `position`. */
  bufferedAheadSec: z.number().nonnegative(),
  /** Rendition the player is on; 'auto' while hls.js chooses, 'native' on Safari's own HLS. */
  rendition: z.union([RenditionId, z.literal('auto'), z.literal('native')]).nullable(),
  /** True while the player is stalled waiting for data. */
  stalled: z.boolean(),
  /** The client's last measured ping round-trip, ms; null before the first pong. */
  rttMs: z.number().nonnegative().nullable(),
});
export type PlayerTelemetry = z.infer<typeof PlayerTelemetry>;

/** One member's telemetry as the host received it, plus what the host computed from it. */
export const MemberTelemetry = PlayerTelemetry.extend({
  id: z.string(),
  /** Player position minus the room's expected position when received, seconds. Negative = behind. */
  driftSec: z.number(),
  /** Host server clock, ms, when this report arrived. */
  at: z.number(),
});
export type MemberTelemetry = z.infer<typeof MemberTelemetry>;

export const Gif = z.object({
  id: z.string(),
  provider: z.enum(['klipy', 'giphy']),
  /** Full-size animated asset (gif or mp4 URL as returned by the provider). */
  url: z.string(),
  /** Small preview for the chat bubble and search grid. */
  previewUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  title: z.string().optional(),
});
export type Gif = z.infer<typeof Gif>;

export const ChatMessage = z.object({
  id: z.string(),
  from: z.object({ id: z.string(), nick: z.string() }),
  kind: z.enum(['text', 'gif', 'system']),
  text: z.string().max(2000).optional(),
  gif: Gif.optional(),
  /** Host server clock, ms. */
  at: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const RoomSnapshot = z.object({
  state: PlaybackState,
  media: MediaInfo.nullable(),
  members: z.array(Member),
  recentChat: z.array(ChatMessage),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshot>;

export const TranscodeStatus = z.enum(['starting', 'running', 'done', 'error']);
export type TranscodeStatus = z.infer<typeof TranscodeStatus>;

// ------------------------------------------------------------------ client -> server

export const C2S = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    v: z.literal(PROTOCOL_VERSION),
    pin: Pin,
    nick: Nick,
    /** Random id the client persists in localStorage so reconnects keep identity. */
    clientId: z.string().min(8).max(64),
    mode: ClientMode,
  }),
  /** `telemetry` is optional and only meaningful from a guest with a player; hosts omit it. */
  z.object({ type: z.literal('ping'), t: z.number(), telemetry: PlayerTelemetry.optional() }),
  z.object({
    type: z.literal('control'),
    action: z.enum(['play', 'pause', 'toggle', 'seek']),
    /** Required for seek: absolute seconds. */
    position: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('chat'),
    kind: z.enum(['text', 'gif']),
    text: z.string().trim().min(1).max(2000).optional(),
    gif: Gif.optional(),
  }),
  z.object({ type: z.literal('reaction'), kind: ReactionKind }),
  z.object({ type: z.literal('nick'), nick: Nick }),
  z.object({ type: z.literal('typing'), on: z.boolean() }),
  /** Host only. Make this media the room's media (source becomes 'browser' unless VLC has it). */
  z.object({ type: z.literal('select_media'), mediaId: z.string() }),
  /** Host only. Launch VLC on the host PC with this media; source becomes 'vlc'. */
  z.object({ type: z.literal('open_in_vlc'), mediaId: z.string() }),
  /** Host only. Follow whatever VLC is playing (default) or stop following VLC. */
  z.object({ type: z.literal('follow_vlc'), on: z.boolean() }),
]);
export type C2S = z.infer<typeof C2S>;

// ------------------------------------------------------------------ server -> client

export const ErrorCode = z.enum([
  'bad_pin',
  'bad_message',
  'not_host',
  'unknown_media',
  'rate_limited',
  'vlc_unreachable',
  'transcode_failed',
  'server_error',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const S2C = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    v: z.literal(PROTOCOL_VERSION),
    you: Member,
    room: RoomSnapshot,
    serverTime: z.number(),
    /** Append as `?t=` on every /media/ URL (video elements cannot send headers). */
    mediaToken: z.string(),
    gifSearchAvailable: z.boolean(),
    vlc: z.object({ connected: z.boolean(), following: z.boolean() }),
  }),
  z.object({ type: z.literal('pong'), t: z.number(), serverTime: z.number() }),
  z.object({ type: z.literal('state'), state: PlaybackState }),
  z.object({ type: z.literal('media'), media: MediaInfo.nullable() }),
  z.object({ type: z.literal('chat'), message: ChatMessage }),
  z.object({
    type: z.literal('reaction'),
    kind: ReactionKind,
    from: z.object({ id: z.string(), nick: z.string() }),
    at: z.number(),
  }),
  z.object({ type: z.literal('presence'), members: z.array(Member) }),
  z.object({
    type: z.literal('transcode'),
    mediaId: z.string(),
    rendition: RenditionId,
    status: TranscodeStatus,
    /** Seconds of media rendered so far for this rendition, when known. */
    readyToSec: z.number().nonnegative().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('vlc'), connected: z.boolean(), following: z.boolean() }),
  /** Host connections only. Every guest's latest report; sent when a report arrives, coalesced to
   *  at most one message per 500 ms, and once with `[]` when the last guest leaves. */
  z.object({ type: z.literal('telemetry'), members: z.array(MemberTelemetry) }),
  z.object({ type: z.literal('error'), code: ErrorCode, message: z.string() }),
]);
export type S2C = z.infer<typeof S2C>;

// ------------------------------------------------------------------ REST shapes

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  source: PlaybackSource,
  vlc: z.object({ connected: z.boolean(), following: z.boolean().optional() }),
  ffmpeg: z.object({ found: z.boolean(), encoder: z.string().nullable() }),
  gifSearchAvailable: z.boolean(),
  /** Which provider answers GIF searches; null when no key is configured. */
  gifProvider: z.enum(['klipy', 'giphy']).nullable().optional(),
  /** Transcode cache usage, for the host footer. */
  cache: z.object({ usedBytes: z.number().nonnegative(), maxBytes: z.number().nonnegative() }).optional(),
  /** URLs the host believes it is reachable at (local, tailnet), for the host footer's copy buttons. */
  urls: z.array(z.string()).optional(),
  /** Whether `tailscale serve status` currently maps :8443 to this host (re-checked about once a
   *  minute), and the resulting URL. Absent when the tailscale CLI was not found. */
  tailnet: z.object({ published: z.boolean(), url: z.string().nullable(), checkedAt: z.number() }).optional(),
  /** Connected members right now. */
  members: z.object({ hosts: z.number().int().nonnegative(), guests: z.number().int().nonnegative() }).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Host-only (loopback + PIN header). GET /api/host/settings and PATCH /api/host/settings.
 *  A PATCH writes the given keys into `.env` (other lines untouched) and reconfigures GIF search
 *  without a restart. An empty string removes a key. Keys are never echoed back. */
export const HostSettingsPatch = z.object({
  klipyApiKey: z.string().trim().max(200).optional(),
  giphyApiKey: z.string().trim().max(200).optional(),
  /** The Tailscale "share this machine" invite link William copies from the admin console
   *  (https://login.tailscale.com/admin/machines → Share). Stored as WOCHIT_TS_SHARE_LINK so the
   *  console can build the one-link invite for the guest. Empty string clears it. */
  tailscaleShareLink: z.union([z.literal(''), z.string().trim().url().max(500)]).optional(),
});
export type HostSettingsPatch = z.infer<typeof HostSettingsPatch>;

export const HostSettingsResponse = z.object({
  gifSearchAvailable: z.boolean(),
  gifProvider: z.enum(['klipy', 'giphy']).nullable(),
  /** Whether a key is present per provider. Never the key itself. */
  keys: z.object({ klipy: z.boolean(), giphy: z.boolean() }),
  /** The stored Tailscale share link, or null. Host-only, so it is returned in full. */
  tailscaleShareLink: z.string().nullable(),
});
export type HostSettingsResponse = z.infer<typeof HostSettingsResponse>;

/** Host-only (loopback + PIN header). POST /api/host/shutdown answers this, then the host agent
 *  shuts down the way Ctrl+C would (VLC is left running). */
export const ShutdownResponse = z.object({ ok: z.literal(true), message: z.string() });
export type ShutdownResponse = z.infer<typeof ShutdownResponse>;

/** Host-only library browsing. Paths are shown relative to a root and never leave the host PC. */
export const LibraryEntry = z.object({
  kind: z.enum(['dir', 'file']),
  /** Opaque id for dirs and files alike; files' ids are MediaInfo ids. */
  id: z.string(),
  name: z.string(),
  /** e.g. "Plex Movies / Dune (2021)" — display only. */
  displayPath: z.string(),
  sizeBytes: z.number().nonnegative().optional(),
  durationSec: z.number().nonnegative().optional(),
});
export type LibraryEntry = z.infer<typeof LibraryEntry>;

export const LibraryResponse = z.object({
  parentId: z.string().nullable(),
  entries: z.array(LibraryEntry),
});
export type LibraryResponse = z.infer<typeof LibraryResponse>;

export const GifSearchResponse = z.object({
  provider: z.enum(['klipy', 'giphy']),
  results: z.array(Gif),
  next: z.string().nullable(),
});
export type GifSearchResponse = z.infer<typeof GifSearchResponse>;

// ------------------------------------------------------------------ constants both sides share

/** HLS segment length in seconds. Segment k of any rendition covers [k*SEG, (k+1)*SEG). */
export const HLS_SEGMENT_SEC = 4;

/** The rendition ladder, tallest first. The host drops rungs taller than the source. */
export const RENDITION_LADDER: ReadonlyArray<{ id: RenditionId; height: number; bitrateKbps: number }> = [
  { id: '1080p', height: 1080, bitrateKbps: 5200 },
  { id: '720p', height: 720, bitrateKbps: 2800 },
  { id: '480p', height: 480, bitrateKbps: 1400 },
  { id: '360p', height: 360, bitrateKbps: 800 },
];

export const REACTION_EMOJI: Record<ReactionKind, readonly string[]> = {
  cheer: ['👏', '🎉', '🥳', '🎊', '✨'],
  boo: ['🍅', '👎', '😤', '🙄'],
  heart: ['❤️', '💖', '💗', '💕', '😍', '💞'],
};

/** Minimum gap between two reactions from one member, ms. The host enforces it too. */
export const REACTION_MIN_GAP_MS = 400;

// ------------------------------------------------------------------ guest invite link

/** The public connect page (Vercel) hosts the guest onboarding at this path. The host console
 *  builds `https://<public origin>/invite#<params>`; everything after `#` never reaches a server. */
export const INVITE_PATH = '/invite';

/** Parameters carried in the invite URL's hash: `h` = host origin to open once Tailscale is on
 *  (e.g. https://william-desktop.tail2ac207.ts.net:8443), `s` = the Tailscale share link (optional),
 *  `n` = the host's display name (optional). */
export const InviteParams = z.object({
  h: z.string().url(),
  s: z.string().url().optional(),
  n: z.string().trim().min(1).max(24).optional(),
});
export type InviteParams = z.infer<typeof InviteParams>;

export function buildInviteUrl(publicOrigin: string, params: InviteParams): string {
  // No URLSearchParams here: shared/ compiles without the DOM lib. encodeURIComponent is ES2015.
  const parts = [`h=${encodeURIComponent(params.h)}`];
  if (params.s) parts.push(`s=${encodeURIComponent(params.s)}`);
  if (params.n) parts.push(`n=${encodeURIComponent(params.n)}`);
  const origin = publicOrigin.endsWith('/') ? publicOrigin.slice(0, -1) : publicOrigin;
  return `${origin}${INVITE_PATH}#${parts.join('&')}`;
}

/** Parse a `location.hash` (with or without the leading `#`). Null when it is not an invite. */
export function parseInviteHash(hash: string): InviteParams | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const found: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    try {
      found[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  const parsed = InviteParams.safeParse({ h: found['h'], s: found['s'], n: found['n'] });
  return parsed.success ? parsed.data : null;
}
