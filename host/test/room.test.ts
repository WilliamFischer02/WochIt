import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REACTION_MIN_GAP_MS, type C2S, type S2C } from '@wochit/shared';
import { silentLogger } from '../src/log.js';
import { Room, type Connection } from '../src/room/room.js';
import { FakeBridge } from './fakes/fakeBridge.js';
import { CLIP, FILM, newFakeMedia, type FakeMediaService } from './fakes/fakeMediaService.js';

class Conn implements Connection {
  readonly msgs: S2C[] = [];
  send(msg: S2C): void {
    this.msgs.push(msg);
  }
  of<T extends S2C['type']>(type: T): Extract<S2C, { type: T }>[] {
    return this.msgs.filter((m): m is Extract<S2C, { type: T }> => m.type === type);
  }
  last<T extends S2C['type']>(type: T): Extract<S2C, { type: T }> {
    const list = this.of(type);
    const l = list[list.length - 1];
    if (!l) throw new Error(`no ${type} message`);
    return l;
  }
  clear(): void {
    this.msgs.length = 0;
  }
}

interface World {
  room: Room;
  media: FakeMediaService;
  bridge: FakeBridge;
  now: () => number;
  advance(ms: number): void;
  host: Conn;
  guest: Conn;
  join(conn: Conn, p?: Partial<{ clientId: string; nick: string; mode: 'auto' | 'host' | 'guest'; isLocal: boolean }>): void;
  send(conn: Conn, msg: C2S): void;
}

function makeWorld(opts: { followVlc?: boolean; bridgeEnabled?: boolean } = {}): World {
  let t = 1_700_000_000_000;
  const now = () => t;
  const media = newFakeMedia();
  const bridge = new FakeBridge({ now, enabled: opts.bridgeEnabled ?? true });
  const room = new Room({
    media,
    bridge,
    log: silentLogger,
    mediaToken: 'tok',
    gifSearchAvailable: true,
    chatLogDir: null,
    now,
    followVlc: opts.followVlc,
  });
  const host = new Conn();
  const guest = new Conn();
  const join: World['join'] = (conn, p = {}) =>
    room.join({
      conn,
      clientId: p.clientId ?? (conn === host ? 'client-host-1' : 'client-guest-1'),
      nick: p.nick ?? (conn === host ? 'Will' : 'Mia'),
      mode: p.mode ?? 'auto',
      isLocal: p.isLocal ?? conn === host,
    });
  return {
    room,
    media,
    bridge,
    now,
    advance: (ms) => {
      t += ms;
    },
    host,
    guest,
    join,
    send: (conn, msg) => room.handle(conn, msg),
  };
}

let w: World;
beforeEach(() => {
  w = makeWorld();
});
afterEach(() => {
  w.room.dispose();
  vi.useRealTimers();
});

describe('membership', () => {
  it('welcome carries snapshot, token, gif flag and vlc; others get presence', () => {
    w.join(w.host);
    const welcome = w.host.last('welcome');
    expect(welcome.you).toMatchObject({ nick: 'Will', isHost: true, typing: false });
    expect(welcome.mediaToken).toBe('tok');
    expect(welcome.gifSearchAvailable).toBe(true);
    expect(welcome.vlc).toEqual({ connected: false, following: true });
    expect(welcome.room.state).toMatchObject({ seq: 0, source: 'none', mediaId: null, playing: false });
    expect(welcome.room.members).toHaveLength(1);
    expect(w.host.of('presence')).toHaveLength(0);

    w.join(w.guest);
    expect(w.guest.last('welcome').you.isHost).toBe(false);
    expect(w.host.last('presence').members.map((m) => m.nick)).toEqual(['Will', 'Mia']);
    expect(w.guest.of('presence')).toHaveLength(0);
  });

  it('applies the mode table and sends informational not_host for mode=host from a remote', () => {
    const a = new Conn();
    w.join(a, { clientId: 'c1', mode: 'host', isLocal: false });
    expect(a.last('welcome').you.isHost).toBe(false);
    expect(a.of('error')).toEqual([expect.objectContaining({ code: 'not_host' })]);

    const b = new Conn();
    w.join(b, { clientId: 'c2', mode: 'guest', isLocal: true });
    expect(b.last('welcome').you.isHost).toBe(false);
    expect(b.of('error')).toHaveLength(0);

    const c = new Conn();
    w.join(c, { clientId: 'c3', mode: 'host', isLocal: true });
    expect(c.last('welcome').you.isHost).toBe(true);
  });

  it('reconnecting with the same clientId reuses the member id; a parallel tab gets a new one', () => {
    w.join(w.host, { clientId: 'same' });
    const id1 = w.host.last('welcome').you.id;
    w.room.leave(w.host);
    const again = new Conn();
    w.join(again, { clientId: 'same' });
    expect(again.last('welcome').you.id).toBe(id1);

    const tab2 = new Conn();
    w.join(tab2, { clientId: 'same' });
    expect(tab2.last('welcome').you.id).not.toBe(id1);
    expect(w.room.getMembers().map((m) => m.id)).toEqual([id1, tab2.last('welcome').you.id]);
  });

  it('leave broadcasts presence; unknown connections get bad_message', () => {
    w.join(w.host);
    w.join(w.guest);
    w.host.clear();
    w.room.leave(w.guest);
    expect(w.host.last('presence').members.map((m) => m.nick)).toEqual(['Will']);
    const stranger = new Conn();
    w.send(stranger, { type: 'ping', t: 1 });
    expect(stranger.last('error').code).toBe('bad_message');
  });

  it('ping → pong with server time', () => {
    w.join(w.host);
    w.send(w.host, { type: 'ping', t: 42 });
    expect(w.host.last('pong')).toEqual({ type: 'pong', t: 42, serverTime: w.now() });
  });
});

