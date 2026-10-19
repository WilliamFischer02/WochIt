// The one GIF seam the server uses: provider selection, caching, and the chat URL allowlist.
// Tenor is gone (Google shut the API down on 2026-06-30), so the choice is Klipy or GIPHY.
// Keys can change at runtime (the host console's settings PATCH) via `reconfigure`.
import type { GifSearchResponse } from '@wochit/shared';
import { GIPHY_CDN_HOSTS, createGiphyProvider } from './giphy.js';
import { KLIPY_CDN_HOSTS, createKlipyProvider } from './klipy.js';
import { GifError, type GifPage, type GifProvider, type GifProviderName } from './provider.js';

export { GifError } from './provider.js';
export type { GifPage, GifProvider, GifProviderName } from './provider.js';

export type GifProviderChoice = 'auto' | GifProviderName;

/** Keys to apply at runtime. `undefined` keeps the current key; `null` or '' clears it. */
export interface GifKeys {
  klipyKey?: string | null | undefined;
  giphyKey?: string | null | undefined;
}

export interface GifService {
  /** False when no usable key is configured; then search/featured reject with GifError. */
  readonly available: boolean;
  readonly provider: GifProviderName | null;
  /** Whether a non-empty key is held per provider. Never the key itself. */
  readonly keys: { klipy: boolean; giphy: boolean };
  search(q: string, page?: GifPage): Promise<GifSearchResponse>;
  featured(page?: GifPage): Promise<GifSearchResponse>;
  /** Swap API keys without a restart. Rebuilds the provider and drops the response cache. */
  reconfigure(keys: GifKeys): void;
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

const OFF_MESSAGE = 'GIF search is not configured (set KLIPY_API_KEY or GIPHY_API_KEY)';

export function createGifService(opts: GifServiceOptions): GifService {
  let klipyKey = (opts.klipyKey ?? '').trim();
  let giphyKey = (opts.giphyKey ?? '').trim();
  let name: GifProviderName | null = null;
  let provider: GifProvider | null = null;

  const deps = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 10_000 };
  const now = opts.now ?? Date.now;
  const searchTtl = opts.cacheTtlMs ?? 60_000;
  const featuredTtl = opts.featuredTtlMs ?? 300_000;
  const cache = new Map<string, { at: number; ttl: number; value: Promise<GifSearchResponse> }>();

  const build = (): void => {
    name = pickGifProvider(opts.provider, klipyKey, giphyKey);
    provider = name === null ? null : name === 'klipy' ? createKlipyProvider({ apiKey: klipyKey, ...deps }) : createGiphyProvider({ apiKey: giphyKey, ...deps });
    cache.clear();
  };
  build();
  if (!name && opts.provider !== 'auto') opts.warn?.(`WOCHIT_GIF_PROVIDER=${opts.provider} but its API key is empty; GIF search is off`);

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

  const active = (): { name: GifProviderName; provider: GifProvider } | null => (name && provider ? { name, provider } : null);

  return {
    get available() {
      return name !== null;
    },
    get provider() {
      return name;
    },
    get keys() {
      return { klipy: klipyKey !== '', giphy: giphyKey !== '' };
    },
    search: (q, page = {}) => {
      const a = active();
      if (!a) return Promise.reject(new GifError(OFF_MESSAGE));
      const query = q.trim();
      return cached(`${a.name}|search|${query.toLowerCase()}|${page.pos ?? ''}|${page.limit ?? ''}`, searchTtl, () => a.provider.search(query, page));
    },
    featured: (page = {}) => {
      const a = active();
      if (!a) return Promise.reject(new GifError(OFF_MESSAGE));
      return cached(`${a.name}|featured|${page.pos ?? ''}|${page.limit ?? ''}`, featuredTtl, () => a.provider.featured(page));
    },
    reconfigure(keys) {
      if (keys.klipyKey !== undefined) klipyKey = (keys.klipyKey ?? '').trim();
      if (keys.giphyKey !== undefined) giphyKey = (keys.giphyKey ?? '').trim();
      build();
    },
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
