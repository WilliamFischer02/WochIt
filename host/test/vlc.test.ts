// Parsers run against JSON captured from a real headless VLC 3.0.21 (see fixtures/vlc/*.json,
// recorded with `vlc --intf dummy --extraintf http ...` on a generated 30 s clip). The bridge's
// polling/command behaviour is driven with a fake fetch.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { VlcBridge, parsePlaylist, parseStatus, vlcUriToPath, type VlcStatusEvent } from '../src/vlc/bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(here, 'fixtures', 'vlc', name), 'utf8'));

describe('parseStatus (real VLC 3.0.21 status.json)', () => {
  it('playing', () => {
    const s = parseStatus(fixture('status-playing.json'));
    expect(s).toMatchObject({ state: 'playing', timeSec: 1, lengthSec: 30, filename: 'fixture clip.mp4', rate: 1, volume: 0 });
    expect(s?.position).toBeCloseTo(0.038366667926311, 10);
  });
  it('paused, then paused after seek&val=7 → time 7, position 7/30', () => {
    expect(parseStatus(fixture('status-paused.json'))).toMatchObject({ state: 'paused', timeSec: 1 });
    const s = parseStatus(fixture('status-paused-after-seek7.json'));
    expect(s).toMatchObject({ state: 'paused', timeSec: 7, lengthSec: 30 });
    expect(s!.position * s!.lengthSec).toBeCloseTo(7, 1);
  });
  it('resumed via pl_forceresume', () => {
    expect(parseStatus(fixture('status-resumed.json'))).toMatchObject({ state: 'playing', timeSec: 7 });
  });
  it('stopped with nothing loaded: no information block, zero length', () => {
    expect(parseStatus(fixture('status-stopped.json'))).toEqual({
      state: 'stopped',
      position: 0,
      lengthSec: 0,
      timeSec: 0,
      filename: null,
      volume: 0,
      rate: 1,
    });
  });
  it('rejects non-status documents and clamps garbage', () => {
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({ foo: 1 })).toBeNull();
    expect(parseStatus({ state: 'weird', position: 7, length: -3 })).toMatchObject({ state: 'unknown', position: 1, lengthSec: 0 });
  });
});

describe('parsePlaylist (real VLC 3.0.21 playlist.json)', () => {
  it('finds the current leaf and decodes its file URI to a Windows path', () => {
    const pl = parsePlaylist(fixture('playlist.json'));
    expect(pl.items).toHaveLength(1);
    expect(pl.current).toMatchObject({
      id: '3',
      name: 'fixture clip.mp4',
      uri: 'file:///C:/Users/wills/Videos/fixture%20clip.mp4',
      path: 'C:\\Users\\wills\\Videos\\fixture clip.mp4',
      duration: 30,
      current: true,
    });
  });
  it('empty playlist → no current item', () => {
    const pl = parsePlaylist(fixture('playlist-empty.json'));
    expect(pl.items).toEqual([]);
    expect(pl.current).toBeNull();
  });
  it('tolerates junk', () => {
    expect(parsePlaylist(undefined)).toEqual({ items: [], current: null });
    expect(parsePlaylist({ children: [{ type: 'leaf', uri: 'http://x/y.m3u8', current: 'current', id: 9 }] }).current).toMatchObject({ path: null, id: '9' });
  });
});

describe('vlcUriToPath', () => {
  it('handles drive letters, percent-encoding, UNC and posix', () => {
    expect(vlcUriToPath('file:///C:/Users/x/a%20b.mp4')).toBe('C:\\Users\\x\\a b.mp4');
    expect(vlcUriToPath('file:///X:/Video%20Folder/Plex%20Movies/Dune%20(2021)/Dune.mkv')).toBe('X:\\Video Folder\\Plex Movies\\Dune (2021)\\Dune.mkv');
    expect(vlcUriToPath('file://nas/share/film.mkv')).toBe('\\\\nas\\share\\film.mkv');
    expect(vlcUriToPath('file:///home/u/film.mkv')).toBe('/home/u/film.mkv');
    expect(vlcUriToPath('file:///C:/caf%C3%A9.mkv')).toBe('C:\\café.mkv');
  });
  it('returns null for non-file inputs', () => {
    expect(vlcUriToPath('http://example.com/a.m3u8')).toBeNull();
    expect(vlcUriToPath('dvd:///D:/')).toBeNull();
    expect(vlcUriToPath('not a uri')).toBeNull();
  });
});

// ------------------------------------------------------------------ bridge behaviour

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeBridge(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    return handler(url, init);
  });
  let now = 1_000_000;
  const bridge = new VlcBridge({ exe: 'C:\\vlc.exe', port: 8099, password: 'pw', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });
  const events: VlcStatusEvent[] = [];
  bridge.onStatus((e) => events.push(e));
  return { bridge, events, calls, fetchImpl, tick: (ms: number) => (now += ms) };
}

