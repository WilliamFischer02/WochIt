// The room: members, playback state, chat, reactions. Pure logic over an abstract `Connection`
// (anything with `send(S2C)`); server/ws.ts owns the sockets. docs/ARCHITECTURE.md § Room.
//
// Clock modes:
//   vlc      VLC is the master. State mirrors the bridge; controls go to VLC with an optimistic
//            publish that the next poll corrects.
//   browser  Virtual clock: `position` at `updatedAt`, advancing while `playing`.
//   none     Nothing selected.
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  REACTION_MIN_GAP_MS,
  expectedPosition,
  type C2S,
  type ChatMessage,
  type ClientMode,
  type ErrorCode,
  type Gif,
  type MediaInfo,
  type Member,
  type PlaybackSource,
  type PlaybackState,
  type RoomSnapshot,
  type S2C,
} from '@wochit/shared';
import type { Logger, MediaService } from '../media/index.js';
import type { VlcBridgeLike, VlcStatusEvent } from '../vlc/bridge.js';
import { resolveMode } from '../net/hostDetect.js';
import { isAllowedGifUrl } from '../gif/index.js';

export interface Connection {
  send(msg: S2C): void;
}

export interface JoinParams {
  conn: Connection;
  clientId: string;
  nick: string;
  mode: ClientMode;
  /** From net/hostDetect.ts; the transport knows the addresses, the room does not. */
  isLocal: boolean;
}

/**
 * The media interface plus an optional id → path lookup. `open_in_vlc` needs an absolute path and
 * the shared MediaService contract has none; a service that offers `getPath` gets full support,
 * otherwise only files VLC itself reported (and so were resolved from a path) can be re-opened.
 */
export type RoomMediaService = MediaService & { getPath?(mediaId: string): Promise<string | null> };

export interface RoomOptions {
  media: RoomMediaService;
  bridge: VlcBridgeLike;
  log: Logger;
  mediaToken: string;
  gifSearchAvailable: boolean;
  /** Directory for chat-YYYY-MM-DD.jsonl; null disables disk logging. */
  chatLogDir: string | null;
  now?: () => number;
  /** Default true: VLC's open file becomes the room's media. */
  followVlc?: boolean;
  /** Default 1000. */
  heartbeatMs?: number;
  /** A VLC position this far from the projected one is treated as a seek and published at once. Default 1.0. */
  vlcSeekThresholdSec?: number;
  /** After sending a command to VLC, ignore contradicting polls for this long. Default 600. */
  vlcSettleMs?: number;
  recentChatLimit?: number;
}

/** Both URLs must be https on a Klipy/GIPHY CDN host (gif/index.ts); no arbitrary image URLs. */
export function isAllowedGif(gif: Gif): boolean {
  return isAllowedGifUrl(gif.url) && isAllowedGifUrl(gif.previewUrl);
}

interface MemberRecord {
  member: Member;
  clientId: string;
  conn: Connection;
  lastReactionAt: number;
}

const SYSTEM_FROM = { id: 'system', nick: 'WochIt' } as const;

export class Room {
  private readonly media: RoomMediaService;
  private readonly bridge: VlcBridgeLike;
  private readonly log: Logger;
  private readonly mediaToken: string;
  private readonly gifSearchAvailable: boolean;
  private readonly chatLogDir: string | null;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly vlcSeekThresholdSec: number;
  private readonly vlcSettleMs: number;
  private readonly recentChatLimit: number;

  private readonly members = new Map<Connection, MemberRecord>();
  /** Member ids ever minted per clientId, so a reconnect can take one back. */
  private readonly mintedIds = new Map<string, string[]>();
  private readonly recentChat: ChatMessage[] = [];
  /** Absolute paths we have learned for media ids (from VLC reports or getPath). */
  private readonly idToPath = new Map<string, string>();
  private readonly unsubscribe: Array<() => void> = [];

  private state: PlaybackState;
  private currentMedia: MediaInfo | null = null;
  private currentMediaPath: string | null = null;

  private following: boolean;
  private vlcConnected: boolean;
  private vlcLatest: VlcStatusEvent | null = null;
  private vlcPath: string | null = null;
  private vlcSettleUntil = 0;
  private followSeq = 0;

