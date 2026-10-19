// End to end over real sockets: express app + ws server on an ephemeral port, FakeMediaService,
// FakeBridge, two `ws` clients. The "remote" client connects over loopback but carries
// X-Forwarded-For, exactly what `tailscale serve` does.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { C2S, HealthResponse, HostSettingsResponse, PROTOCOL_VERSION, S2C, ShutdownResponse, type MediaInfo } from '@wochit/shared';
import { FailureLimiter, mediaToken } from '../src/auth.js';
import { createGifService, type GifService } from '../src/gif/index.js';
import { silentLogger } from '../src/log.js';
import type { TailnetStatus } from '../src/net/tailscale.js';
import { Room } from '../src/room/room.js';
import { createApp } from '../src/server/http.js';
import { attachWebSocket, type WsHandle } from '../src/server/ws.js';
import { FakeBridge } from './fakes/fakeBridge.js';
import { CLIP, FILM, newFakeMedia, type FakeMediaService } from './fakes/fakeMediaService.js';

const PIN = '123456';
const TOKEN = mediaToken(PIN);
const REMOTE_IP = '100.90.1.2';
const ALLOWED_ORIGIN = 'https://wochit.vercel.app';
const CORS_ORIGINS = [ALLOWED_ORIGIN, 'https://allowed.example'];
const URLS = ['http://127.0.0.1:8788', 'https://william-desktop.tail2ac207.ts.net:8443'];
const HERE = path.dirname(fileURLToPath(import.meta.url));

let server: Server;
let ws: WsHandle;
let room: Room;
let media: FakeMediaService;
let bridge: FakeBridge;
let gif: GifService;
let envPath: string;
let tailnetStatus: TailnetStatus | null = null;
const onShutdownRequest = vi.fn();
/** Every GIF provider call answers with the Klipy trending fixture; nothing leaves the process. */
const gifFetch = vi.fn(async (input: string | URL | Request) => {
  void input;
  return new Response(readFileSync(path.join(HERE, 'fixtures', 'gif', 'klipy-trending.json'), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
});
let base: string;
let wsUrl: string;
let clock = 1_700_000_000_000;
const now = () => clock;

class Client {
  readonly sock: WebSocket;
  readonly inbox: S2C[] = [];
  private waiters: Array<{ pred: (m: S2C) => boolean; resolve: (m: S2C) => void }> = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;

  constructor(headers: Record<string, string> = {}) {
    this.sock = new WebSocket(wsUrl, { headers });
    this.closed = new Promise((resolve) => {
      this.sock.on('close', (code) => {
        this.closeCode = code;
        resolve(code);
      });
    });
    this.sock.on('message', (data) => {
      const parsed = S2C.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) throw new Error(`server sent an invalid frame: ${data.toString()}`);
      this.inbox.push(parsed.data);
      const idx = this.waiters.findIndex((w) => w.pred(parsed.data));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w!.resolve(parsed.data);
      }
    });
  }

  open(): Promise<void> {
    if (this.sock.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.sock.once('open', () => resolve());
      this.sock.once('error', reject);
    });
  }

  send(msg: C2S | Record<string, unknown>): void {
    this.sock.send(JSON.stringify(msg));
  }

  sendRaw(text: string): void {
    this.sock.send(text);
  }

  /** Next message matching `pred`, searching the backlog first. */
  next<T extends S2C['type']>(type: T, pred: (m: Extract<S2C, { type: T }>) => boolean = () => true, timeoutMs = 3000): Promise<Extract<S2C, { type: T }>> {
    const match = (m: S2C): m is Extract<S2C, { type: T }> => m.type === type && pred(m as Extract<S2C, { type: T }>);
    const idx = this.inbox.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0] as Extract<S2C, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: match,
        resolve: (m) => {
          clearTimeout(timer);
          this.inbox.splice(this.inbox.indexOf(m), 1);
          resolve(m as Extract<S2C, { type: T }>);
        },
      });
    });
  }

  async hello(nick: string, clientId: string, mode: 'auto' | 'host' | 'guest' = 'auto', pin = PIN) {
    await this.open();
    this.send({ type: 'hello', v: PROTOCOL_VERSION, pin, nick, clientId, mode });
    return this.next('welcome');
  }

  close(): void {
    this.sock.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  media = newFakeMedia();
  await media.init();
  bridge = new FakeBridge({ now });
  const limiter = new FailureLimiter({ now });
  room = new Room({ media, bridge, log: silentLogger, mediaToken: TOKEN, gifSearchAvailable: false, chatLogDir: null, now });
  // A stand-in web/dist: index.html plus one hashed asset.
  const webDir = mkdtempSync(path.join(os.tmpdir(), 'wochit-webdist-'));
  mkdirSync(path.join(webDir, 'assets'));
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>WochIt</title><div id="root"></div>');
  writeFileSync(path.join(webDir, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(path.join(webDir, 'manifest.webmanifest'), '{"name":"WochIt"}');
  envPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'wochit-env-')), '.env');
  writeFileSync(envPath, '# test env\nWOCHIT_PORT=8788\nKLIPY_API_KEY=\n', 'utf8');
  gif = createGifService({ provider: 'auto', klipyKey: null, giphyKey: null, fetchImpl: gifFetch as unknown as typeof fetch });
  const app = createApp({
    media,
    room,
    bridge,
    gif,
    log: silentLogger,
    pin: PIN,
    mediaToken: TOKEN,
    limiter,
    ownAddrs: ['127.0.0.1', '::1'],
    webDir,
    version: '0.0.0-test',
    corsOrigins: CORS_ORIGINS,
    urls: () => URLS,
    envPath,
    tailscaleShareLink: null,
    tailnet: () => tailnetStatus,
    onShutdownRequest,
  });
  server = createServer(app);
  ws = attachWebSocket({
    server,
    room,
    pin: PIN,
    mediaToken: TOKEN,
    limiter,
    ownAddrs: ['127.0.0.1', '::1'],
    corsOrigins: CORS_ORIGINS,
    log: silentLogger,
    helloTimeoutMs: 400,
    keepaliveMs: 0,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  room.dispose();
  await ws.closeAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
});