describe('VlcBridge', () => {
  it('is disabled when neither exe nor password is configured', () => {
    expect(new VlcBridge({ exe: '', port: 1, password: '' }).enabled).toBe(false);
    expect(new VlcBridge({ exe: 'C:\\vlc.exe', port: 1, password: 'x' }).enabled).toBe(true);
  });

  it('polls status + playlist with Basic auth and emits a decoded status', async () => {
    const { bridge, events, calls, fetchImpl } = makeBridge((url) =>
      url.pathname.endsWith('status.json') ? jsonResponse(fixture('status-resumed.json')) : jsonResponse(fixture('playlist.json')),
    );
    await bridge.pollOnce();
    expect(bridge.connected).toBe(true);
    expect(calls.map((u) => u.pathname)).toEqual(['/requests/status.json', '/requests/playlist.json']);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(':pw').toString('base64')}`);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({ connected: true, state: 'playing', playing: true, lengthSec: 30, path: 'C:\\Users\\wills\\Videos\\fixture clip.mp4', filename: 'fixture clip.mp4' });
    // No probe duration known: position × VLC length.
    expect(ev.positionSec).toBeCloseTo(0.24669997394085 * 30, 6);
  });

  // Case-insensitive matching is a Windows filesystem rule; on Linux the bridge compares exactly.
  it.skipIf(process.platform !== 'win32')('uses the probed duration for positionSec once hinted (case-insensitive path match)', async () => {
    const { bridge, events } = makeBridge((url) =>
      url.pathname.endsWith('status.json') ? jsonResponse(fixture('status-resumed.json')) : jsonResponse(fixture('playlist.json')),
    );
    bridge.setDurationHint('c:\\users\\WILLS\\Videos\\fixture clip.mp4', 30.5);
    await bridge.pollOnce();
    expect(events[0]!.positionSec).toBeCloseTo(0.24669997394085 * 30.5, 6);
  });

  it('skips the playlist when VLC is stopped with nothing loaded', async () => {
    const { bridge, events, calls } = makeBridge(() => jsonResponse(fixture('status-stopped.json')));
    await bridge.pollOnce();
    expect(calls).toHaveLength(1);
    expect(events[0]).toMatchObject({ connected: true, state: 'stopped', playing: false, path: null, positionSec: 0 });
  });

  it('flips connected=false only after 3 consecutive failures, then back on the first success', async () => {
    let fail = false;
    const { bridge, events } = makeBridge((url) => {
      if (fail) throw new Error('ECONNREFUSED');
      return url.pathname.endsWith('status.json') ? jsonResponse(fixture('status-playing.json')) : jsonResponse(fixture('playlist.json'));
    });
    await bridge.pollOnce();
    expect(bridge.connected).toBe(true);
    fail = true;
    await bridge.pollOnce();
    await bridge.pollOnce();
    expect(bridge.connected).toBe(true);
    expect(events).toHaveLength(1);
    await bridge.pollOnce();
    expect(bridge.connected).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ connected: false, playing: false, path: null });
    fail = false;
    await bridge.pollOnce();
    expect(bridge.connected).toBe(true);
    expect(events[2]?.connected).toBe(true);
  });

  it('never reports connected while VLC has not answered yet (no disconnect event on cold start)', async () => {
    const { bridge, events } = makeBridge(() => {
      throw new Error('ECONNREFUSED');
    });
    for (let i = 0; i < 5; i++) await bridge.pollOnce();
    expect(bridge.connected).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('a 401 counts as a failure', async () => {
    const { bridge } = makeBridge(() => jsonResponse({}, 401));
    await bridge.pollOnce();
    expect(bridge.connected).toBe(false);
  });

  it('sends the documented commands', async () => {
    const { bridge, calls } = makeBridge(() => jsonResponse(fixture('status-playing.json')));
    await bridge.play();
    await bridge.pause();
    await bridge.seek(41.6);
    await bridge.seek(-3);
    const q = calls.map((u) => `${u.pathname}?${u.searchParams.toString()}`);
    expect(q).toEqual([
      '/requests/status.json?command=pl_forceresume',
      '/requests/status.json?command=pl_forcepause',
      '/requests/status.json?command=seek&val=42',
      '/requests/status.json?command=seek&val=0',
    ]);
  });

  it('command failures reject', async () => {
    const { bridge } = makeBridge(() => jsonResponse('nope', 500));
    await expect(bridge.play()).rejects.toThrow(/500/);
  });

  it('launch rejects without an executable', async () => {
    const b = new VlcBridge({ exe: '', port: 1, password: 'x', enabled: true });
    await expect(b.launch('C:\\x.mkv')).rejects.toThrow(/not configured/);
  });
});
