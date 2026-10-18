// Client for the host's GIF proxy (docs/PROTOCOL.md § REST: /api/gif/featured, /api/gif/search).
// The browser never talks to the provider (Klipy or GIPHY) directly: the host holds the key and
// normalises results to the shared `Gif` shape.
import { GifSearchResponse } from '@wochit/shared';

export const GIF_PAGE_SIZE = 24;
export const PIN_STORAGE_KEY = 'wochit.pin';

// Testing-mode Klipy keys (and GIPHY beta keys) allow 100 requests an hour, so the client is
// frugal: debounce 400 ms, search only from 2 characters, never refetch a page within 5 minutes.
export const SEARCH_DEBOUNCE_MS = 400;
export const MIN_QUERY_CHARS = 2;
export const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 80;
export const RESTING_TEXT = 'GIF search is resting for a minute';

export type GifProvider = GifSearchResponse['provider'];
export type GifErrorKind = 'unauthorized' | 'unavailable' | 'rate_limited' | 'network' | 'bad_response';

export class GifApiError extends Error {
  constructor(
    readonly kind: GifErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'GifApiError';
  }
}

export interface GifRequest {
  /** Empty or whitespace → featured. */
  q: string;
  /** Opaque cursor from a previous response's `next`. */
  pos?: string | null;
  limit?: number;
  /** Host origin when the page is not served by the host (Vercel, Vite without proxy). */
  origin?: string | null;
  /** Room PIN for `x-wochit-pin`; falls back to localStorage['wochit.pin']. */
  pin?: string | null;
  signal?: AbortSignal;
}

function readPin(): string | null {
  try {
    return globalThis.localStorage?.getItem(PIN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The query actually sent: trimmed, or '' (Featured) when shorter than 2 characters. */
export function effectiveQuery(raw: string): string {
  const q = raw.trim();
  return q.length >= MIN_QUERY_CHARS ? q : '';
}

/** Builds `/api/gif/featured?…` or `/api/gif/search?q=…` against the host origin. */
export function gifUrl({ q, pos, limit = GIF_PAGE_SIZE, origin }: Omit<GifRequest, 'signal'>): string {
  const base = origin ?? globalThis.location?.origin ?? 'http://localhost';
  const query = q.trim();
  const url = new URL(query ? '/api/gif/search' : '/api/gif/featured', base);
  if (query) url.searchParams.set('q', query);
  if (pos) url.searchParams.set('pos', pos);
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

function kindForStatus(status: number): GifErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

/** Fetches one page. Throws GifApiError (or the AbortError from `signal`). */
export async function fetchGifs(req: GifRequest): Promise<GifSearchResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const pin = req.pin ?? readPin();
  if (pin) headers['x-wochit-pin'] = pin;

  let res: Response;
  try {
    res = await fetch(gifUrl(req), { headers, signal: req.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new GifApiError('network', null, 'Could not reach the host.');
  }
  if (!res.ok) {
    throw new GifApiError(kindForStatus(res.status), res.status, `GIF request failed (${res.status}).`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GifApiError('bad_response', res.status, 'The host sent something that is not JSON.');
  }
  const parsed = GifSearchResponse.safeParse(body);
  if (!parsed.success) throw new GifApiError('bad_response', res.status, 'Unexpected GIF response shape.');
  return parsed.data;
}

const cache = new Map<string, { at: number; data: GifSearchResponse }>();
const inflight = new Map<string, Promise<GifSearchResponse>>();

/**
 * fetchGifs behind a 5-minute cache keyed by URL (origin + query + page), with concurrent
 * requests for one page shared. No AbortSignal on purpose: a request already sent has already
 * cost quota, so its answer is cached even if the panel moved on; callers just ignore it.
 */
export function fetchGifsCached(req: Omit<GifRequest, 'signal'>): Promise<GifSearchResponse> {
  const key = gifUrl(req);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.data);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetchGifs(req)
    .then((data) => {
      cache.delete(key);
      cache.set(key, { at: Date.now(), data });
      while (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function clearGifCache(): void {
  cache.clear();
  inflight.clear();
}

/** HTTP 429 from the proxy: the provider quota is spent for now. */
export function isResting(err: unknown): boolean {
  return err instanceof GifApiError && err.kind === 'rate_limited';
}

/**
 * Attribution per provider. Klipy (https://docs.klipy.com/attribution, checked 2026-10-18):
 * "Search KLIPY" as the search placeholder is REQUIRED; a "Powered by KLIPY" mark where results
 * show is optional (shown). GIPHY requires its "Powered by GIPHY" mark where results show.
 */
export const ATTRIBUTION: Record<GifProvider, { placeholder: string; poweredBy: string; href: string }> = {
  klipy: { placeholder: 'Search KLIPY', poweredBy: 'Powered by KLIPY', href: 'https://klipy.com' },
  giphy: { placeholder: 'Search GIPHY', poweredBy: 'Powered by GIPHY', href: 'https://giphy.com' },
};

/** Until the host has answered once the provider is unknown. */
export const NEUTRAL_PLACEHOLDER = 'Search GIFs';

export function searchPlaceholder(provider: GifProvider | null): string {
  return provider ? ATTRIBUTION[provider].placeholder : NEUTRAL_PLACEHOLDER;
}

export function poweredBy(provider: GifProvider | null): string {
  return provider ? ATTRIBUTION[provider].poweredBy : '';
}

export function gifErrorText(err: unknown): string {
  if (err instanceof GifApiError) {
    switch (err.kind) {
      case 'unauthorized':
        return 'The host did not accept the PIN. Rejoin and try again.';
      case 'rate_limited':
        return RESTING_TEXT;
      case 'network':
        return 'Could not reach the host.';
      case 'bad_response':
        return 'The host sent an unexpected GIF response.';
      case 'unavailable':
        return 'GIF search is not responding right now.';
    }
  }
  return 'Something went wrong loading GIFs.';
}