describe('REST', () => {
  it('/api/health is open with permissive CORS', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body: unknown = await res.json();
    expect(body).toEqual({
      ok: true,
      version: '0.0.0-test',
      protocol: PROTOCOL_VERSION,
      source: 'none',
      vlc: { connected: false, following: true },
      ffmpeg: { found: false, encoder: null },
      gifSearchAvailable: false,
      gifProvider: null,
      cache: { usedBytes: 0, maxBytes: 0 },
      urls: URLS,
      members: { hosts: 0, guests: 0 },
    });
    expect(HealthResponse.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty('tailnet'); // no tailscale CLI → field absent
  });

  it('/api/health carries the cached tailnet check when the CLI answered', async () => {
    tailnetStatus = { published: true, url: 'https://william-desktop.tail2ac207.ts.net:8443', checkedAt: clock };
    try {
      const body = HealthResponse.parse(await (await fetch(`${base}/api/health`)).json());
      expect(body.tailnet).toEqual({ published: true, url: 'https://william-desktop.tail2ac207.ts.net:8443', checkedAt: clock });
    } finally {
      tailnetStatus = null;
    }
  });

  describe('CORS for the Vercel copy of the web app', () => {
    it('same-origin requests (no Origin, or Origin host == Host) get no CORS headers', async () => {
      const plain = await fetch(`${base}/api/health`.replace('/health', '/library'), { headers: { 'x-wochit-pin': PIN } });
      expect(plain.headers.get('access-control-allow-origin')).toBeNull();
      const same = await fetch(`${base}/api/library`, { headers: { 'x-wochit-pin': PIN, Origin: base } });
      expect(same.status).toBe(200);
      expect(same.headers.get('access-control-allow-origin')).toBeNull();
      const sameHttps = await fetch(`${base}/api/library`, { headers: { 'x-wochit-pin': PIN, Origin: base.replace('http://', 'https://') } });
      expect(sameHttps.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('an allowed Origin is reflected with Vary and the expose headers on /api and /media', async () => {
      const api = await fetch(`${base}/api/library`, { headers: { 'x-wochit-pin': PIN, Origin: ALLOWED_ORIGIN } });
      expect(api.status).toBe(200);
      expect(api.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
      expect(api.headers.get('vary')).toContain('Origin');
      expect(api.headers.get('access-control-expose-headers')).toBe('content-length, content-range, accept-ranges');

      const seg = await fetch(`${base}/media/${CLIP.id}/720p/seg00001.ts?t=${TOKEN}`, { headers: { Origin: 'https://allowed.example', Range: 'bytes=0-187' } });
      expect(seg.status).toBe(206);
      expect(seg.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
      expect(seg.headers.get('content-range')).toBe(`bytes 0-187/${188 * 4}`);

      // a 401 still carries the CORS headers so the browser can read the JSON error
      const unauth = await fetch(`${base}/media/${CLIP.id}/master.m3u8`, { headers: { Origin: ALLOWED_ORIGIN } });
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    });

    it('preflights: 204 with allow-headers for allowed origins, 403 for others', async () => {
      const pre = await fetch(`${base}/api/gif/search?q=x`, {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-wochit-pin' },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
      expect(pre.headers.get('access-control-allow-headers')).toBe('x-wochit-pin, range');
      expect(pre.headers.get('access-control-allow-methods')).toContain('GET');

      const media = await fetch(`${base}/media/${CLIP.id}/720p/seg00001.ts?t=${TOKEN}`, {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
      });
      expect(media.status).toBe(204);

      const denied = await fetch(`${base}/api/library`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
      expect(denied.status).toBe(403);
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('a denied Origin on a plain GET gets no CORS headers (the browser blocks it)', async () => {
      const res = await fetch(`${base}/api/library`, { headers: { 'x-wochit-pin': PIN, Origin: 'https://evil.example' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('/api/library needs the PIN header and a local address', async () => {
    expect((await fetch(`${base}/api/library`)).status).toBe(401);
    const remote = await fetch(`${base}/api/library`, { headers: { 'x-wochit-pin': PIN, 'x-forwarded-for': REMOTE_IP } });
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({ error: 'not_host' });
    const local = await fetch(`${base}/api/library`, { headers: { 'x-wochit-pin': PIN } });
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ parentId: null, entries: [{ kind: 'dir', id: 'root-fake', name: 'FakeMedia', displayPath: 'FakeMedia' }] });
    const files = await (await fetch(`${base}/api/library?parent=root-fake`, { headers: { 'x-wochit-pin': PIN } })).json();
    expect(files).toMatchObject({ parentId: 'root-fake', entries: [expect.objectContaining({ id: FILM.id }), expect.objectContaining({ id: CLIP.id })] });
  });

  it('/api/gif/* needs the PIN and reports when no GIF provider is configured', async () => {
    expect((await fetch(`${base}/api/gif/search?q=x`)).status).toBe(401);
    const res = await fetch(`${base}/api/gif/search?q=x`, { headers: { 'x-wochit-pin': PIN } });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'server_error' });
  });

  it('unknown /api routes are JSON 404s', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'bad_message' });
  });

  it('serves the web app: index.html no-cache, immutable /assets, SPA fallback, 404 for missing files', async () => {
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(await root.text()).toContain('id="root"');

    const asset = await fetch(`${base}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('cache-control')).toBe('no-cache');

    const spa = await fetch(`${base}/room/anything?mode=guest`, { headers: { Accept: 'text/html,*/*' } });
    expect(spa.status).toBe(200);
    expect(spa.headers.get('content-type')).toContain('text/html');
    expect(spa.headers.get('cache-control')).toBe('no-cache');

    expect((await fetch(`${base}/assets/index-oldhash.js`)).status).toBe(404);
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${base}/ws`)).status).toBe(200); // plain GET on /ws falls through to the SPA
  });
});

describe('/media', () => {
  it('rejects a missing or wrong token with 401', async () => {
    expect((await fetch(`${base}/media/${FILM.id}/master.m3u8`)).status).toBe(401);
    expect((await fetch(`${base}/media/${FILM.id}/master.m3u8?t=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/media/${FILM.id}/1080p/seg00000.ts`)).status).toBe(401);
    const body = await (await fetch(`${base}/media/${FILM.id}/poster.jpg`)).json();
    expect(body).toMatchObject({ error: 'bad_pin' });
  });

  it('master and media playlists carry the token on every URI and are no-store', async () => {
    const master = await fetch(`${base}/media/${FILM.id}/master.m3u8?t=${TOKEN}`);
    expect(master.status).toBe(200);
    expect(master.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(master.headers.get('cache-control')).toBe('no-store');
    const text = await master.text();
    expect(text).toContain(`1080p/index.m3u8?t=${TOKEN}`);

    const pl = await fetch(`${base}/media/${CLIP.id}/720p/index.m3u8?t=${TOKEN}`);
    expect(pl.status).toBe(200);
    const plText = await pl.text();
    expect(plText).toContain(`seg00000.ts?t=${TOKEN}`);
    expect(plText).toContain('#EXT-X-ENDLIST');
    expect(plText.match(/#EXTINF/g)).toHaveLength(Math.ceil(CLIP.durationSec / 4));
  });

  it('segments stream with video/mp2t, long private caching and Range support', async () => {
    const seg = await fetch(`${base}/media/${CLIP.id}/720p/seg00003.ts?t=${TOKEN}`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get('content-type')).toBe('video/mp2t');
    expect(seg.headers.get('cache-control')).toBe('private, max-age=31536000');
    expect(seg.headers.get('accept-ranges')).toBe('bytes');
    const buf = Buffer.from(await seg.arrayBuffer());
    expect(buf.length).toBe(188 * 4);
    expect(buf[0]).toBe(0x47);

    const part = await fetch(`${base}/media/${CLIP.id}/720p/seg00003.ts?t=${TOKEN}`, { headers: { Range: 'bytes=188-375' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 188-375/${188 * 4}`);
    const slice = Buffer.from(await part.arrayBuffer());
    expect(slice.length).toBe(188);
    expect(slice[0]).toBe(0x47);
    expect(slice.toString('ascii', 4, 80)).toContain('seg 3 pkt 1');
  });

  it('maps MediaError codes: past-the-end segment and unknown media → 404, unknown rendition → 404', async () => {
    const past = await fetch(`${base}/media/${CLIP.id}/720p/seg00099.ts?t=${TOKEN}`);
    expect(past.status).toBe(404);
    expect(await past.json()).toMatchObject({ error: 'unknown_media' });
    expect((await fetch(`${base}/media/doesnotexist/master.m3u8?t=${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${base}/media/${CLIP.id}/4k/index.m3u8?t=${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${base}/media/${CLIP.id}/1080p/index.m3u8?t=${TOKEN}`)).status).toBe(404); // 720p source has no 1080p rung
    expect((await fetch(`${base}/media/${CLIP.id}/720p/notasegment.ts?t=${TOKEN}`)).status).toBe(404);
  });

  it('subtitles are text/vtt; a missing poster is 404', async () => {
    const vtt = await fetch(`${base}/media/${CLIP.id}/subs/0.vtt?t=${TOKEN}`);
    expect(vtt.status).toBe(200);
    expect(vtt.headers.get('content-type')).toContain('text/vtt');
    expect(vtt.headers.get('cache-control')).toBe('private, max-age=31536000');
    expect(await vtt.text()).toContain('WEBVTT');
    expect((await fetch(`${base}/media/${CLIP.id}/poster.jpg?t=${TOKEN}`)).status).toBe(404);
  });
});

describe('WebSocket handshake', () => {
  it('closes with 4000 when no hello arrives in time', async () => {
    const c = new Client();
    await c.open();
    expect(await c.closed).toBe(4000);
  });

  it('bad PIN → error bad_pin then close 4001; five of them → 4003 rate limited', async () => {
    const headers = { 'x-forwarded-for': '100.90.9.9' };
    for (let i = 0; i < 5; i++) {
      const c = new Client(headers);
      await c.open();
      c.send({ type: 'hello', v: PROTOCOL_VERSION, pin: '000000', nick: 'x', clientId: 'badpin-client', mode: 'auto' });
      const err = await c.next('error');
      expect(err.code).toBe('bad_pin');
      expect(await c.closed).toBe(4001);
    }
    const blocked = new Client(headers);
    await blocked.open();
    blocked.send({ type: 'hello', v: PROTOCOL_VERSION, pin: PIN, nick: 'x', clientId: 'badpin-client', mode: 'auto' });
    expect((await blocked.next('error')).code).toBe('rate_limited');
    expect(await blocked.closed).toBe(4003);
    // Another address is unaffected.
    const other = new Client({ 'x-forwarded-for': '100.90.9.10' });
    const w = await other.hello('ok', 'other-client-1');
    expect(w.you.nick).toBe('ok');
    other.close();
    await other.closed;
  });

  it('WebSocket Origin: same-origin and allowed origins join; others close 4003 before hello', async () => {
    const fromVercel = new Client({ Origin: ALLOWED_ORIGIN });
    const w = await fromVercel.hello('Vercel', 'vercel-client-01');
    expect(w.you.nick).toBe('Vercel');
    fromVercel.close();
    await fromVercel.closed;

    const same = new Client({ Origin: base });
    await same.hello('Same', 'same-client-0001');
    same.close();
    await same.closed;

    const evil = new Client({ Origin: 'https://evil.example' });
    await evil.open();
    expect(await evil.closed).toBe(4003);
  });

  it('protocol version mismatch → 4002', async () => {
    const c = new Client();
    await c.open();
    c.send({ type: 'hello', v: 99, pin: PIN, nick: 'x', clientId: 'version-client', mode: 'auto' });
    expect((await c.next('error')).code).toBe('bad_message');
    expect(await c.closed).toBe(4002);
  });

  it('non-hello first frames and junk get bad_message but the socket stays open until hello', async () => {
    const c = new Client();
    await c.open();
    c.sendRaw('{not json');
    expect((await c.next('error')).code).toBe('bad_message');
    c.send({ type: 'ping', t: 1 });
    expect((await c.next('error')).code).toBe('bad_message');
    c.send({ type: 'hello', v: PROTOCOL_VERSION, pin: PIN, nick: '', clientId: 'short', mode: 'auto' });
    expect((await c.next('error')).code).toBe('bad_message');
    const w = await c.hello('late', 'late-client-1');
    expect(w.you.nick).toBe('late');
    c.close();
    await c.closed;
  });
});

describe('a session: local host + remote guest', () => {
  let host: Client;
  let guest: Client;
  let hostId: string;
  let guestId: string;

  beforeAll(async () => {
    host = new Client();
    const hw = await host.hello('Will', 'host-client-0001', 'host');
    hostId = hw.you.id;
    expect(hw.you.isHost).toBe(true);
    expect(hw.mediaToken).toBe(TOKEN);
    expect(hw.vlc).toEqual({ connected: false, following: true });
    guest = new Client({ 'x-forwarded-for': REMOTE_IP, 'tailscale-user-login': 'mia@example.com' });
    const gw = await guest.hello('Mia', 'guest-client-001', 'auto');
    guestId = gw.you.id;
    expect(gw.you.isHost).toBe(false);
    expect(gw.room.members.map((m) => m.nick)).toEqual(['Will', 'Mia']);
    const presence = await host.next('presence');
    expect(presence.members.map((m) => m.id)).toEqual([hostId, guestId]);
  });

  afterAll(async () => {
    host.close();
    guest.close();
    await Promise.all([host.closed, guest.closed]);
  });

  it('mode=host from a remote address is a guest and gets an informational not_host', async () => {
    const c = new Client({ 'x-forwarded-for': '100.90.1.3' });
    const w = await c.hello('Imposter', 'imposter-client-1', 'host');
    expect(w.you.isHost).toBe(false);
    expect((await c.next('error')).code).toBe('not_host');
    c.close();
    await c.closed;
    await host.next('presence', (p) => p.members.length === 2);
    await guest.next('presence', (p) => p.members.length === 2);
  });

  it('guest cannot select media; host can, and media URLs reach both with the token', async () => {
    guest.send({ type: 'select_media', mediaId: FILM.id });
    expect((await guest.next('error')).code).toBe('not_host');

    host.send({ type: 'select_media', mediaId: FILM.id });
    const [hm, gm] = await Promise.all([host.next('media'), guest.next('media')]);
    const check = (m: MediaInfo | null) => {
      expect(m?.id).toBe(FILM.id);
      expect(m?.masterUrl).toBe(`/media/${FILM.id}/master.m3u8?t=${TOKEN}`);
      for (const r of m?.renditions ?? []) expect(r.playlistUrl).toBe(`/media/${FILM.id}/${r.id}/index.m3u8?t=${TOKEN}`);
    };
    check(hm.media);
    check(gm.media);
    const st = await guest.next('state', (s) => s.state.mediaId === FILM.id);
    expect(st.state).toMatchObject({ source: 'browser', playing: false, position: 0 });
    await host.next('state', (s) => s.state.mediaId === FILM.id);

    // The decorated URL actually works against the HTTP side.
    const res = await fetch(`${base}${gm.media!.masterUrl}`);
    expect(res.status).toBe(200);
  });

  it('pause/play/seek in browser mode with a fake clock, seq strictly increasing on both sides', async () => {
    const seen: number[] = [];
    guest.send({ type: 'control', action: 'play' });
    let s = await guest.next('state', (m) => m.state.playing);
    seen.push(s.state.seq);
    expect(s.state).toMatchObject({ position: 0, updatedAt: clock });
    let hs = await host.next('state', (m) => m.state.seq === s.state.seq);
    expect(hs.state).toEqual(s.state);

    clock += 5000;
    host.send({ type: 'control', action: 'pause' });
    s = await guest.next('state', (m) => !m.state.playing);
    seen.push(s.state.seq);
    expect(s.state.position).toBe(5);
    await host.next('state', (m) => m.state.seq === s.state.seq);

    guest.send({ type: 'control', action: 'seek', position: 42 });
    s = await guest.next('state', (m) => m.state.position === 42);
    seen.push(s.state.seq);
    hs = await host.next('state', (m) => m.state.seq === s.state.seq);
    expect(hs.state.position).toBe(42);

    guest.send({ type: 'control', action: 'toggle' });
    s = await guest.next('state', (m) => m.state.playing);
    seen.push(s.state.seq);
    clock += 3000;
    guest.send({ type: 'ping', t: 7 });
    const pong = await guest.next('pong');
    expect(pong).toEqual({ type: 'pong', t: 7, serverTime: clock });
    expect(room.currentPosition()).toBe(45);
    host.send({ type: 'control', action: 'pause' });
    s = await guest.next('state', (m) => !m.state.playing);
    seen.push(s.state.seq);
    expect(s.state.position).toBe(45);

    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });

  it('chat echoes to both; nick change produces presence + system line', async () => {
    guest.send({ type: 'chat', kind: 'text', text: 'popcorn ready' });
    const [hc, gc] = await Promise.all([host.next('chat'), guest.next('chat')]);
    expect(hc.message).toEqual(gc.message);
    expect(hc.message).toMatchObject({ kind: 'text', text: 'popcorn ready', from: { id: guestId, nick: 'Mia' } });

    guest.send({ type: 'chat', kind: 'gif', gif: { id: 'g', provider: 'giphy', url: 'https://evil.example/a.gif', previewUrl: 'https://media0.giphy.com/media/a/100w.gif', width: 1, height: 1 } });
    expect((await guest.next('error')).code).toBe('bad_message');

    guest.send({ type: 'nick', nick: 'Mia ✨' });
    const p = await host.next('presence', (m) => m.members.some((x) => x.nick === 'Mia ✨'));
    expect(p.members.find((m) => m.id === guestId)?.nick).toBe('Mia ✨');
    const sys = await host.next('chat', (m) => m.message.kind === 'system');
    expect(sys.message.text).toBe('Mia is now Mia ✨');
    await guest.next('chat', (m) => m.message.kind === 'system');
    await guest.next('presence');
  });

  it('reactions echo to both and are rate limited per member', async () => {
    guest.send({ type: 'reaction', kind: 'cheer' });
    const [hr, gr] = await Promise.all([host.next('reaction'), guest.next('reaction')]);
    expect(hr).toEqual(gr);
    expect(hr).toMatchObject({ kind: 'cheer', from: { id: guestId } });
    guest.send({ type: 'reaction', kind: 'boo' }); // inside the gap: dropped
    host.send({ type: 'reaction', kind: 'heart' }); // other member: fine
    const h2 = await host.next('reaction');
    expect(h2.kind).toBe('heart');
    await guest.next('reaction', (r) => r.kind === 'heart');
    await sleep(50);
    expect(host.inbox.filter((m) => m.type === 'reaction')).toHaveLength(0);
    clock += 400;
    guest.send({ type: 'reaction', kind: 'boo' });
    expect((await host.next('reaction')).kind).toBe('boo');
    await guest.next('reaction', (r) => r.kind === 'boo');
  });

  it('invalid frames after hello get bad_message and the socket stays open', async () => {
    guest.send({ type: 'control', action: 'rewind' });
    const err = await guest.next('error');
    expect(err.code).toBe('bad_message');
    guest.send({ type: 'ping', t: 99 });
    expect((await guest.next('pong')).t).toBe(99);
  });

  it('guest telemetry rides on ping and reaches the host as `telemetry` over the real socket; the guest only sees the pong', async () => {
    const telemetry = { position: 41.5, playing: true, bufferedAheadSec: 8, rendition: 'auto' as const, stalled: false, rttMs: 62 };
    guest.send({ type: 'ping', t: 11, telemetry });
    expect((await guest.next('pong')).t).toBe(11);
    const t = await host.next('telemetry');
    expect(t.members).toHaveLength(1);
    expect(t.members[0]).toMatchObject({ ...telemetry, id: guestId, at: clock });
    expect(t.members[0]!.driftSec).toBeCloseTo(41.5 - 45, 6);
    await sleep(50);
    expect(guest.inbox.filter((m) => m.type === 'telemetry')).toHaveLength(0);
  });

  it('a second tab with the same clientId gets its own member id; reconnecting after close reuses it', async () => {
    const tab2 = new Client();
    const w2 = await tab2.hello('Will', 'host-client-0001', 'auto');
    expect(w2.you.id).not.toBe(hostId);
    expect(w2.you.isHost).toBe(true);
    tab2.close();
    await tab2.closed;
    await host.next('presence', (p) => p.members.length === 2);
    await guest.next('presence', (p) => p.members.length === 2);

    const again = new Client({ 'x-forwarded-for': REMOTE_IP });
    const w3 = await again.hello('Mia', 'guest-client-001', 'auto');
    expect(w3.you.id).not.toBe(guestId); // guest is still connected; a fresh id
    again.close();
    await again.closed;
    guest.close();
    await guest.closed;
    const back = new Client({ 'x-forwarded-for': REMOTE_IP });
    const w4 = await back.hello('Mia', 'guest-client-001', 'auto');
    expect(w4.you.id).toBe(guestId);
    guest = back;
  });
});

describe('host console REST: /api/host/*', () => {
  const hostHeaders = { 'x-wochit-pin': PIN };
  const readEnv = (): string => readFileSync(envPath, 'utf8');

  it('GET /api/host/settings is loopback + PIN only (401 bad_pin, 403 not_host) and never echoes keys', async () => {
    const noPin = await fetch(`${base}/api/host/settings`);
    expect(noPin.status).toBe(401);
    expect(await noPin.json()).toMatchObject({ error: 'bad_pin' });
    const wrongPin = await fetch(`${base}/api/host/settings`, { headers: { 'x-wochit-pin': '000000' } });
    expect(wrongPin.status).toBe(401);
    const remote = await fetch(`${base}/api/host/settings`, { headers: { ...hostHeaders, 'x-forwarded-for': REMOTE_IP } });
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({ error: 'not_host' });

    const ok = await fetch(`${base}/api/host/settings`, { headers: hostHeaders });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const body = HostSettingsResponse.parse(await ok.json());
    expect(body).toEqual({ gifSearchAvailable: false, gifProvider: null, keys: { klipy: false, giphy: false }, tailscaleShareLink: null });
  });

  it('PATCH /api/host/settings validates the body (400 bad_message) and enforces the same host-only rule', async () => {
    const patch = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/host/settings`, { method: 'PATCH', headers: { ...hostHeaders, 'content-type': 'application/json', ...headers }, body });
    const before = readEnv();

    const notObject = await patch('"abc"');
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toMatchObject({ error: 'bad_message' });
    const badType = await patch(JSON.stringify({ klipyApiKey: 123 }));
    expect(badType.status).toBe(400);
    expect(await badType.json()).toMatchObject({ error: 'bad_message' });
    const tooLong = await patch(JSON.stringify({ giphyApiKey: 'x'.repeat(201) }));
    expect(tooLong.status).toBe(400);
    const notJson = await patch('{nope');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: 'bad_message' });
    const badLink = await patch(JSON.stringify({ tailscaleShareLink: 'not a url' }));
    expect(badLink.status).toBe(400);
    expect(await badLink.json()).toMatchObject({ error: 'bad_message' });
    const noBody = await fetch(`${base}/api/host/settings`, { method: 'PATCH', headers: hostHeaders });
    expect(noBody.status).toBe(400);

    expect((await patch(JSON.stringify({ klipyApiKey: 'k' }), { 'x-forwarded-for': REMOTE_IP })).status).toBe(403);
    expect((await fetch(`${base}/api/host/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);

    expect(readEnv()).toBe(before); // nothing was written
    expect(gif.available).toBe(false);
  });

  it('PATCH writes the key into .env, flips GIF search on without a restart (health, welcome, /api/gif/*), and an empty string turns it off again', async () => {
    const patch = (body: Record<string, string>) =>
      fetch(`${base}/api/host/settings`, { method: 'PATCH', headers: { ...hostHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const on = await patch({ klipyApiKey: 'klipy-test-key' });
    expect(on.status).toBe(200);
    expect(HostSettingsResponse.parse(await on.json())).toEqual({ gifSearchAvailable: true, gifProvider: 'klipy', keys: { klipy: true, giphy: false }, tailscaleShareLink: null });
    expect(readEnv()).toBe('# test env\nWOCHIT_PORT=8788\nKLIPY_API_KEY=klipy-test-key\n');

    const health = HealthResponse.parse(await (await fetch(`${base}/api/health`)).json());
    expect(health).toMatchObject({ gifSearchAvailable: true, gifProvider: 'klipy' });

    const c = new Client();
    const w = await c.hello('Will', 'settings-host-01', 'host');
    expect(w.gifSearchAvailable).toBe(true);
    expect(HealthResponse.parse(await (await fetch(`${base}/api/health`)).json()).members).toEqual({ hosts: 1, guests: 0 });
    c.close();
    await c.closed;

    const featured = await fetch(`${base}/api/gif/featured`, { headers: hostHeaders });
    expect(featured.status).toBe(200);
    expect(await featured.json()).toMatchObject({ provider: 'klipy' });
    expect(gifFetch).toHaveBeenCalled();
    const calledUrl = String(gifFetch.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('klipy-test-key'); // the key went to the provider, never to a client
    expect(JSON.stringify(health)).not.toContain('klipy-test-key');

    // GIPHY key added too: Klipy still wins in auto mode; the file keeps both.
    const both = await patch({ giphyApiKey: 'giphy-test-key' });
    expect(HostSettingsResponse.parse(await both.json())).toEqual({ gifSearchAvailable: true, gifProvider: 'klipy', keys: { klipy: true, giphy: true }, tailscaleShareLink: null });
    expect(readEnv()).toBe('# test env\nWOCHIT_PORT=8788\nKLIPY_API_KEY=klipy-test-key\nGIPHY_API_KEY=giphy-test-key\n');

    // The Tailscale share link is stored as WOCHIT_TS_SHARE_LINK and returned in full (host-only route).
    const link = 'https://login.tailscale.com/admin/invite/AbCdEf123?x=1';
    const withLink = await patch({ tailscaleShareLink: link });
    expect(withLink.status).toBe(200);
    expect(HostSettingsResponse.parse(await withLink.json())).toMatchObject({ tailscaleShareLink: link, gifProvider: 'klipy' });
    expect(readEnv()).toBe(`# test env\nWOCHIT_PORT=8788\nKLIPY_API_KEY=klipy-test-key\nGIPHY_API_KEY=giphy-test-key\nWOCHIT_TS_SHARE_LINK=${link}\n`);
    expect(HostSettingsResponse.parse(await (await fetch(`${base}/api/host/settings`, { headers: hostHeaders })).json()).tailscaleShareLink).toBe(link);
    expect(gif.provider).toBe('klipy'); // a link-only PATCH leaves GIF search alone

    // Clearing everything: present-but-empty lines, GIF search off, link null, /api/gif/* back to its configured error.
    const off = await patch({ klipyApiKey: '', giphyApiKey: '', tailscaleShareLink: '' });
    expect(HostSettingsResponse.parse(await off.json())).toEqual({ gifSearchAvailable: false, gifProvider: null, keys: { klipy: false, giphy: false }, tailscaleShareLink: null });
    expect(readEnv()).toBe('# test env\nWOCHIT_PORT=8788\nKLIPY_API_KEY=\nGIPHY_API_KEY=\nWOCHIT_TS_SHARE_LINK=\n');
    expect(HealthResponse.parse(await (await fetch(`${base}/api/health`)).json())).toMatchObject({ gifSearchAvailable: false, gifProvider: null });
    expect((await fetch(`${base}/api/gif/featured`, { headers: hostHeaders })).status).toBe(500);

    // An empty patch is a no-op that still answers.
    const noop = await patch({});
    expect(noop.status).toBe(200);
  });

  it('POST /api/host/shutdown answers ShutdownResponse then fires the callback exactly once; host-only', async () => {
    expect((await fetch(`${base}/api/host/shutdown`, { method: 'POST' })).status).toBe(401);
    const remote = await fetch(`${base}/api/host/shutdown`, { method: 'POST', headers: { ...hostHeaders, 'x-forwarded-for': REMOTE_IP } });
    expect(remote.status).toBe(403);
    expect(onShutdownRequest).not.toHaveBeenCalled();

    const res = await fetch(`${base}/api/host/shutdown`, { method: 'POST', headers: hostHeaders });
    expect(res.status).toBe(200);
    expect(ShutdownResponse.parse(await res.json())).toEqual({ ok: true, message: 'Host is shutting down' });
    await vi.waitFor(() => expect(onShutdownRequest).toHaveBeenCalledTimes(1));
    await sleep(30);
    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
    expect((await fetch(`${base}/api/host/shutdown`)).status).toBe(404); // GET is not a route
  });
});

describe('shutdown', () => {
  it('closeAll sends 1001 to every open socket', async () => {
    const c = new Client();
    await c.hello('bye', 'shutdown-client-1');
    const code = c.closed;
    await ws.closeAll(1001, 'host shutting down');
    expect(await code).toBe(1001);
  });
});
