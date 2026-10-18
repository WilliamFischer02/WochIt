#!/usr/bin/env node
// Dev-only stand-in for the host agent, speaking the real protocol (docs/PROTOCOL.md) in the
// `browser` source. Generates a 60 s test HLS once into dev/fixtures/ (720p + 360p), serves it as
// /media/mock/…, implements the room over /ws, the REST bits the web app uses, and
// GET /debug/state for the e2e suite. Run: `pnpm --filter @wochit/web dev:mock` (port 8788) so
// `vite dev` / `vite preview` proxy to it.
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

// ---------------------------------------------------------------- args
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? (all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true')];
  }).filter((p) => p.length),
);
const PORT = Number(args.port ?? process.env.WOCHIT_PORT ?? 8788);
const PIN = String(args.pin ?? process.env.WOCHIT_PIN ?? '123456');
const PROTOCOL_VERSION = 1;
const REACTION_MIN_GAP_MS = 400;
const DURATION_SEC = 60;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');
const DIST = join(here, '..', 'dist');

// ---------------------------------------------------------------- fixtures (ffmpeg, once)
const WINGET_FFMPEG =
  'C:/Users/wills/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';

function findFfmpeg() {
  if (process.env.WOCHIT_FFMPEG && existsSync(process.env.WOCHIT_FFMPEG)) return process.env.WOCHIT_FFMPEG;
  if (existsSync(WINGET_FFMPEG)) return WINGET_FFMPEG;
  return 'ffmpeg';
}

function fontFile() {
  const candidates =
    process.platform === 'win32'
      ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Helvetica.ttc'];
  return candidates.find((f) => existsSync(f)) ?? null;
}

function run(ffmpeg, argv) {
  const r = spawnSync(ffmpeg, argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  return { ok: r.status === 0, err: r.stderr?.toString() ?? String(r.error ?? '') };
}

function renderRendition(ffmpeg, { height, width, kbps, dir, drawtext }) {
  mkdirSync(dir, { recursive: true });
  const vf = [`scale=${width}:${height}`];
  if (drawtext) vf.push(drawtext);
  const argv = [
    '-hide_banner', '-loglevel', 'error', '-y', '-nostdin',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(DURATION_SEC),
    '-vf', vf.join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-g', '120', '-keyint_min', '120', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.2)}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', join(dir, 'seg%05d.ts'),
    join(dir, 'index.m3u8'),
  ];
  return run(ffmpeg, argv);
}

function ensureFixtures() {
  const master = join(FIXTURES, 'master.m3u8');
  const ok = [master, join(FIXTURES, '720p', 'index.m3u8'), join(FIXTURES, '360p', 'index.m3u8'), join(FIXTURES, 'subs', '0.vtt'), join(FIXTURES, 'poster.jpg')].every(existsSync);
  if (ok) return;
  const ffmpeg = findFfmpeg();
  console.log(`[mock] generating fixtures with ${ffmpeg} …`);
  const font = fontFile();
  // A literal ':' inside a quoted filter value must arrive at ffmpeg as '\:' (drive letter, pts\:hms).
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
  const drawtext = font
    ? `drawtext=fontfile='${esc(font)}':text='%{pts\\:hms}':fontsize=h/9:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-th-h/10`
    : null;
  for (const r of [
    { height: 720, width: 1280, kbps: 2800, dir: join(FIXTURES, '720p') },
    { height: 360, width: 640, kbps: 800, dir: join(FIXTURES, '360p') },
  ]) {
    let res = renderRendition(ffmpeg, { ...r, drawtext });
    if (!res.ok && drawtext) {
      console.warn(`[mock] drawtext failed (${res.err.trim().split('\n').pop()}); retrying without the timecode`);
      res = renderRendition(ffmpeg, { ...r, drawtext: null });
    }
    if (!res.ok) {
      console.error(`[mock] ffmpeg failed for ${r.height}p:\n${res.err}`);
      process.exit(1);
    }
  }
  writeFileSync(
    master,
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=3400000,AVERAGE-BANDWIDTH=2900000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=30.000',
      '720p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",FRAME-RATE=30.000',
      '360p/index.m3u8',
      '',
    ].join('\n'),
  );
  mkdirSync(join(FIXTURES, 'subs'), { recursive: true });
  const ts = (s) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;
  const cues = [];
  for (let s = 0; s < DURATION_SEC; s += 4) cues.push(`${ts(s)} --> ${ts(Math.min(s + 4, DURATION_SEC))}\nWochIt test subtitle · cue ${s / 4 + 1} · ${ts(s).slice(3, 8)}\n`);
  writeFileSync(join(FIXTURES, 'subs', '0.vtt'), `WEBVTT\n\n${cues.join('\n')}`);
  const poster = run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-ss', '6', '-frames:v', '1',
    '-vf', 'scale=480:-2', '-q:v', '4', join(FIXTURES, 'poster.jpg'),
  ]);
  if (!poster.ok) console.warn('[mock] poster failed:', poster.err);
  console.log('[mock] fixtures ready');
}
ensureFixtures();

