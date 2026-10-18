// WebSocket transport at /ws on the shared HTTP server. Enforces the connect handshake
// (hello within 5 s, PIN, protocol version, rate limit), validates every frame with C2S.safeParse,
// and hands validated messages to the room. docs/PROTOCOL.md § Connect / § Close codes.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { C2S, PROTOCOL_VERSION, type ErrorCode, type S2C } from '@wochit/shared';
import type { Logger } from '../media/index.js';
import { FailureLimiter, pinMatches } from '../auth.js';
import { clientAddress, isLocalAddress } from '../net/hostDetect.js';
import type { Connection, Room } from '../room/room.js';
import { DEFAULT_CORS_ORIGINS, classifyOrigin } from './cors.js';
import { decorateS2C } from './mediaToken.js';

export const CLOSE_NO_HELLO = 4000;
export const CLOSE_BAD_PIN = 4001;
export const CLOSE_BAD_VERSION = 4002;
export const CLOSE_RATE_LIMITED = 4003;
export const CLOSE_GOING_AWAY = 1001;

export interface WsOptions {
  server: HttpServer;
  room: Room;
  pin: string;
  mediaToken: string;
  limiter: FailureLimiter;
  ownAddrs: Iterable<string>;
  extraAddrs?: Iterable<string>;
  log: Logger;
  /** Default 5000. */
  helloTimeoutMs?: number;
  /** Frames allowed per connection per `floodWindowMs` after hello. Default 200 / 5000. */
  floodLimit?: number;
  floodWindowMs?: number;
  /** Socket keepalive ping interval; 0 disables. Default 30 000. */
  keepaliveMs?: number;
  path?: string;
  /** Origins accepted cross-origin; same-origin and absent Origin are always accepted. */
  corsOrigins?: Iterable<string>;
}

export interface WsHandle {
  wss: WebSocketServer;
  /** Number of open sockets (joined or not). */
  readonly size: number;
  /** Close every client with the given code and stop accepting. */
  closeAll(code?: number, reason?: string): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function attachWebSocket(opts: WsOptions): WsHandle {
  const log = opts.log;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const floodLimit = opts.floodLimit ?? 200;
  const floodWindowMs = opts.floodWindowMs ?? 5000;
  const keepaliveMs = opts.keepaliveMs ?? 30_000;
  const ownAddrs = [...opts.ownAddrs];
  const extraAddrs = [...(opts.extraAddrs ?? [])];
  const corsOrigins = [...(opts.corsOrigins ?? DEFAULT_CORS_ORIGINS)];

  const wss = new WebSocketServer({ server: opts.server, path: opts.path ?? '/ws', maxPayload: 64 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remote = req.socket.remoteAddress;
    const xff = req.headers['x-forwarded-for'];
    const addr = clientAddress(remote, xff) ?? 'unknown';
    const isLocal = isLocalAddress(remote, xff, ownAddrs, extraAddrs);
    const tailscaleUser = req.headers['tailscale-user-login'];

    let joined = false;
    let closed = false;
    const floodTimes: number[] = [];
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    const conn: Connection = {
      send(msg: S2C) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(decorateS2C(msg, opts.mediaToken)));
      },
    };
    const sendError = (code: ErrorCode, message: string): void => conn.send({ type: 'error', code, message });
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    };

    const helloTimer = setTimeout(() => {
      if (!joined) {
        log.debug('ws %s: no hello within %d ms', addr, helloTimeoutMs);
        close(CLOSE_NO_HELLO, 'hello timeout');
      }
    }, helloTimeoutMs);
    helloTimer.unref?.();

    if (classifyOrigin(req.headers.origin, req.headers.host, corsOrigins) === 'denied') {
      log.warn('ws %s: origin %s not allowed', addr, req.headers.origin);
      clearTimeout(helloTimer);
      close(CLOSE_RATE_LIMITED, 'origin not allowed');
      return;
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        sendError('bad_message', 'binary frames are not accepted');
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        sendError('bad_message', 'frame is not JSON');
        return;
      }

      if (!joined) {
        if (!isRecord(raw) || raw.type !== 'hello') {
          sendError('bad_message', 'the first message must be hello');
          return;
        }
        if (raw.v !== PROTOCOL_VERSION) {
          sendError('bad_message', `protocol version ${String(raw.v)} is not supported (host speaks v${PROTOCOL_VERSION})`);
          close(CLOSE_BAD_VERSION, 'protocol version mismatch');
          return;
        }
        const parsed = C2S.safeParse(raw);
        if (!parsed.success || parsed.data.type !== 'hello') {
          sendError('bad_message', 'malformed hello');
          return;
        }
        if (opts.limiter.isBlocked(addr)) {
          sendError('rate_limited', 'too many wrong PINs; wait a minute');
          close(CLOSE_RATE_LIMITED, 'rate limited');
          return;
        }
        if (!pinMatches(parsed.data.pin, opts.pin)) {
          const blocked = opts.limiter.recordFailure(addr);
          log.warn('ws %s: wrong PIN%s', addr, blocked ? ' (now rate limited)' : '');
          sendError('bad_pin', 'wrong PIN');
          close(CLOSE_BAD_PIN, 'bad pin');
          return;
        }
        joined = true;
        clearTimeout(helloTimer);
        opts.limiter.reset(addr);
        if (typeof tailscaleUser === 'string' && tailscaleUser) log.debug('ws %s: tailscale user %s', addr, tailscaleUser);
        opts.room.join({ conn, clientId: parsed.data.clientId, nick: parsed.data.nick, mode: parsed.data.mode, isLocal });
        return;
      }

      const now = Date.now();
      floodTimes.push(now);
      while (floodTimes.length && floodTimes[0]! < now - floodWindowMs) floodTimes.shift();
      if (floodTimes.length > floodLimit) {
        log.warn('ws %s: flooding, closing', addr);
        sendError('rate_limited', 'too many messages');
        close(CLOSE_RATE_LIMITED, 'rate limited');
        return;
      }

      const parsed = C2S.safeParse(raw);
      if (!parsed.success) {
        sendError('bad_message', summarizeIssues(parsed.error.issues));
        return;
      }
      opts.room.handle(conn, parsed.data);
    });

    ws.on('close', () => {
      closed = true;
      clearTimeout(helloTimer);
      if (joined) opts.room.leave(conn);
    });
    ws.on('error', (err) => log.debug('ws %s error: %s', addr, err.message));
  });

  let keepalive: NodeJS.Timeout | null = null;
  if (keepaliveMs > 0) {
    keepalive = setInterval(() => {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, keepaliveMs);
    keepalive.unref?.();
  }

  wss.on('error', (err) => log.error('websocket server error: %s', err.message));

  return {
    wss,
    get size() {
      return wss.clients.size;
    },
    closeAll(code = CLOSE_GOING_AWAY, reason = 'host shutting down') {
      if (keepalive) clearInterval(keepalive);
      for (const ws of wss.clients) {
        try {
          ws.close(code, reason);
        } catch {
          ws.terminate();
        }
      }
      return new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
          resolve();
        }, 1000);
        force.unref?.();
        wss.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
    },
  };
}

function summarizeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const first = issues[0];
  if (!first) return 'invalid message';
  const where = first.path.map(String).join('.');
  return where ? `${where}: ${first.message}` : first.message;
}
