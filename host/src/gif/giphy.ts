// GIPHY API v1 (https://developers.giphy.com/docs/api/endpoint#search, #trending). Response:
//   { data: [ { id, title, rating, images: { original, downsized_medium, fixed_width, fixed_width_small,
//     preview_gif, … each { url, width, height } with numbers as strings } } ],
//     pagination: { total_count, count, offset }, meta: { status, msg } }
// Pagination is by offset; `pos` on our REST side is the offset as a string. Beta keys are
// capped at 100 calls/hour, hence the cache in gif/index.ts.
import { Gif, type GifSearchResponse } from '@wochit/shared';
import { GIF_DEFAULT_LIMIT, clampInt, fetchJson, isRecord, numberish, stringish, type GifPage, type GifProvider, type ProviderDeps } from './provider.js';

export const GIPHY_CDN_HOSTS: readonly string[] = [
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
];

export type GiphyRating = 'g' | 'pg' | 'pg-13' | 'r';

export interface GiphyOptions extends ProviderDeps {
  apiKey: string;
  baseUrl?: string;
  /** Default 'pg-13'. */
  rating?: GiphyRating;
  /** Default 'en'. */
  lang?: string;
}

interface Variant {
  url: string;
  width: number;
  height: number;
}

function variant(images: Record<string, unknown>, key: string): Variant | null {
  const v = images[key];
  if (!isRecord(v)) return null;
  const url = stringish(v.url);
  const width = numberish(v.width);
  const height = numberish(v.height);
  if (!url || !width || !height || width <= 0 || height <= 0) return null;
  return { url, width: Math.round(width), height: Math.round(height) };
}

function firstVariant(images: Record<string, unknown>, keys: string[]): Variant | null {
  for (const k of keys) {
    const v = variant(images, k);
    if (v) return v;
  }
  return null;
}

/** One GIPHY item → Gif. previewUrl = fixed_width_small (preview_gif, fixed_width…), url = original (downsized_medium…). */
export function normalizeGiphyItem(raw: unknown): Gif | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || !isRecord(raw.images)) return null;
  const preview = firstVariant(raw.images, ['fixed_width_small', 'preview_gif', 'fixed_width', 'downsized']);
  const full = firstVariant(raw.images, ['original', 'downsized_medium', 'downsized_large', 'fixed_width']);
  if (!preview || !full) return null;
  const candidate: Gif = { id: raw.id, provider: 'giphy', url: full.url, previewUrl: preview.url, width: preview.width, height: preview.height };
  const title = stringish(raw.title)?.trim();
  if (title) candidate.title = title;
  const parsed = Gif.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function normalizeGiphyResponse(json: unknown): GifSearchResponse {
  const empty: GifSearchResponse = { provider: 'giphy', results: [], next: null };
  if (!isRecord(json)) return empty;
  const list = Array.isArray(json.data) ? json.data : [];
  const results: Gif[] = [];
  for (const item of list) {
    const g = normalizeGiphyItem(item);
    if (g) results.push(g);
  }
  let next: string | null = null;
  if (isRecord(json.pagination)) {
    const offset = numberish(json.pagination.offset) ?? 0;
    const count = numberish(json.pagination.count) ?? list.length;
    const total = numberish(json.pagination.total_count);
    const after = offset + count;
    if (count > 0 && (total === null ? list.length > 0 : after < total)) next = String(after);
  }
  return { provider: 'giphy', results, next };
}

export function createGiphyProvider(opts: GiphyOptions): GifProvider {
  const base = (opts.baseUrl ?? 'https://api.giphy.com/v1').replace(/\/$/, '');
  const common = (page: GifPage): URLSearchParams =>
    new URLSearchParams({
      api_key: opts.apiKey,
      limit: String(clampInt(page.limit, 1, 50, GIF_DEFAULT_LIMIT)),
      offset: String(clampInt(page.pos, 0, 4999, 0)),
      rating: opts.rating ?? 'pg-13',
    });
  return {
    name: 'giphy',
    async search(query, page) {
      const q = common(page);
      q.set('q', query);
      q.set('lang', opts.lang ?? 'en');
      return normalizeGiphyResponse(await fetchJson(`${base}/gifs/search?${q.toString()}`, opts, 'GIPHY'));
    },
    async featured(page) {
      const q = common(page);
      return normalizeGiphyResponse(await fetchJson(`${base}/gifs/trending?${q.toString()}`, opts, 'GIPHY'));
    },
  };
}