// ---------------------------------------------------------------- the room
const MEDIA = {
  id: 'mock',
  title: 'WochIt test pattern (60 s)',
  durationSec: DURATION_SEC,
  width: 1280,
  height: 720,
  fps: 30,
  masterUrl: '/media/mock/master.m3u8',
  renditions: [
    { id: '720p', width: 1280, height: 720, bitrateKbps: 2800, playlistUrl: '/media/mock/720p/index.m3u8' },
    { id: '360p', width: 640, height: 360, bitrateKbps: 800, playlistUrl: '/media/mock/360p/index.m3u8' },
  ],
  subtitles: [{ id: '0', label: 'English (test)', lang: 'en', kind: 'sidecar', url: '/media/mock/subs/0.vtt', isDefault: false }],
  audioLabel: 'Sine 440 Hz',
  posterUrl: '/media/mock/poster.jpg',
};
const GIFS = [
  { id: 'g1', provider: 'klipy', url: 'https://static.klipy.com/ii/mock/g1/popcorn.gif', previewUrl: 'https://static.klipy.com/ii/mock/g1/popcorn-sm.gif', width: 498, height: 280, title: 'popcorn' },
  { id: 'g2', provider: 'klipy', url: 'https://static.klipy.com/ii/mock/g2/applause.gif', previewUrl: 'https://static.klipy.com/ii/mock/g2/applause-sm.gif', width: 480, height: 270, title: 'applause' },
  { id: 'g3', provider: 'klipy', url: 'https://static.klipy.com/ii/mock/g3/heart.gif', previewUrl: 'https://static.klipy.com/ii/mock/g3/heart-sm.gif', width: 320, height: 320, title: 'heart' },
];
const LIBRARY = {
  null: [
    { kind: 'dir', id: 'dir-samples', name: 'Samples', displayPath: 'Samples' },
    { kind: 'file', id: 'mock', name: 'WochIt test pattern.mp4', displayPath: 'WochIt test pattern.mp4', sizeBytes: 21_300_000, durationSec: DURATION_SEC },
  ],
  'dir-samples': [{ kind: 'file', id: 'mock', name: 'WochIt test pattern.mp4', displayPath: 'Samples / WochIt test pattern.mp4', sizeBytes: 21_300_000, durationSec: DURATION_SEC }],
};

function freshState() {
  return { seq: 0, source: 'none', mediaId: null, playing: false, position: 0, rate: 1, updatedAt: Date.now() };
}
const room = {
  state: freshState(),
  media: null,
  /** ws → member record */
  clients: new Map(),
  /** clientId → member id, so reconnects keep identity */
  memberIds: new Map(),
  chat: [],
  following: true,
  lastReactionAt: new Map(),
};

