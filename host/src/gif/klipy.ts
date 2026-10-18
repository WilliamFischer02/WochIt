// Klipy GIF API (https://docs.klipy.com/gifs-api/gifs-search-api.md, .../gifs-trending-api.md,
// .../gifs-format-sizes.md, .../network-requirements.md). Response:
//   { result: true, data: { data: [item], current_page, per_page, has_next } }
//   item: { id, slug, title, type?, blur_preview?, file: { hd|md|sm|xs: { gif|webp|webm|mp4|jpg: { url, width, height, size } } } }
// Pagination is by page number (min 1); per_page is 8..50 (default 24). `pos` on our REST side is
// the page number as a string.
import { Gif, type GifSearchResponse } from '@wochit/shared';
import { GIF_DEFAULT_LIMIT, clampInt, fetchJson, isRecord, numberish, stringish, type GifPage, type GifProvider, type ProviderDeps } from './provider.js';

/** Media delivery hosts from docs.klipy.com/network-requirements. */
export const KLIPY_CDN_HOSTS: readonly string[] = ['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'];

export type KlipyContentFilter = 'off' | 'low' | 'medium' | 'high';

export interface KlipyOptions extends ProviderDeps {
  apiKey: string;
  baseUrl?: string;
  /** ISO 3166-1 alpha-2 country, lowercase as the docs show (`us`). */
  locale?: string;
  /** Default 'medium' (roughly PG-13). */
  contentFilter?: KlipyContentFilter;
  customerId?: string;
}

interface Variant {
  url: string;
  width: number;
  height: number;
}

function variant(file: Record<string, unknown>, size: string, format: string): Variant | null {
  const s = file[size];
  if (!isRecord(s)) return null;
  const f = s[format];
  if (!isRecord(f)) return null;
  const url = stringish(f.url);
  const width = numberish(f.width);
  const height = numberish(f.height);
  if (!url || !width || !height || width <= 0 || height <= 0) return null;
  return { url, width: Math.round(width), height: Math.round(height) };
}

function firstVariant(file: Record<string, unknown>, candidates: Array<[string, string]>): Variant | null {
  for (const [size, format] of candidates) {
    const v = variant(file, size, format);
    if (v) return v;
  }
  return null;
}

/** One Klipy item → Gif. previewUrl = sm.gif (xs.gif, sm.webp…), url = md.gif (hd.gif, sm.gif…). */
export function normalizeKlipyItem(raw: unknown): Gif | null {
  if (!isRecord(raw) || !isRecord(raw.file)) return null;
  const id = raw.id === undefined || raw.id === null ? null : String(raw.id);
  if (!id) return null;
  const preview = firstVariant(raw.file, [
    ['sm', 'gif'],
    ['xs', 'gif'],
    ['sm', 'webp'],
    ['xs', 'webp'],
    ['md', 'gif'],
  ]);
  const full = firstVariant(raw.file, [
    ['md', 'gif'],
    ['hd', 'gif'],
    ['sm', 'gif'],
    ['md', 'webp'],
    ['hd', 'webp'],
  ]);
  if (!preview || !full) return null;
  const candidate: Gif = { id, provider: 'klipy', url: full.url, previewUrl: preview.url, width: preview.width, height: preview.height };
  const title = stringish(raw.title)?.trim();
  if (title) candidate.title = title;
  const parsed = Gif.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function normalizeKlipyResponse(json: unknown): GifSearchResponse {
  const empty: GifSearchResponse = { provider: 'klipy', results: [], next: null };
  if (!isRecord(json) || !isRecord(json.data)) return empty;
  const page = json.data;
  const list = Array.isArray(page.data) ? page.data : [];
  const results: Gif[] = [];
  for (const item of list) {
    const g = normalizeKlipyItem(item);
    if (g) results.push(g);
  }
  const current = numberish(page.current_page) ?? 1;
  const next = page.has_next === true ? String(Math.max(1, Math.floor(current)) + 1) : null;
  return { provider: 'klipy', results, next };
}

export function createKlipyProvider(opts: KlipyOptions): GifProvider {
  const base = (opts.baseUrl ?? 'https://api.klipy.com/api/v1').replace(/\/$/, '');
  const root = `${base}/${encodeURIComponent(opts.apiKey)}/gifs`;
  const common = (page: GifPage): URLSearchParams => {
    const q = new URLSearchParams({
      page: String(clampInt(page.pos, 1, 1_000_000, 1)),
      per_page: String(clampInt(page.limit, 8, 50, GIF_DEFAULT_LIMIT)),
      locale: opts.locale ?? 'us',
      content_filter: opts.contentFilter ?? 'medium',
      format_filter: 'gif,webp,mp4',
    });
    if (opts.customerId) q.set('customer_id', opts.customerId);
    return q;
  };
  return {
    name: 'klipy',
    async search(query, page) {
      const q = common(page);
      q.set('q', query);
      return normalizeKlipyResponse(await fetchJson(`${root}/search?${q.toString()}`, opts, 'Klipy'));
    },
    async featured(page) {
      const q = common(page);
      return normalizeKlipyResponse(await fetchJson(`${root}/trending?${q.toString()}`, opts, 'Klipy'));
    },
  };
}
