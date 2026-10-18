// Cross-origin policy shared by the HTTP routes and the WebSocket upgrade. The web bundle is also
// served from Vercel (https://wochit.vercel.app) and talks to the host cross-origin from there;
// everything else is same-origin (served by the host itself or through tailscale serve).
import type { NextFunction, Request, Response } from 'express';

export const DEFAULT_CORS_ORIGINS: readonly string[] = ['https://wochit.vercel.app'];

export type OriginVerdict = 'same' | 'allowed' | 'denied';

/** `https://Example.com/` → `https://example.com`; a bare host gets `https://`. Null when unparsable. */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Comma/semicolon/whitespace separated list; `none`/`off` → empty; unset → the default. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_CORS_ORIGINS];
  const parts = raw
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 1 && /^(none|off|-)$/i.test(parts[0]!)) return [];
  const out: string[] = [];
  for (const p of parts) {
    const n = normalizeOrigin(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Same-origin when the Origin's host equals the request's Host header (scheme ignored: behind
 * tailscale serve the browser says https while we see http). Otherwise allowed only when listed.
 */
export function classifyOrigin(origin: string | undefined, hostHeader: string | undefined, allow: Iterable<string>): OriginVerdict {
  if (!origin) return 'same';
  const n = normalizeOrigin(origin);
  if (!n) return 'denied';
  const originHost = n.slice(n.indexOf('//') + 2);
  if (hostHeader && originHost === hostHeader.trim().toLowerCase()) return 'same';
  for (const a of allow) if (normalizeOrigin(a) === n) return 'allowed';
  return 'denied';
}

export const CORS_ALLOW_HEADERS = 'x-wochit-pin, range';
export const CORS_EXPOSE_HEADERS = 'content-length, content-range, accept-ranges';

/** Express middleware for /api and /media: reflect allowed origins, answer preflights, 403 denied preflights. */
export function corsMiddleware(allow: Iterable<string>, onDenied: (req: Request) => Error) {
  const list = [...allow];
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const verdict = classifyOrigin(origin, req.headers.host, list);
    if (verdict === 'same') return next();
    if (verdict === 'denied') {
      if (req.method === 'OPTIONS') return next(onDenied(req));
      return next();
    }
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.append('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    // Chrome's Private/Local Network Access: a public page (the Vercel connect page) reaching a
    // tailnet address. Newer Chrome asks the user for permission; older Chrome requires this
    // preflight opt-in. Harmless for everyone else.
    if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