describe('browser clock', () => {
  beforeEach(async () => {
    w.join(w.host);
    w.join(w.guest);
    w.send(w.host, { type: 'select_media', mediaId: FILM.id });
    await w.room.whenIdle();
  });

  it('select_media publishes media then state with source browser, position 0, paused', () => {
    expect(w.guest.last('media').media?.id).toBe(FILM.id);
    expect(w.guest.last('media').media?.masterUrl).toBe(`/media/${FILM.id}/master.m3u8`);
    const st = w.guest.last('state').state;
    expect(st).toMatchObject({ seq: 1, source: 'browser', mediaId: FILM.id, playing: false, position: 0, rate: 1, updatedAt: w.now() });
  });

  it('play / pause / seek / toggle mutate the virtual clock with monotonic seq to everyone', () => {
    const seqs: number[] = [];
    const record = () => seqs.push(w.guest.last('state').state.seq);

    w.send(w.guest, { type: 'control', action: 'play' });
    record();
    expect(w.guest.last('state').state).toMatchObject({ playing: true, position: 0 });
    expect(w.host.last('state').state.seq).toBe(w.guest.last('state').state.seq);

    w.advance(5000);
    w.send(w.host, { type: 'control', action: 'pause' });
    record();
    expect(w.guest.last('state').state).toMatchObject({ playing: false, position: 5 });

    w.advance(5000);
    w.send(w.guest, { type: 'control', action: 'seek', position: 120.5 });
    record();
    expect(w.guest.last('state').state).toMatchObject({ playing: false, position: 120.5 });

    w.send(w.guest, { type: 'control', action: 'toggle' });
    record();
    expect(w.guest.last('state').state.playing).toBe(true);
    w.advance(1500);
    w.send(w.guest, { type: 'control', action: 'seek', position: 30 });
    record();
    expect(w.guest.last('state').state).toMatchObject({ playing: true, position: 30 });
    expect(w.room.currentPosition()).toBe(30);
    w.advance(2000);
    expect(w.room.currentPosition()).toBe(32);

    expect(seqs).toEqual([2, 3, 4, 5, 6]);
    expect(w.bridge.commands).toEqual([]);
  });

  it('clamps seeks to the media length and rejects seek without position', () => {
    w.send(w.guest, { type: 'control', action: 'seek', position: 99_999 });
    expect(w.guest.last('state').state.position).toBe(FILM.durationSec);
    w.guest.clear();
    w.send(w.guest, { type: 'control', action: 'seek' });
    expect(w.guest.last('error').code).toBe('bad_message');
    expect(w.guest.of('state')).toHaveLength(0);
  });

  it('heartbeats every second while playing and stops at the end of the media', async () => {
    vi.useFakeTimers();
    const w2 = makeWorld();
    try {
      w2.join(w2.host);
      w2.send(w2.host, { type: 'select_media', mediaId: CLIP.id });
      await w2.room.whenIdle();
      w2.send(w2.host, { type: 'control', action: 'play' });
      const before = w2.host.of('state').length;
      w2.advance(1000);
      vi.advanceTimersByTime(1000);
      w2.advance(1000);
      vi.advanceTimersByTime(1000);
      expect(w2.host.of('state').length).toBe(before + 2);
      expect(w2.host.last('state').state).toMatchObject({ playing: true, position: 2 });
      expect(w2.host.last('state').state.seq).toBe(w2.host.of('state')[before - 1]!.state.seq + 2);

      w2.advance(CLIP.durationSec * 1000);
      vi.advanceTimersByTime(1000);
      expect(w2.host.last('state').state).toMatchObject({ playing: false, position: CLIP.durationSec });
      const after = w2.host.of('state').length;
      vi.advanceTimersByTime(5000);
      expect(w2.host.of('state').length).toBe(after);

      // vlc mode heartbeat republishes the bridge's latest position with its timestamp.
      w2.bridge.emit({ path: CLIP.path, state: 'playing', positionSec: 10, lengthSec: 90 });
      await w2.room.whenIdle();
      w2.advance(1000);
      const ev = w2.bridge.emit({ path: CLIP.path, state: 'playing', positionSec: 11, lengthSec: 90 });
      const n = w2.host.of('state').length;
      vi.advanceTimersByTime(1000);
      expect(w2.host.of('state').length).toBe(n + 1);
      expect(w2.host.last('state').state).toMatchObject({ source: 'vlc', playing: true, position: 11, updatedAt: ev.at });
    } finally {
      w2.room.dispose();
    }
  });

  it('controls without media → unknown_media', () => {
    const w3 = makeWorld();
    w3.join(w3.host);
    w3.send(w3.host, { type: 'control', action: 'play' });
    expect(w3.host.last('error').code).toBe('unknown_media');
    w3.room.dispose();
  });
});

