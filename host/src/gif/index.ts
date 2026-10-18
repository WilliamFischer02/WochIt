// The one GIF seam the server uses: provider selection, caching, and the chat URL allowlist.
// Tenor is gone (Google shut the API down on 2026-06-30), so the choice is Klipy or GIPHY.
import type { GifSearchResponse } from '@wochit/shared';
import { GIPHY_CDN_HOSTS, createGiphyProvider } from './giphy.js';
import { KLIPY_CDN_HOSTS, createKlipyProvider } from './klipy.js';
import { GifError, type GifPage, type GifProvider, type GifProviderName } from './provider.js';

export { GifError } from './provider.js';
export type { GifPage, GifProvider, GifProviderName } from './provider.js';

export type GifProviderChoice = 'auto' | GifProviderName;

export interface GifService {
  /** False when no usable key is configured; then search/featured reject with GifError. */
  readonly available: boolean;
  readonly provider: GifProviderName | null;
  search(q: string, page?: GifPage): Promise<GifSearchResponse>;
  featured(page?: GifPage): Promise<GifSearchResponse>;
}

export interface GifServiceOptions {
  provider: GifProviderChoice;
  klipyKey: string | null | undefined;
  giphyKey: string | null | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Default 10 000. */
  timeoutMs?: number;
  /** Search cache TTL. Default 60 000. */
  cacheTtlMs?: number;
  /** Featured/trending cache TTL (keys in testing mode get ~100 calls/hour). Default 300 000. */
  featuredTtlMs?: number;
  warn?: (msg: string) => void;
}

/** Pick the provider: forced by `provider`, else Klipy if it has a key, else GIPHY. Null when nothing usable. */
export function pickGifProvider(choice: GifProviderChoice, klipyKey: string | null | undefined, giphyKey: string | null | undefined): GifProviderName | null {
  const k = (klipyKey ?? '').trim() !== '';
  const g = (giphyKey ?? '').trim() !== '';
  switch (choice) {
    case 'klipy':
      return k ? 'klipy' : null;
    case 'giphy':
      return g ? 'giphy' : null;
    case 'auto':
      return k ? 'klipy' : g ? 'giphy' : null;
  }
}

export function createGifService(opts: GifServiceOptions): GifService {
  const name = pickGifProvider(opts.provider, opts.klipyKey, opts.giphyKey);
  if (!name) {
    if (opts.provider !== 'auto') opts.warn?.(`WOCHIT_GIF_PROVIDER=${opts.provider} but its API key is empty; GIF search is off`);
    const off = async (): Promise<GifSearchResponse> => {
      throw new GifError('GIF search is not configured (set KLIPY_API_KEY or GIPHY_API_KEY)');
    };
    return { available: false, provider: null, search: off, featured: off };
  }

  const deps = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 10_000 };
  const provider: GifProvider =
    name === 'klipy'
      ? createKlipyProvider({ apiKey: (opts.klipyKey ?? '').trim(), ...deps })
      : createGiphyProvider({ apiKey: (opts.giphyKey ?? '').trim(), ...deps });

  const now = opts.now ?? Date.now;
  const searchTtl = opts.cacheTtlMs ?? 60_000;
  const featuredTtl = opts.featuredTtlMs ?? 300_000;
  const cache = new Map<string, { at: number; ttl: number; value: Promise<GifSearchResponse> }>();

  const cached = (key: string, ttl: number, load: () => Promise<GifSearchResponse>): Promise<GifSearchResponse> => {
    const t = now();
    const hit = cache.get(key);
    if (hit && t - hit.at < hit.ttl) return hit.value;
    const value = load().catch((err: unknown) => {
      cache.delete(key); // do not cache failures
      throw err;
    });
    cache.set(key, { at: t, ttl, value });
    if (cache.size > 500) for (const [k, v] of cache) if (t - v.at >= v.ttl) cache.delete(k);
    return value;
  };

  return {
    available: true,
    provider: name,
    search: (q, page = {}) => {
      const query = q.trim();
      return cached(`${name}|search|${query.toLowerCase()}|${page.pos ?? ''}|${page.limit ?? ''}`, searchTtl, () => provider.search(query, page));
    },
    featured: (page = {}) => cached(`${name}|featured|${page.pos ?? ''}|${page.limit ?? ''}`, featuredTtl, () => provider.featured(page)),
  };
}

// ------------------------------------------------------------------ chat URL allowlist

const EXACT_HOSTS = new Set<string>([...KLIPY_CDN_HOSTS, ...GIPHY_CDN_HOSTS]);

/** The documented CDN hosts, plus any subdomain of klipy.com / giphy.com. */
export function isAllowedGifHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (EXACT_HOSTS.has(h)) return true;
  return h === 'klipy.com' || h.endsWith('.klipy.com') || h === 'giphy.com' || h.endsWith('.giphy.com');
}

/** https only, host on the allowlist. Used for every `gif.url` / `gif.previewUrl` a client sends. */
export function isAllowedGifUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && isAllowedGifHost(u.hostname);
  } catch {
    return false;
  }
}