  private heartbeat: NodeJS.Timeout | null = null;
  private pending = new Set<Promise<unknown>>();
  /** Disk writes are chained so lines land in the order they were broadcast. */
  private chatLogQueue: Promise<void> = Promise.resolve();
  private chatDirReady: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: RoomOptions) {
    this.media = opts.media;
    this.bridge = opts.bridge;
    this.log = opts.log;
    this.mediaToken = opts.mediaToken;
    this.gifSearchAvailable = opts.gifSearchAvailable;
    this.chatLogDir = opts.chatLogDir;
    this.now = opts.now ?? Date.now;
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
    this.vlcSeekThresholdSec = opts.vlcSeekThresholdSec ?? 1.0;
    this.vlcSettleMs = opts.vlcSettleMs ?? 600;
    this.recentChatLimit = opts.recentChatLimit ?? 200;
    this.following = opts.followVlc ?? true;
    this.vlcConnected = this.bridge.connected;

    this.state = {
      seq: 0,
      source: 'none',
      mediaId: null,
      playing: false,
      position: 0,
      rate: 1,
      updatedAt: this.now(),
    };

    this.unsubscribe.push(this.bridge.onStatus((s) => this.onVlcStatus(s)));
    this.unsubscribe.push(
      this.media.onTranscode((ev) => {
        const msg: S2C = { type: 'transcode', mediaId: ev.mediaId, rendition: ev.rendition, status: ev.status };
        if (ev.readyToSec !== undefined) msg.readyToSec = ev.readyToSec;
        if (ev.message !== undefined) msg.message = ev.message;
        this.broadcast(msg);
      }),
    );
    if (this.bridge.latest) this.onVlcStatus(this.bridge.latest);
  }

  // ---------------------------------------------------------------- read side

  getState(): PlaybackState {
    return this.state;
  }

  getMedia(): MediaInfo | null {
    return this.currentMedia;
  }

  getMembers(): Member[] {
    return [...this.members.values()].map((r) => r.member);
  }

  get memberCount(): number {
    return this.members.size;
  }

  vlcInfo(): { connected: boolean; following: boolean } {
    return { connected: this.vlcConnected, following: this.following };
  }

  snapshot(): RoomSnapshot {
    return {
      state: this.state,
      media: this.currentMedia,
      members: this.getMembers(),
      recentChat: [...this.recentChat],
    };
  }

  /** Resolves when every in-flight async action (media lookups, launches) has settled. For tests. */
  async whenIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    for (const u of this.unsubscribe) u();
    this.unsubscribe.length = 0;
  }

  // ---------------------------------------------------------------- membership

  join(p: JoinParams): Member {
    const { isHost, notHost } = resolveMode(p.mode, p.isLocal);
    const member: Member = { id: this.memberIdFor(p.clientId), nick: p.nick, isHost, typing: false };
    const rec: MemberRecord = { member, clientId: p.clientId, conn: p.conn, lastReactionAt: 0 };
    this.members.set(p.conn, rec);

    p.conn.send({
      type: 'welcome',
      v: PROTOCOL_VERSION,
      you: member,
      room: this.snapshot(),
      serverTime: this.now(),
      mediaToken: this.mediaToken,
      gifSearchAvailable: this.gifSearchAvailable,
      vlc: this.vlcInfo(),
    });
    if (notHost) this.sendError(p.conn, 'not_host', 'host mode is only honoured for connections from the host PC');
    this.broadcastPresence(p.conn);
    this.log.info('%s joined as %s (%s, mode=%s, local=%s)', member.nick, member.id, isHost ? 'host' : 'guest', p.mode, p.isLocal);
    return member;
  }

  leave(conn: Connection): void {
    const rec = this.members.get(conn);
    if (!rec) return;
    this.members.delete(conn);
    this.log.info('%s left (%s)', rec.member.nick, rec.member.id);
    this.broadcastPresence();
  }

  private memberIdFor(clientId: string): string {
    const inUse = new Set([...this.members.values()].map((r) => r.member.id));
    const minted = this.mintedIds.get(clientId) ?? [];
    const free = minted.find((id) => !inUse.has(id));
    if (free) return free;
    let id: string;
    do id = `m_${randomBytes(4).toString('hex')}`;
    while (inUse.has(id));
    minted.push(id);
    this.mintedIds.set(clientId, minted);
    return id;
  }

  // ---------------------------------------------------------------- dispatch

  /** `msg` has already passed `C2S.safeParse`. */
  handle(conn: Connection, msg: C2S): void {
    const rec = this.members.get(conn);
    if (!rec) {
      this.sendError(conn, 'bad_message', 'say hello first');
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.sendError(conn, 'bad_message', 'already joined');
        return;
      case 'ping':
        conn.send({ type: 'pong', t: msg.t, serverTime: this.now() });
        return;
      case 'control':
        this.onControl(rec, msg);
        return;
      case 'chat':
        this.onChat(rec, msg);
        return;
      case 'reaction':
        this.onReaction(rec, msg.kind);
        return;
      case 'nick':
        this.onNick(rec, msg.nick);
        return;
      case 'typing':
        if (rec.member.typing !== msg.on) {
          rec.member.typing = msg.on;
          this.broadcastPresence();
        }
        return;
      case 'select_media':
        if (!this.requireHost(rec)) return;
        this.track(this.selectMedia(rec, msg.mediaId));
        return;
      case 'open_in_vlc':
        if (!this.requireHost(rec)) return;
        this.track(this.openInVlc(rec, msg.mediaId));
        return;
      case 'follow_vlc':
        if (!this.requireHost(rec)) return;
        this.setFollowing(msg.on);
        return;
    }
  }

  private requireHost(rec: MemberRecord): boolean {
    if (rec.member.isHost) return true;
    this.sendError(rec.conn, 'not_host', 'only the host can do that');
    return false;
  }

  // ---------------------------------------------------------------- playback

  /** Where the room clock says the media is right now, clamped to the media length. */
  currentPosition(now = this.now()): number {
    return this.clamp(expectedPosition(this.state, now));
  }

  private clamp(pos: number): number {
    const d = this.currentMedia?.durationSec ?? 0;
    const upper = d > 0 ? d : Number.POSITIVE_INFINITY;
    return Math.min(upper, Math.max(0, pos));
  }

  private onControl(rec: MemberRecord, msg: Extract<C2S, { type: 'control' }>): void {
    if (!this.currentMedia || this.state.source === 'none') {
      this.sendError(rec.conn, 'unknown_media', 'no media selected');
      return;
    }
    const now = this.now();
    let playing = this.state.playing;
    let position = this.currentPosition(now);
    switch (msg.action) {
      case 'play':
        playing = true;
        break;
      case 'pause':
        playing = false;
        break;
      case 'toggle':
        playing = !playing;
        break;
      case 'seek':
        if (msg.position === undefined) {
          this.sendError(rec.conn, 'bad_message', 'seek needs a position');
          return;
        }
        position = this.clamp(msg.position);
        break;
    }

    if (this.state.source === 'vlc') {
      this.vlcSettleUntil = now + this.vlcSettleMs;
      const cmd = msg.action === 'seek' ? this.bridge.seek(position) : playing ? this.bridge.play() : this.bridge.pause();
      this.track(
        cmd.catch((err: unknown) => {
          this.log.warn('VLC command failed: %s', err instanceof Error ? err.message : String(err));
          this.sendError(rec.conn, 'vlc_unreachable', 'VLC did not accept the command');
        }),
      );
    }
    this.publishState({ playing, position }, now);
  }

  private publishState(patch: Partial<Omit<PlaybackState, 'seq'>>, updatedAt = this.now()): void {
    this.state = { ...this.state, ...patch, seq: this.state.seq + 1, updatedAt };
    this.broadcast({ type: 'state', state: this.state });
    this.syncHeartbeat();
  }

  private syncHeartbeat(): void {
    if (this.state.playing && !this.disposed) {
      if (!this.heartbeat) {
        this.heartbeat = setInterval(() => this.onHeartbeat(), this.heartbeatMs);
        this.heartbeat.unref?.();
      }
    } else this.stopHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private onHeartbeat(): void {
    if (!this.state.playing) {
      this.stopHeartbeat();
      return;
    }
    const now = this.now();
    if (this.state.source === 'vlc' && this.vlcLatest?.connected && this.vlcMatchesMedia(this.vlcLatest)) {
      this.publishState({ position: this.clamp(this.vlcLatest.positionSec), playing: this.vlcLatest.playing }, this.vlcLatest.at);
      return;
    }
    const d = this.currentMedia?.durationSec ?? 0;
    const pos = expectedPosition(this.state, now);
    if (d > 0 && pos >= d) {
      this.publishState({ playing: false, position: d }, now);
      return;
    }
    this.publishState({ position: this.clamp(pos) }, now);
  }

  private setMedia(info: MediaInfo, source: PlaybackSource, absPath: string | null): void {
    this.currentMedia = info;
    this.currentMediaPath = absPath ?? this.idToPath.get(info.id) ?? null;
    if (absPath) this.idToPath.set(info.id, absPath);
    this.broadcast({ type: 'media', media: info });
    this.publishState({ source, mediaId: info.id, position: 0, playing: false });
    this.log.info('room media → %s (%s, source=%s)', info.title, info.id, source);
  }

  private async selectMedia(rec: MemberRecord, mediaId: string): Promise<void> {
    let info: MediaInfo | null = null;
    try {
      info = await this.media.getMedia(mediaId);
    } catch (err) {
      this.log.warn('getMedia(%s) failed: %s', mediaId, err instanceof Error ? err.message : String(err));
    }
    if (!info) {
      this.sendError(rec.conn, 'unknown_media', 'that media id is not known to this host');
      return;
    }
    const p = this.idToPath.get(info.id) ?? null;
    const vlcHasIt = this.vlcConnected && p !== null && this.vlcPath !== null && samePath(p, this.vlcPath);
    this.setMedia(info, vlcHasIt ? 'vlc' : 'browser', p);
  }

  private async openInVlc(rec: MemberRecord, mediaId: string): Promise<void> {
    if (!this.bridge.enabled) {
      this.sendError(rec.conn, 'vlc_unreachable', 'VLC is not configured on the host (WOCHIT_VLC_EXE)');
      return;
    }
    let info: MediaInfo | null = null;
    try {
      info = await this.media.getMedia(mediaId);
    } catch (err) {
      this.log.warn('getMedia(%s) failed: %s', mediaId, err instanceof Error ? err.message : String(err));
    }
    if (!info) {
      this.sendError(rec.conn, 'unknown_media', 'that media id is not known to this host');
      return;
    }
    let absPath = this.idToPath.get(info.id) ?? null;
    if (!absPath && this.media.getPath) {
      try {
        absPath = await this.media.getPath(info.id);
      } catch (err) {
        this.log.warn('getPath(%s) failed: %s', info.id, err instanceof Error ? err.message : String(err));
      }
    }
    if (!absPath) {
      this.sendError(rec.conn, 'unknown_media', 'the host cannot map this media to a file path');
      return;
    }
    this.idToPath.set(info.id, absPath);
    this.bridge.setDurationHint(absPath, info.durationSec);
    if (this.currentMedia?.id !== info.id) this.setMedia(info, 'browser', absPath);
    else this.currentMediaPath = absPath;
    try {
      await this.bridge.launch(absPath);
    } catch (err) {
      this.log.warn('VLC launch failed: %s', err instanceof Error ? err.message : String(err));
      this.sendError(rec.conn, 'vlc_unreachable', 'could not launch VLC');
    }
  }

  private setFollowing(on: boolean): void {
    if (this.following !== on) {
      this.following = on;
      this.log.info('follow VLC → %s', on ? 'on' : 'off');
    }
    this.broadcastVlc();
    if (on && this.vlcPath) this.track(this.followPath(this.vlcPath));
  }

  // ---------------------------------------------------------------- VLC mirror

  private vlcMatchesMedia(s: VlcStatusEvent): boolean {
    if (!this.currentMedia) return false;
    if (!s.path || !this.currentMediaPath) return true; // nothing better to go on
    return samePath(s.path, this.currentMediaPath);
  }

  private onVlcStatus(s: VlcStatusEvent): void {
    const was = this.vlcConnected;
    this.vlcConnected = s.connected;
    this.vlcLatest = s.connected ? s : null;

    if (was !== s.connected) {
      this.broadcastVlc();
      if (!s.connected) {
        this.vlcPath = null;
        if (this.state.source === 'vlc' && this.state.playing) this.publishState({ playing: false, position: this.currentPosition() });
        return;
      }
    }
    if (!s.connected) return;

    if (!pathsEqual(s.path, this.vlcPath)) {
      this.vlcPath = s.path;
      if (s.path) {
        if (this.following) this.track(this.followPath(s.path));
        else if (this.currentMediaPath && samePath(s.path, this.currentMediaPath) && this.state.source !== 'vlc') {
          // Not following, but VLC opened the very file the room already shows: VLC takes the clock.
          this.adoptVlcClock(s);
        }
      }
    }

    if (this.state.source !== 'vlc' || !this.currentMedia || !this.vlcMatchesMedia(s)) return;
    if (s.at < this.vlcSettleUntil) return;

    const playing = s.state === 'playing';
    const position = s.state === 'stopped' ? this.currentPosition(s.at) : this.clamp(s.positionSec);
    const expected = this.currentPosition(s.at);
    if (playing !== this.state.playing || Math.abs(position - expected) > this.vlcSeekThresholdSec) {
      this.publishState({ playing, position }, s.at);
    }
  }

  private async followPath(absPath: string): Promise<void> {
    const seq = ++this.followSeq;
    let info: MediaInfo | null = null;
    try {
      info = await this.media.resolvePath(absPath);
    } catch (err) {
      this.log.warn('resolvePath(%s) failed: %s', absPath, err instanceof Error ? err.message : String(err));
    }
    if (seq !== this.followSeq || !this.following || this.disposed) return;
    if (!info) {
      this.log.warn('VLC opened %s but the media service cannot serve it', absPath);
      return;
    }
    this.idToPath.set(info.id, absPath);
    this.bridge.setDurationHint(absPath, info.durationSec);
    if (this.currentMedia?.id === info.id) {
      this.currentMediaPath = absPath;
      if (this.state.source !== 'vlc') this.adoptVlcClock(this.vlcLatest);
      return;
    }
    this.setMedia(info, 'vlc', absPath);
  }

  /** The room already shows the file VLC has open: switch the source to vlc and take its clock now. */
  private adoptVlcClock(s: VlcStatusEvent | null): void {
    if (s && s.connected && s.state !== 'stopped' && s.state !== 'unknown' && this.vlcMatchesMedia(s)) {
      this.publishState({ source: 'vlc', playing: s.state === 'playing', position: this.clamp(s.positionSec) }, s.at);
    } else {
      this.publishState({ source: 'vlc' });
    }
  }

  // ---------------------------------------------------------------- chat & co

  private onChat(rec: MemberRecord, msg: Extract<C2S, { type: 'chat' }>): void {
    const base = { id: randomUUID(), from: { id: rec.member.id, nick: rec.member.nick }, at: this.now() };
    let message: ChatMessage;
    if (msg.kind === 'text') {
      if (!msg.text) {
        this.sendError(rec.conn, 'bad_message', 'text message without text');
        return;
      }
      message = { ...base, kind: 'text', text: msg.text };
    } else {
      if (!msg.gif) {
        this.sendError(rec.conn, 'bad_message', 'gif message without gif');
        return;
      }
      if (!isAllowedGif(msg.gif)) {
        this.sendError(rec.conn, 'bad_message', 'gif URLs must point at the GIF provider CDN (Klipy or GIPHY)');
        return;
      }
      message = { ...base, kind: 'gif', gif: msg.gif };
    }
    this.pushChat(message);
  }

  private pushChat(message: ChatMessage): void {
    this.recentChat.push(message);
    while (this.recentChat.length > this.recentChatLimit) this.recentChat.shift();
    this.broadcast({ type: 'chat', message });
    this.appendChatLog(message);
  }

  private systemLine(text: string): void {
    this.pushChat({ id: randomUUID(), from: { ...SYSTEM_FROM }, kind: 'system', text, at: this.now() });
  }

  private appendChatLog(message: ChatMessage): void {
    const dir = this.chatLogDir;
    if (!dir) return;
    this.chatDirReady ??= mkdir(dir, { recursive: true }).then(() => undefined);
    const d = new Date(message.at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const file = path.join(dir, `chat-${day}.jsonl`);
    const line = JSON.stringify(message) + '\n';
    this.chatLogQueue = this.chatLogQueue
      .then(() => this.chatDirReady)
      .then(() => appendFile(file, line, 'utf8'))
      .catch((err: unknown) => this.log.warn('chat log write failed: %s', err instanceof Error ? err.message : String(err)));
    this.track(this.chatLogQueue);
  }

  private onReaction(rec: MemberRecord, kind: Extract<C2S, { type: 'reaction' }>['kind']): void {
    const now = this.now();
    if (now - rec.lastReactionAt < REACTION_MIN_GAP_MS) return;
    rec.lastReactionAt = now;
    this.broadcast({ type: 'reaction', kind, from: { id: rec.member.id, nick: rec.member.nick }, at: now });
  }

  private onNick(rec: MemberRecord, nick: string): void {
    const old = rec.member.nick;
    if (old === nick) return;
    rec.member.nick = nick;
    this.broadcastPresence();
    this.systemLine(`${old} is now ${nick}`);
  }

  // ---------------------------------------------------------------- plumbing

  private broadcast(msg: S2C, except?: Connection): void {
    for (const rec of this.members.values()) {
      if (rec.conn === except) continue;
      try {
        rec.conn.send(msg);
      } catch (err) {
        this.log.warn('send to %s failed: %s', rec.member.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private broadcastPresence(except?: Connection): void {
    this.broadcast({ type: 'presence', members: this.getMembers() }, except);
  }

  private broadcastVlc(): void {
    this.broadcast({ type: 'vlc', ...this.vlcInfo() });
  }

  private sendError(conn: Connection, code: ErrorCode, message: string): void {
    try {
      conn.send({ type: 'error', code, message });
    } catch {
      /* connection gone */
    }
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }
}

function normPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

function pathsEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return samePath(a, b);
}