describe('host-only commands', () => {
  it('guests get not_host for select_media, open_in_vlc and follow_vlc', async () => {
    w.join(w.host);
    w.join(w.guest);
    w.send(w.guest, { type: 'select_media', mediaId: FILM.id });
    w.send(w.guest, { type: 'open_in_vlc', mediaId: FILM.id });
    w.send(w.guest, { type: 'follow_vlc', on: false });
    await w.room.whenIdle();
    expect(w.guest.of('error').map((e) => e.code)).toEqual(['not_host', 'not_host', 'not_host']);
    expect(w.room.getMedia()).toBeNull();
    expect(w.bridge.launched).toEqual([]);
  });

  it('select_media with an unknown id → unknown_media', async () => {
    w.join(w.host);
    w.send(w.host, { type: 'select_media', mediaId: 'nope' });
    await w.room.whenIdle();
    expect(w.host.last('error').code).toBe('unknown_media');
  });

  it('open_in_vlc selects the media, launches VLC with the path, and VLC reporting it flips source to vlc', async () => {
    w.join(w.host);
    w.join(w.guest);
    w.send(w.host, { type: 'open_in_vlc', mediaId: CLIP.id });
    await w.room.whenIdle();
    expect(w.bridge.launched).toEqual([CLIP.path]);
    expect(w.bridge.durationHints.get(CLIP.path.toLowerCase())).toBe(CLIP.durationSec);
    expect(w.guest.last('state').state).toMatchObject({ source: 'browser', mediaId: CLIP.id });

    const mediaMsgs = w.guest.of('media').length;
    w.bridge.emit({ path: CLIP.path, state: 'playing', positionSec: 3, lengthSec: 90 });
    await w.room.whenIdle();
    expect(w.guest.last('vlc')).toEqual({ type: 'vlc', connected: true, following: true });
    expect(w.guest.last('state').state).toMatchObject({ source: 'vlc', mediaId: CLIP.id, playing: true, position: 3 });
    expect(w.guest.of('media').length).toBe(mediaMsgs); // same media: no second `media` frame, no reset to 0
  });

  it('open_in_vlc without a bridge → vlc_unreachable; a failing launch → vlc_unreachable', async () => {
    const off = makeWorld({ bridgeEnabled: false });
    off.join(off.host);
    off.send(off.host, { type: 'open_in_vlc', mediaId: FILM.id });
    await off.room.whenIdle();
    expect(off.host.last('error').code).toBe('vlc_unreachable');
    off.room.dispose();

    w.join(w.host);
    w.bridge.failCommands = new Error('spawn failed');
    w.send(w.host, { type: 'open_in_vlc', mediaId: FILM.id });
    await w.room.whenIdle();
    expect(w.host.last('error').code).toBe('vlc_unreachable');
  });
});

