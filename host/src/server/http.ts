// The express 5 app: health, host-only library, GIF proxy (Klipy/GIPHY), tokenised HLS media
// routes, and the built web app with an SPA fallback. docs/PROTOCOL.md § REST.
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  HostSettingsPatch,
  PROTOCOL_VERSION,
  RenditionId,
  type ErrorCode,
  type GifSearchResponse,
  type HealthResponse,
  type HostSettingsResponse,
  type LibraryResponse,
  type ShutdownResponse,
} from '@wochit/shared';
import { MediaError, type Logger, type MediaService } from '../media/index.js';
import { FailureLimiter, pinMatches, safeEqual } from '../auth.js';
import { GifError, type GifService } from '../gif/index.js';
import { clientAddress, isLocalAddress } from '../net/hostDetect.js';
import type { TailnetStatus } from '../net/tailscale.js';
import type { Room } from '../room/room.js';
import { upsertEnvValues } from '../settings/envFile.js';
import type { VlcBridgeLike } from '../vlc/bridge.js';
import { DEFAULT_CORS_ORIGINS, corsMiddleware } from './cors.js';

export interface HttpOptions {
  media: MediaService;
  room: Room;
  bridge: VlcBridgeLike;
  gif: GifService;
  log: Logger;
  pin: string;
  mediaToken: string;
  limiter: FailureLimiter;
  ownAddrs: Iterable<string>;
  extraAddrs?: Iterable<string>;
  webDir: string;
  version: string;
  /** Origins allowed cross-origin (the Vercel copy of the web app). */
  corsOrigins?: Iterable<string>;
  /** The URLs the banner prints; reported in /api/health so the web app can show them. */
  urls?: () => string[];
  /** The `.env` file `PATCH /api/host/settings` writes (Config.envPath). */
  envPath: string;
  /** Initial Tailscale share link (Config.tailscaleShareLink); a PATCH replaces it in memory and in `.env`. */
  tailscaleShareLink: string | null;
  /** Cached `tailscale serve` check; null (field omitted from health) when unknown or no CLI. */
  tailnet?: () => TailnetStatus | null;
  /** Called once the `POST /api/host/shutdown` response has gone out; index.ts wires the graceful shutdown. */
  onShutdownRequest?: () => void;
}

export const CONTENT_TYPE_M3U8 = 'application/vnd.apple.mpegurl';
export const CONTENT_TYPE_TS = 'video/mp2t';
export const CONTENT_TYPE_VTT = 'text/vtt; charset=utf-8';
export const CONTENT_TYPE_JPEG = 'image/jpeg';

const IMMUTABLE = 'private, max-age=31536000';
const NO_STORE = 'no-store';
const NO_CACHE = 'no-cache';

const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEGMENT_RE = /^seg(\d{5})\.ts$/;
const VTT_RE = /^(.+)\.vtt$/;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function sendJsonError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).setHeader('Cache-Control', NO_STORE);
  res.json({ error: code, message });
}

/** MediaError → HTTP status + wire error code. */
export function mapMediaError(err: MediaError): { status: number; code: ErrorCode } {
  switch (err.code) {
    case 'unknown_media':
    case 'unknown_rendition':
    case 'not_found':
      return { status: 404, code: 'unknown_media' };
    case 'timeout':
      return { status: 408, code: 'transcode_failed' };
    case 'transcode_failed':
    case 'unsupported':
      return { status: 500, code: 'transcode_failed' };
    default:
      return { status: 500, code: 'server_error' };
  }
}

function queryString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