function positionNow() {
  const s = room.state;
  if (!s.mediaId) return 0;
  const pos = s.playing ? s.position + ((Date.now() - s.updatedAt) / 1000) * s.rate : s.position;
  return Math.min(Math.max(0, pos), room.media?.durationSec ?? Infinity);
}
function members() {
  return [...room.clients.values()].map((m) => ({ id: m.id, nick: m.nick, isHost: m.isHost, typing: m.typing }));
}
function broadcast(msg, except = null) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients.keys()) if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
}
function sendTo(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function setState(patch) {
  room.state = { ...room.state, ...patch, seq: room.state.seq + 1, updatedAt: Date.now() };
  broadcast({ type: 'state', state: room.state });
}
function systemLine(text) {
  const message = { id: randomUUID(), from: { id: 'system', nick: 'WochIt' }, kind: 'system', text, at: Date.now() };
  room.chat.push(message);
  room.chat = room.chat.slice(-200);
  broadcast({ type: 'chat', message });
}
function isLocal(req) {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Heartbeat: state every second while playing; pause at the end of the media.
setInterval(() => {
  if (!room.state.playing) return;
  const pos = positionNow();
  if (room.media && pos >= room.media.durationSec) {
    setState({ playing: false, position: room.media.durationSec });
    return;
  }
  room.state = { ...room.state, position: pos, updatedAt: Date.now() };
  broadcast({ type: 'state', state: room.state });
}, 1000);

function selectMedia(mediaId, ws) {
  if (mediaId !== MEDIA.id) return sendTo(ws, { type: 'error', code: 'unknown_media', message: 'Unknown media id' });
  room.media = MEDIA;
  broadcast({ type: 'media', media: room.media });
  setState({ source: 'browser', mediaId: MEDIA.id, playing: false, position: 0 });
  const who = room.clients.get(ws)?.nick ?? 'Host';
  systemLine(`${who} put on ${MEDIA.title}`);
  for (const r of MEDIA.renditions) {
    broadcast({ type: 'transcode', mediaId: MEDIA.id, rendition: r.id, status: 'starting' });
    setTimeout(() => broadcast({ type: 'transcode', mediaId: MEDIA.id, rendition: r.id, status: 'running', readyToSec: 24 }), 200);
    setTimeout(() => broadcast({ type: 'transcode', mediaId: MEDIA.id, rendition: r.id, status: 'done', readyToSec: DURATION_SEC }), 700);
  }
}

function handleMessage(ws, req, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return sendTo(ws, { type: 'error', code: 'bad_message', message: 'Not JSON' });
  }
  const me = room.clients.get(ws);

  if (!me) {
    if (msg?.type !== 'hello') return sendTo(ws, { type: 'error', code: 'bad_message', message: 'Say hello first' });
    if (msg.v !== PROTOCOL_VERSION) {
      sendTo(ws, { type: 'error', code: 'bad_message', message: 'Protocol version mismatch' });
      return ws.close(4002, 'protocol');
    }
    if (typeof msg.pin !== 'string' || msg.pin !== PIN) {
      sendTo(ws, { type: 'error', code: 'bad_pin', message: 'Wrong PIN' });
      return ws.close(4001, 'bad pin');
    }
    const nick = String(msg.nick ?? '').trim().slice(0, 24) || 'Someone';
    const clientId = String(msg.clientId ?? randomUUID());
    const local = isLocal(req);
    const mode = msg.mode ?? 'auto';
    const isHost = (mode === 'auto' && local) || (mode === 'host' && local);
    const id = room.memberIds.get(clientId) ?? randomUUID();
    room.memberIds.set(clientId, id);
    const member = { id, nick, isHost, typing: false, clientId };
    // A reconnect with the same clientId replaces the old socket.
    for (const [other, m] of room.clients) if (m.clientId === clientId) room.clients.delete(other);
    room.clients.set(ws, member);
    clearTimeout(ws.helloTimer);
    sendTo(ws, {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      you: { id, nick, isHost, typing: false },
      room: { state: { ...room.state, position: positionNow(), updatedAt: Date.now() }, media: room.media, members: members(), recentChat: room.chat },
      serverTime: Date.now(),
      mediaToken: 'mock-token',
      gifSearchAvailable: true,
      vlc: { connected: false, following: room.following },
    });
    if (mode === 'host' && !local) sendTo(ws, { type: 'error', code: 'not_host', message: 'Not a local connection; joined as guest' });
    broadcast({ type: 'presence', members: members() }, ws);
    systemLine(`${nick} joined`);
    return;
  }

  switch (msg?.type) {
    case 'ping':
      return sendTo(ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
    case 'control': {
      if (!room.state.mediaId) return sendTo(ws, { type: 'error', code: 'bad_message', message: 'No media' });
      const pos = positionNow();
      switch (msg.action) {
        case 'play':
          return setState({ playing: true, position: pos });
        case 'pause':
          return setState({ playing: false, position: pos });
        case 'toggle':
          return setState({ playing: !room.state.playing, position: pos });
        case 'seek': {
          const to = Math.min(Math.max(0, Number(msg.position) || 0), room.media?.durationSec ?? Infinity);
          return setState({ position: to });
        }
        default:
          return sendTo(ws, { type: 'error', code: 'bad_message', message: 'Unknown action' });
      }
    }
    case 'chat': {
      if (msg.kind === 'gif') {
        let host = '';
        try {
          host = new URL(msg.gif?.url ?? '').hostname;
        } catch {
          host = '';
        }
        if (!/(^|\.)(giphy\.com|klipy\.com|tenor\.com)$/.test(host)) return sendTo(ws, { type: 'error', code: 'bad_message', message: 'GIF must come from a known provider' });
      }
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 2000) : undefined;
      if (msg.kind === 'text' && !text) return sendTo(ws, { type: 'error', code: 'bad_message', message: 'Empty message' });
      const message = { id: randomUUID(), from: { id: me.id, nick: me.nick }, kind: msg.kind, text, gif: msg.kind === 'gif' ? msg.gif : undefined, at: Date.now() };
      room.chat.push(message);
      room.chat = room.chat.slice(-200);
      return broadcast({ type: 'chat', message });
    }
    case 'typing':
      me.typing = !!msg.on;
      return broadcast({ type: 'presence', members: members() });
    case 'nick': {
      const nick = String(msg.nick ?? '').trim().slice(0, 24);
      if (!nick || nick === me.nick) return;
      const old = me.nick;
      me.nick = nick;
      broadcast({ type: 'presence', members: members() });
      return systemLine(`${old} is now ${nick}`);
    }
    case 'reaction': {
      if (!['cheer', 'boo', 'heart'].includes(msg.kind)) return sendTo(ws, { type: 'error', code: 'bad_message', message: 'Unknown reaction' });
      const now = Date.now();
      if (now - (room.lastReactionAt.get(me.id) ?? 0) < REACTION_MIN_GAP_MS) return; // silently dropped
      room.lastReactionAt.set(me.id, now);
      return broadcast({ type: 'reaction', kind: msg.kind, from: { id: me.id, nick: me.nick }, at: now });
    }
    case 'select_media':
      if (!me.isHost) return sendTo(ws, { type: 'error', code: 'not_host', message: 'Host only' });
      return selectMedia(msg.mediaId, ws);
    case 'open_in_vlc':
      if (!me.isHost) return sendTo(ws, { type: 'error', code: 'not_host', message: 'Host only' });
      return sendTo(ws, { type: 'error', code: 'vlc_unreachable', message: 'The mock host has no VLC' });
    case 'follow_vlc':
      if (!me.isHost) return sendTo(ws, { type: 'error', code: 'not_host', message: 'Host only' });
      room.following = !!msg.on;
      return broadcast({ type: 'vlc', connected: false, following: room.following });
    default:
      return sendTo(ws, { type: 'error', code: 'bad_message', message: `Unknown type ${String(msg?.type)}` });
  }
}

// ---------------------------------------------------------------- HTTP
const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function serveFile(req, res, file, cacheControl = 'no-store') {
  let st;
  try {
    st = statSync(file);
  } catch {
    return json(res, 404, { error: 'not_found', message: 'No such file' });
  }
  if (!st.isFile()) return json(res, 404, { error: 'not_found', message: 'No such file' });
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'cache-control': cacheControl });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': cacheControl });
  createReadStream(file).pipe(res);
}
function requirePin(req, res) {
  if (req.headers['x-wochit-pin'] !== PIN) {
    json(res, 401, { error: 'bad_pin', message: 'Wrong PIN' });
    return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  if (p === '/api/health') {
    return json(res, 200, {
      ok: true,
      version: 'mock',
      protocol: PROTOCOL_VERSION,
      source: room.state.source,
      vlc: { connected: false },
      ffmpeg: { found: true, encoder: 'libx264 (mock)' },
      gifSearchAvailable: true,
    });
  }
  if (p === '/api/library') {
    if (!isLocal(req)) return json(res, 403, { error: 'not_host', message: 'Library is host-only' });
    if (!requirePin(req, res)) return;
    const parent = url.searchParams.get('parent') || null;
    const entries = LIBRARY[parent ?? 'null'];
    if (!entries) return json(res, 404, { error: 'unknown_media', message: 'No such folder' });
    return json(res, 200, { parentId: parent, entries });
  }
  if (p === '/api/gif/search' || p === '/api/gif/featured') {
    if (!requirePin(req, res)) return;
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const results = q ? GIFS.filter((g) => g.title.includes(q)) : GIFS;
    return json(res, 200, { provider: 'klipy', results, next: null });
  }
  if (p.startsWith('/media/mock/')) {
    const rel = normalize(p.slice('/media/mock/'.length)).replace(/^(\.\.[/\\])+/, '');
    const file = resolve(FIXTURES, rel);
    if (!file.startsWith(resolve(FIXTURES))) return json(res, 403, { error: 'bad_message', message: 'Nope' });
    return serveFile(req, res, file, rel.endsWith('.ts') ? 'private, max-age=31536000' : 'no-store');
  }
  if (p === '/debug/state') {
    return json(res, 200, { state: room.state, position: positionNow(), serverTime: Date.now(), media: room.media?.id ?? null, members: members(), chat: room.chat.length });
  }
  if (p === '/debug/reset') {
    room.state = freshState();
    room.media = null;
    room.chat = [];
    room.following = true;
    broadcast({ type: 'media', media: null });
    broadcast({ type: 'state', state: room.state });
    return json(res, 200, { ok: true });
  }
  if (p.startsWith('/api/')) return json(res, 404, { error: 'not_found', message: 'Unknown API' });

  // Static web/dist with SPA fallback, when built.
  if (existsSync(DIST)) {
    const rel = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(DIST, rel === '/' || rel === '\\' ? 'index.html' : rel.replace(/^[/\\]/, ''));
    if (!file.startsWith(resolve(DIST))) file = join(DIST, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) file = join(DIST, 'index.html');
    return serveFile(req, res, file, file.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('WochIt mock host. Build web/dist or run vite dev with its proxy.');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  ws.helloTimer = setTimeout(() => ws.close(4000, 'no hello'), 5000);
  ws.on('message', (raw) => handleMessage(ws, req, raw));
  ws.on('close', () => {
    clearTimeout(ws.helloTimer);
    const me = room.clients.get(ws);
    if (!me) return;
    room.clients.delete(ws);
    broadcast({ type: 'presence', members: members() });
    systemLine(`${me.nick} left`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] WochIt mock host on http://127.0.0.1:${PORT}  pin ${PIN}  source browser`);
  console.log(`[mock] fixtures ${FIXTURES}${existsSync(DIST) ? `  serving ${DIST}` : ''}`);
});

const shutdown = () => {
  for (const ws of room.clients.keys()) ws.close(1001, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