describe('VLC master clock', () => {
  it('follow_vlc (default on): VLC reporting a path resolves it and makes it the room media with source vlc', async () => {
    w.join(w.host);
    w.join(w.guest);
    w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 12.25, lengthSec: 600 });
    await w.room.whenIdle();
    expect(w.media.calls).toContain(`resolvePath:${FILM.path}`);
    expect(w.guest.last('media').media?.id).toBe(FILM.id);
    expect(w.guest.last('state').state).toMatchObject({ source: 'vlc', mediaId: FILM.id, position: 0, playing: false });
    expect(w.bridge.durationHints.get(FILM.path.toLowerCase())).toBe(FILM.durationSec);

    // Next poll mirrors VLC: playing flag differs → publish with VLC's position and timestamp.
    w.advance(250);
    const ev = w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 12.5, lengthSec: 600 });
    expect(w.guest.last('state').state).toMatchObject({ playing: true, position: 12.5, updatedAt: ev.at });
    const seqAfter = w.guest.last('state').state.seq;

    // Drift under the threshold is absorbed silently (heartbeat handles it).
    w.advance(250);
    w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 12.8, lengthSec: 600 });
    expect(w.guest.last('state').state.seq).toBe(seqAfter);

    // A jump beyond the threshold is a seek in VLC → published at once.
    w.advance(250);
    w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 200, lengthSec: 600 });
    expect(w.guest.last('state').state).toMatchObject({ seq: seqAfter + 1, position: 200, playing: true });

    // Pausing in VLC → published.
    w.advance(250);
    w.bridge.emit({ path: FILM.path, state: 'paused', positionSec: 200.2, lengthSec: 600 });
    expect(w.guest.last('state').state).toMatchObject({ playing: false, position: 200.2 });
  });

  it('controls in vlc mode go to the bridge with an optimistic publish; settle window ignores stale polls', async () => {
    w.join(w.host);
    w.join(w.guest);
    w.bridge.emit({ path: FILM.path, state: 'paused', positionSec: 10, lengthSec: 600 });
    await w.room.whenIdle();
    w.bridge.emit({ path: FILM.path, state: 'paused', positionSec: 10, lengthSec: 600 });
    expect(w.guest.last('state').state).toMatchObject({ source: 'vlc', position: 10, playing: false });

    w.send(w.guest, { type: 'control', action: 'play' });
    expect(w.bridge.commands).toEqual(['play']);
    expect(w.guest.last('state').state).toMatchObject({ playing: true, position: 10 });
    const optimisticSeq = w.guest.last('state').state.seq;

    // A poll inside the settle window still says paused: ignored.
    w.advance(100);
    w.bridge.emit({ path: FILM.path, state: 'paused', positionSec: 10, lengthSec: 600 });
    expect(w.guest.last('state').state.seq).toBe(optimisticSeq);

    // After the window VLC agrees: no publish needed (same playing flag, position within threshold).
    w.advance(700);
    w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 10.8, lengthSec: 600 });
    expect(w.guest.last('state').state.seq).toBe(optimisticSeq);

    w.send(w.host, { type: 'control', action: 'seek', position: 300.4 });
    expect(w.bridge.commands).toEqual(['play', 'seek:300']);
    expect(w.guest.last('state').state).toMatchObject({ position: 300.4, playing: true });

    w.send(w.host, { type: 'control', action: 'toggle' });
    expect(w.bridge.commands).toEqual(['play', 'seek:300', 'pause']);
    expect(w.guest.last('state').state.playing).toBe(false);
    await w.room.whenIdle();
  });

  it('a failing VLC command tells the sender vlc_unreachable', async () => {
    w.join(w.host);
    w.bridge.emit({ path: FILM.path, state: 'paused', positionSec: 1, lengthSec: 600 });
    await w.room.whenIdle();
    w.bridge.failCommands = new Error('down');
    w.send(w.host, { type: 'control', action: 'play' });
    await w.room.whenIdle();
    expect(w.host.last('error').code).toBe('vlc_unreachable');
  });

  it('VLC disconnecting pauses the room and broadcasts vlc {connected:false}', async () => {
    w.join(w.host);
    w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 50, lengthSec: 600 });
    await w.room.whenIdle();
    w.advance(250);
    w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 50.25, lengthSec: 600 });
    expect(w.host.last('state').state.playing).toBe(true);
    w.advance(2000);
    w.bridge.disconnect();
    expect(w.host.last('vlc')).toEqual({ type: 'vlc', connected: false, following: true });
    expect(w.host.last('state').state).toMatchObject({ playing: false, position: 52.25, source: 'vlc' });
  });

  it('follow_vlc off: VLC switching files no longer overrides the room media; turning it on applies the current file', async () => {
    w.join(w.host);
    w.join(w.guest);
    w.send(w.host, { type: 'select_media', mediaId: CLIP.id });
    await w.room.whenIdle();
    w.send(w.host, { type: 'follow_vlc', on: false });
    expect(w.guest.last('vlc')).toEqual({ type: 'vlc', connected: false, following: false });

    w.bridge.emit({ path: FILM.path, state: 'playing', positionSec: 5, lengthSec: 600 });
    await w.room.whenIdle();
    expect(w.room.getMedia()?.id).toBe(CLIP.id);
    expect(w.room.getState().source).toBe('browser');

    w.send(w.host, { type: 'follow_vlc', on: true });
    await w.room.whenIdle();
    expect(w.room.getMedia()?.id).toBe(FILM.id);
    expect(w.room.getState().source).toBe('vlc');
  });

  it('select_media picks source vlc when VLC already has that file open', async () => {
    w.join(w.host);
    w.bridge.emit({ path: FILM.path, state: 'paused', positionSec: 5, lengthSec: 600 });
    await w.room.whenIdle();
    w.send(w.host, { type: 'select_media', mediaId: CLIP.id });
    await w.room.whenIdle();
    expect(w.room.getState()).toMatchObject({ source: 'browser', mediaId: CLIP.id });
    w.send(w.host, { type: 'select_media', mediaId: FILM.id });
    await w.room.whenIdle();
    expect(w.room.getState()).toMatchObject({ source: 'vlc', mediaId: FILM.id });
  });

  it('a file the media service cannot serve is ignored', async () => {
    const strict = makeWorld();
    strict.media = newFakeMedia(undefined, false);
    const room = new Room({ media: strict.media, bridge: strict.bridge, log: silentLogger, mediaToken: 't', gifSearchAvailable: false, chatLogDir: null, now: strict.now });
    room.join({ conn: strict.host, clientId: 'c', nick: 'W', mode: 'auto', isLocal: true });
    strict.bridge.emit({ path: 'C:\\somewhere\\else.iso', state: 'playing', positionSec: 1, lengthSec: 10 });
    await room.whenIdle();
    expect(room.getMedia()).toBeNull();
    expect(strict.host.of('media')).toHaveLength(0);
    room.dispose();
    strict.room.dispose();
  });

  it('transcode events from the media service are broadcast', () => {
    w.join(w.host);
    w.media.emitTranscode({ mediaId: FILM.id, rendition: '720p', status: 'running', readyToSec: 40 });
    expect(w.host.last('transcode')).toEqual({ type: 'transcode', mediaId: FILM.id, rendition: '720p', status: 'running', readyToSec: 40 });
  });
});