export function createApp(opts: HttpOptions): express.Express {
  const { media, room, bridge, gif, log, limiter } = opts;
  const ownAddrs = [...opts.ownAddrs];
  const extraAddrs = [...(opts.extraAddrs ?? [])];

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const addrOf = (req: Request): string => clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']) ?? 'unknown';

  const requirePin = (req: Request, _res: Response, next: NextFunction): void => {
    const addr = addrOf(req);
    if (limiter.isBlocked(addr)) return next(new HttpError(429, 'rate_limited', 'too many wrong PINs; wait a minute'));
    const header = req.header('x-wochit-pin');
    if (!pinMatches(header, opts.pin)) {
      limiter.recordFailure(addr);
      return next(new HttpError(401, 'bad_pin', 'missing or wrong x-wochit-pin header'));
    }
    next();
  };

  const requireLocal = (req: Request, _res: Response, next: NextFunction): void => {
    if (!isLocalAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], ownAddrs, extraAddrs)) {
      return next(new HttpError(403, 'not_host', 'this endpoint is only available from the host PC'));
    }
    next();
  };

  const requireToken = (req: Request, _res: Response, next: NextFunction): void => {
    const t = queryString(req.query.t);
    if (typeof t !== 'string' || !safeEqual(t, opts.mediaToken)) {
      return next(new HttpError(401, 'bad_pin', 'missing or invalid media token (?t=)'));
    }
    next();
  };

  const mediaId = (req: Request): string => {
    const id = req.params.id;
    if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) throw new HttpError(404, 'unknown_media', 'bad media id');
    return id;
  };

  const rendition = (req: Request): RenditionId => {
    const r = RenditionId.safeParse(req.params.rendition);
    if (!r.success) throw new HttpError(404, 'unknown_media', 'unknown rendition');
    return r.data;
  };

  // ---------------------------------------------------------------- CORS (/api, /media)

  const cors = corsMiddleware(opts.corsOrigins ?? DEFAULT_CORS_ORIGINS, () => new HttpError(403, 'bad_message', 'origin not allowed'));
  app.use('/api', cors);
  app.use('/media', cors);

  // ---------------------------------------------------------------- /api

  const healthCors = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  };
  app.options('/api/health', healthCors, (_req, res) => {
    res.status(204).end();
  });
  app.get('/api/health', healthCors, (_req, res) => {
    const stats = media.stats();
    const body: HealthResponse = {
      ok: true,
      version: opts.version,
      protocol: PROTOCOL_VERSION,
      source: room.getState().source,
      vlc: { connected: bridge.connected, following: room.vlcInfo().following },
      ffmpeg: { found: media.ffmpegFound, encoder: media.encoder },
      gifSearchAvailable: gif.available,
      gifProvider: gif.provider,
      cache: { usedBytes: stats.cacheBytes, maxBytes: stats.cacheMaxBytes },
      urls: opts.urls?.() ?? [],
      members: room.memberCounts(),
    };
    const tailnet = opts.tailnet?.() ?? null;
    if (tailnet) body.tailnet = tailnet;
    res.setHeader('Cache-Control', NO_STORE);
    res.json(body);
  });

  app.get('/api/library', requirePin, requireLocal, async (req, res) => {
    const parent = queryString(req.query.parent);
    const body: LibraryResponse = await media.browse(parent ? parent : null);
    res.setHeader('Cache-Control', NO_STORE);
    res.json(body);
  });

  // ---------------------------------------------------------------- /api/host (loopback + PIN, like /api/library)

  // Host-only route, so the full link is returned; it is never written to the log.
  let tailscaleShareLink: string | null = opts.tailscaleShareLink;
  const settingsBody = (): HostSettingsResponse => ({ gifSearchAvailable: gif.available, gifProvider: gif.provider, keys: gif.keys, tailscaleShareLink });

  app.get('/api/host/settings', requirePin, requireLocal, (_req, res) => {
    res.setHeader('Cache-Control', NO_STORE);
    res.json(settingsBody());
  });

  const jsonBody = express.json({ limit: '16kb', strict: true });
  app.patch('/api/host/settings', requirePin, requireLocal, jsonBody, async (req, res) => {
    const parsed = HostSettingsPatch.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.map(String).join('.');
      throw new HttpError(400, 'bad_message', `invalid settings${where ? ` (${where})` : ''}: ${first?.message ?? 'bad body'}`);
    }
    const patch = parsed.data;
    const values: Record<string, string> = {};
    if (patch.klipyApiKey !== undefined) values.KLIPY_API_KEY = patch.klipyApiKey;
    if (patch.giphyApiKey !== undefined) values.GIPHY_API_KEY = patch.giphyApiKey;
    if (patch.tailscaleShareLink !== undefined) values.WOCHIT_TS_SHARE_LINK = patch.tailscaleShareLink;
    if (Object.keys(values).length) {
      // Persist first: if the file cannot be written the running config must not drift from it.
      await upsertEnvValues(opts.envPath, values);
      if (patch.klipyApiKey !== undefined || patch.giphyApiKey !== undefined) {
        gif.reconfigure({ klipyKey: patch.klipyApiKey, giphyKey: patch.giphyApiKey });
        room.setGifSearchAvailable(gif.available);
        log.info('GIF search reconfigured: %s', gif.provider ?? 'off');
      }
      if (patch.tailscaleShareLink !== undefined) {
        tailscaleShareLink = patch.tailscaleShareLink || null;
        log.info('Tailscale share link %s', tailscaleShareLink ? 'set' : 'cleared');
      }
    }
    res.setHeader('Cache-Control', NO_STORE);
    res.json(settingsBody());
  });

  app.post('/api/host/shutdown', requirePin, requireLocal, (_req, res) => {
    const body: ShutdownResponse = { ok: true, message: 'Host is shutting down' };
    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      try {
        opts.onShutdownRequest?.();
      } catch (err) {
        log.error('shutdown request handler failed: %s', err instanceof Error ? err.message : String(err));
      }
    };
    // Only once the answer has left the process, so the console sees the confirmation.
    res.once('finish', fire);
    res.once('close', fire);
    res.setHeader('Cache-Control', NO_STORE);
    res.json(body);
  });

  const gifGuard = (_req: Request, _res: Response, next: NextFunction): void => {
    if (!gif.available) return next(new HttpError(500, 'server_error', 'GIF search is not configured (set KLIPY_API_KEY or GIPHY_API_KEY)'));
    next();
  };
  const pageOf = (req: Request): { pos: string | undefined; limit: number | undefined } => {
    const limitRaw = queryString(req.query.limit);
    return { pos: queryString(req.query.pos), limit: limitRaw === undefined ? undefined : Number(limitRaw) };
  };
  app.get('/api/gif/search', requirePin, gifGuard, async (req, res) => {
    const q = queryString(req.query.q)?.trim();
    if (!q) throw new HttpError(400, 'bad_message', 'q is required');
    const body: GifSearchResponse = await gif.search(q, pageOf(req));
    res.setHeader('Cache-Control', NO_STORE);
    res.json(body);
  });
  app.get('/api/gif/featured', requirePin, gifGuard, async (req, res) => {
    const body: GifSearchResponse = await gif.featured(pageOf(req));
    res.setHeader('Cache-Control', NO_STORE);
    res.json(body);
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'bad_message', 'unknown API route')));

  // ---------------------------------------------------------------- /media

  const tokenQuery = `?t=${encodeURIComponent(opts.mediaToken)}`;

  const sendFile = (res: Response, absPath: string, contentType: string, cacheControl: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      res.sendFile(
        absPath,
        {
          cacheControl: false,
          etag: false,
          lastModified: false,
          acceptRanges: true,
          dotfiles: 'allow',
          headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl },
        },
        (err?: unknown) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

  app.get('/media/:id/master.m3u8', requireToken, async (req, res) => {
    const text = await media.masterPlaylist(mediaId(req), tokenQuery);
    res.setHeader('Content-Type', CONTENT_TYPE_M3U8);
    res.setHeader('Cache-Control', NO_STORE);
    res.send(text);
  });

  app.get('/media/:id/poster.jpg', requireToken, async (req, res) => {
    const file = await media.getPoster(mediaId(req));
    if (!file) throw new HttpError(404, 'unknown_media', 'no poster for this media');
    await sendFile(res, file, CONTENT_TYPE_JPEG, IMMUTABLE);
  });

  app.get('/media/:id/subs/:file', requireToken, async (req, res) => {
    const m = VTT_RE.exec(typeof req.params.file === 'string' ? req.params.file : '');
    if (!m?.[1]) throw new HttpError(404, 'unknown_media', 'subtitle not found');
    const file = await media.getSubtitle(mediaId(req), decodeURIComponent(m[1]));
    await sendFile(res, file, CONTENT_TYPE_VTT, IMMUTABLE);
  });

  app.get('/media/:id/:rendition/index.m3u8', requireToken, async (req, res) => {
    const text = await media.mediaPlaylist(mediaId(req), rendition(req), tokenQuery);
    res.setHeader('Content-Type', CONTENT_TYPE_M3U8);
    res.setHeader('Cache-Control', NO_STORE);
    res.send(text);
  });

  app.get('/media/:id/:rendition/:segment', requireToken, async (req, res) => {
    const m = SEGMENT_RE.exec(typeof req.params.segment === 'string' ? req.params.segment : '');
    if (!m?.[1]) throw new HttpError(404, 'unknown_media', 'segment not found');
    const file = await media.getSegment(mediaId(req), rendition(req), Number.parseInt(m[1], 10));
    await sendFile(res, file, CONTENT_TYPE_TS, IMMUTABLE);
  });

  app.use('/media', (_req, _res, next) => next(new HttpError(404, 'unknown_media', 'unknown media route')));

  // ---------------------------------------------------------------- web app

  const webDir = path.resolve(opts.webDir);
  const indexHtml = path.join(webDir, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(
      express.static(webDir, {
        index: false,
        etag: true,
        lastModified: true,
        fallthrough: true,
        setHeaders(res, filePath) {
          const rel = path.relative(webDir, filePath).split(/[\\/]/);
          res.setHeader('Cache-Control', rel[0] === 'assets' ? 'public, max-age=31536000, immutable' : NO_CACHE);
        },
      }),
    );
    app.get('/{*splat}', (req, res, next) => {
      if (req.method !== 'GET') return next();
      // A hashed asset that no longer exists, or any URL that looks like a file, must not get HTML.
      if (req.path.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(req.path)) return next();
      if (!req.accepts('html')) return next();
      res.setHeader('Cache-Control', NO_CACHE);
      res.sendFile(indexHtml, { cacheControl: false, etag: false, lastModified: false }, (err?: unknown) => {
        if (err) next(err);
      });
    });
    app.use((_req, _res, next) => next(new HttpError(404, 'bad_message', 'not found')));
  } else {
    log.warn('web app not found at %s — run `pnpm --filter @wochit/web build`; serving a placeholder', webDir);
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', NO_CACHE);
      res
        .status(200)
        .type('html')
        .send('<!doctype html><title>WochIt</title><p>WochIt host is running, but the web app is not built. Run <code>pnpm --filter @wochit/web build</code>.</p>');
    });
  }

  // ---------------------------------------------------------------- errors

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      sendJsonError(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof MediaError) {
      const { status, code } = mapMediaError(err);
      if (status >= 500) log.warn('%s %s → %s: %s', req.method, req.path, err.code, err.message);
      sendJsonError(res, status, code, err.message);
      return;
    }
    if (err instanceof GifError) {
      if (err.status === 429) sendJsonError(res, 429, 'rate_limited', 'the GIF provider is rate limiting us; try again in a minute');
      else sendJsonError(res, 500, 'server_error', err.message);
      return;
    }
    const e = err as { status?: unknown; statusCode?: unknown; message?: unknown; code?: unknown };
    const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (e.code === 'ENOENT') {
      sendJsonError(res, 404, 'unknown_media', 'file not found');
      return;
    }
    const message = typeof e.message === 'string' ? e.message : 'internal error';
    if (status >= 500) log.error('%s %s failed: %s', req.method, req.path, message);
    sendJsonError(res, status, status >= 500 ? 'server_error' : 'bad_message', message);
  });

  return app;
}