describe('chat, reactions, nick, typing', () => {
  const gif = {
    id: '8041071659142944',
    provider: 'klipy' as const,
    url: 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/um0L4dFH.gif',
    previewUrl: 'https://static1.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/small.gif',
    width: 200,
    height: 200,
  };

  beforeEach(() => {
    w.join(w.host);
    w.join(w.guest);
  });

  it('text chat is echoed to everyone with id, from and at, and kept in recentChat', () => {
    w.send(w.guest, { type: 'chat', kind: 'text', text: 'hi there' });
    const msg = w.host.last('chat').message;
    expect(msg).toMatchObject({ kind: 'text', text: 'hi there', from: { nick: 'Mia' }, at: w.now() });
    expect(msg.id).toBeTruthy();
    expect(w.guest.last('chat').message).toEqual(msg);
    expect(w.room.snapshot().recentChat).toEqual([msg]);
  });

  it('gif chat accepts Klipy/GIPHY CDN hosts only', () => {
    w.send(w.guest, { type: 'chat', kind: 'gif', gif });
    expect(w.host.last('chat').message.gif).toEqual(gif);
    const giphy = { ...gif, provider: 'giphy' as const, url: 'https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif?cid=1', previewUrl: 'https://i.giphy.com/xT9IgzoKnwFNmISR8I.gif' };
    w.send(w.guest, { type: 'chat', kind: 'gif', gif: giphy });
    expect(w.host.last('chat').message.gif).toEqual(giphy);
    w.host.clear();
    w.send(w.guest, { type: 'chat', kind: 'gif', gif: { ...gif, url: 'https://evil.example/x.gif' } });
    expect(w.host.of('chat')).toHaveLength(0);
    expect(w.guest.last('error').code).toBe('bad_message');
    w.send(w.guest, { type: 'chat', kind: 'gif', gif: { ...gif, previewUrl: 'http://static.klipy.com/plain-http.gif' } });
    expect(w.host.of('chat')).toHaveLength(0);
    w.send(w.guest, { type: 'chat', kind: 'gif' });
    expect(w.guest.last('error').code).toBe('bad_message');
    w.send(w.guest, { type: 'chat', kind: 'text' });
    expect(w.guest.last('error').code).toBe('bad_message');
  });

  it('keeps only the last 200 messages in memory', () => {
    for (let i = 0; i < 205; i++) w.send(w.host, { type: 'chat', kind: 'text', text: `m${i}` });
    const recent = w.room.snapshot().recentChat;
    expect(recent).toHaveLength(200);
    expect(recent[0]?.text).toBe('m5');
    expect(recent[199]?.text).toBe('m204');
  });

  it('reactions are echoed with from/at and rate limited per member', () => {
    w.send(w.guest, { type: 'reaction', kind: 'cheer' });
    expect(w.host.last('reaction')).toEqual({ type: 'reaction', kind: 'cheer', from: { id: w.guest.last('welcome').you.id, nick: 'Mia' }, at: w.now() });
    expect(w.guest.of('reaction')).toHaveLength(1);
    w.advance(REACTION_MIN_GAP_MS - 1);
    w.send(w.guest, { type: 'reaction', kind: 'boo' });
    expect(w.host.of('reaction')).toHaveLength(1);
    w.send(w.host, { type: 'reaction', kind: 'heart' }); // another member is not affected
    expect(w.host.of('reaction')).toHaveLength(2);
    w.advance(1);
    w.send(w.guest, { type: 'reaction', kind: 'boo' });
    expect(w.host.of('reaction')).toHaveLength(3);
    expect(w.host.last('reaction').kind).toBe('boo');
  });

  it('nick change → presence + system line "A is now B"; same nick is a no-op', () => {
    w.host.clear();
    w.send(w.guest, { type: 'nick', nick: 'Mia2' });
    expect(w.host.last('presence').members.find((m) => m.nick === 'Mia2')).toBeTruthy();
    expect(w.host.last('chat').message).toMatchObject({ kind: 'system', text: 'Mia is now Mia2' });
    w.host.clear();
    w.send(w.guest, { type: 'nick', nick: 'Mia2' });
    expect(w.host.msgs).toHaveLength(0);
  });

  it('typing flags live on members and only changes are broadcast', () => {
    w.host.clear();
    w.send(w.guest, { type: 'typing', on: true });
    expect(w.host.last('presence').members.find((m) => m.nick === 'Mia')?.typing).toBe(true);
    w.host.clear();
    w.send(w.guest, { type: 'typing', on: true });
    expect(w.host.msgs).toHaveLength(0);
    w.send(w.guest, { type: 'typing', on: false });
    expect(w.host.last('presence').members.find((m) => m.nick === 'Mia')?.typing).toBe(false);
  });

  it('a second hello over a joined connection is rejected', () => {
    w.send(w.host, { type: 'hello', v: 1, pin: '123456', nick: 'x', clientId: 'abcdefgh', mode: 'auto' });
    expect(w.host.last('error').code).toBe('bad_message');
  });
});

describe('chat log on disk', () => {
  it('appends one JSON line per message to chat-YYYY-MM-DD.jsonl', async () => {
    const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wochit-chatlog-'));
    const media = newFakeMedia();
    const bridge = new FakeBridge();
    const room = new Room({ media, bridge, log: silentLogger, mediaToken: 't', gifSearchAvailable: false, chatLogDir: dir, now: () => 1_700_000_000_000 });
    const c = new Conn();
    room.join({ conn: c, clientId: 'cid-1234', nick: 'W', mode: 'auto', isLocal: true });
    room.handle(c, { type: 'chat', kind: 'text', text: 'logged' });
    room.handle(c, { type: 'nick', nick: 'W2' });
    await room.whenIdle();
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^chat-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = readFileSync(path.join(dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; text: string });
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['text', 'logged'],
      ['system', 'W is now W2'],
    ]);
    room.dispose();
  });
});
