// Klipy fixtures are generated from the official docs' response schema (docs.klipy.com/gifs-api/*.md);
// the GIPHY fixture follows the documented v1 shape (numbers as strings, pagination object).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GifSearchResponse } from '@wochit/shared';
import { GIPHY_CDN_HOSTS, createGiphyProvider, normalizeGiphyItem, normalizeGiphyResponse } from '../src/gif/giphy.js';
import { GifError, createGifService, isAllowedGifHost, isAllowedGifUrl, pickGifProvider } from '../src/gif/index.js';
import { KLIPY_CDN_HOSTS, createKlipyProvider, normalizeKlipyItem, normalizeKlipyResponse } from '../src/gif/klipy.js';
import { clampInt } from '../src/gif/provider.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(here, 'fixtures', 'gif', name), 'utf8'));

type KlipyDoc = { result: boolean; data: { data: Array<{ id: number; title: string; file: Record<string, Record<string, { url: string; width: number; height: number }>> }>; current_page: number; per_page: number; has_next: boolean } };
type GiphyDoc = { data: Array<{ id: string; images: Record<string, { url: string; width: string; height: string }> }>; pagination: { total_count: number; count: number; offset: number } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handler: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    return handler(url);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch, mock: fetchImpl };
}

describe('Klipy', () => {
  const doc = fixture('klipy-search.json') as KlipyDoc;
  const item = doc.data.data[0]!;

  it('normalises an item: previewUrl = sm.gif, url = md.gif, dims from the preview', () => {
    const g = normalizeKlipyItem(item);
    expect(g).toEqual({
      id: '8041071659142944',
      provider: 'klipy',
      url: item.file.md!.gif!.url,
      previewUrl: item.file.sm!.gif!.url,
      width: 220,
      height: 220,
      title: 'Hello',
    });
    expect(g?.url).toBe('https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/8GCrVAB7.gif');
    expect(g?.previewUrl).toBe('https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/y6iepZM7.gif');
  });

  it('falls back across sizes and formats, and drops items without usable files', () => {
    const noSm = { id: 1, title: 'x', file: { xs: { webp: { url: 'https://static1.klipy.com/a.webp', width: 90, height: 60 } }, hd: { gif: { url: 'https://static2.klipy.com/a.gif', width: 900, height: 600 } } } };
    expect(normalizeKlipyItem(noSm)).toMatchObject({ previewUrl: 'https://static1.klipy.com/a.webp', url: 'https://static2.klipy.com/a.gif', width: 90, height: 60 });
    expect(normalizeKlipyItem({ id: 2, file: {} })).toBeNull();
    expect(normalizeKlipyItem({ id: 3, file: { sm: { gif: { url: '', width: 1, height: 1 } } } })).toBeNull();
    expect(normalizeKlipyItem({ title: 'no id', file: item.file })).toBeNull();
    expect(normalizeKlipyItem(null)).toBeNull();
  });

  it('normalises a response: next = current_page + 1 while has_next', () => {
    const r = normalizeKlipyResponse(doc);
    expect(GifSearchResponse.safeParse(r).success).toBe(true);
    expect(r.provider).toBe('klipy');
    expect(r.results).toHaveLength(1);
    expect(r.next).toBe('2');
    const last = { ...doc, data: { ...doc.data, current_page: 7, has_next: false } };
    expect(normalizeKlipyResponse(last).next).toBeNull();
    expect(normalizeKlipyResponse({ result: false })).toEqual({ provider: 'klipy', results: [], next: null });
  });

  it('calls the documented endpoints with page/per_page/locale/content_filter/format_filter', async () => {
    const trending = fixture('klipy-trending.json');
    const { calls, fetchImpl } = fakeFetch((url) => jsonResponse(url.pathname.endsWith('/trending') ? trending : doc));
    const p = createKlipyProvider({ apiKey: 'KEY', fetchImpl });
    expect(p.name).toBe('klipy');

    const s = await p.search('hello there', { pos: '3', limit: 10 });
    expect(s.results[0]?.id).toBe('8041071659142944');
    const u = calls[0]!;
    expect(u.origin + u.pathname).toBe('https://api.klipy.com/api/v1/KEY/gifs/search');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: 'hello there',
      page: '3',
      per_page: '10',
      locale: 'us',
      content_filter: 'medium',
      format_filter: 'gif,webp,mp4',
    });

    await p.featured({ limit: 3 }); // per_page floor is 8 per the docs; page defaults to 1
    const t = calls[1]!;
    expect(t.pathname).toBe('/api/v1/KEY/gifs/trending');
    expect(t.searchParams.get('page')).toBe('1');
    expect(t.searchParams.get('per_page')).toBe('8');
    expect(t.searchParams.has('q')).toBe(false);

    await p.search('x', { pos: 'garbage', limit: 999 });
    expect(calls[2]!.searchParams.get('page')).toBe('1');
    expect(calls[2]!.searchParams.get('per_page')).toBe('50');
  });

  it('lists the CDN hosts from network-requirements', () => {
    expect(KLIPY_CDN_HOSTS).toEqual(['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com']);
  });
});

describe('GIPHY', () => {
  const doc = fixture('giphy-search.json') as GiphyDoc;

  it('normalises an item: previewUrl = fixed_width_small, url = original, string dims → numbers', () => {
    const g = normalizeGiphyItem(doc.data[0]);
    expect(g).toEqual({
      id: 'xT9IgzoKnwFNmISR8I',
      provider: 'giphy',
      url: doc.data[0]!.images.original!.url,
      previewUrl: doc.data[0]!.images.fixed_width_small!.url,
      width: 100,
      height: 57,
      title: 'Michael Jackson Popcorn GIF',
    });
  });

  it('falls back to preview_gif when fixed_width_small is missing; drops items without images', () => {
    const g = normalizeGiphyItem(doc.data[1]);
    expect(g).toMatchObject({ id: 'l0HlQoLBEO3LrjXwI', previewUrl: doc.data[1]!.images.preview_gif!.url, width: 171, height: 128, url: doc.data[1]!.images.original!.url });
    expect(normalizeGiphyItem(doc.data[2])).toBeNull();
    expect(normalizeGiphyItem({ images: {} })).toBeNull();
  });

  it('normalises a response: next = offset + count while below total_count', () => {
    const r = normalizeGiphyResponse(doc);
    expect(GifSearchResponse.safeParse(r).success).toBe(true);
    expect(r.provider).toBe('giphy');
    expect(r.results.map((g) => g.id)).toEqual(['xT9IgzoKnwFNmISR8I', 'l0HlQoLBEO3LrjXwI']);
    expect(r.next).toBe('27');
    expect(normalizeGiphyResponse({ ...doc, pagination: { total_count: 27, count: 3, offset: 24 } }).next).toBeNull();
    expect(normalizeGiphyResponse({ data: [], pagination: { total_count: 0, count: 0, offset: 0 } })).toEqual({ provider: 'giphy', results: [], next: null });
    expect(normalizeGiphyResponse('junk')).toEqual({ provider: 'giphy', results: [], next: null });
  });

  it('calls the documented endpoints with api_key/q/limit/offset/rating/lang', async () => {
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(doc));
    const p = createGiphyProvider({ apiKey: 'GK', fetchImpl });
    await p.search('popcorn', { pos: '24', limit: 25 });
    const u = calls[0]!;
    expect(u.origin + u.pathname).toBe('https://api.giphy.com/v1/gifs/search');
    expect(Object.fromEntries(u.searchParams)).toEqual({ api_key: 'GK', q: 'popcorn', limit: '25', offset: '24', rating: 'pg-13', lang: 'en' });
    await p.featured({});
    const t = calls[1]!;
    expect(t.pathname).toBe('/v1/gifs/trending');
    expect(Object.fromEntries(t.searchParams)).toEqual({ api_key: 'GK', limit: '24', offset: '0', rating: 'pg-13' });
  });

  it('lists the CDN hosts', () => {
    expect(GIPHY_CDN_HOSTS).toContain('media0.giphy.com');
    expect(GIPHY_CDN_HOSTS).toContain('i.giphy.com');
  });
});

describe('createGifService', () => {
  const klipyDoc = fixture('klipy-search.json');
  const giphyDoc = fixture('giphy-search.json');

  it('picks the provider: forced, else Klipy, else GIPHY, else off', () => {
    expect(pickGifProvider('auto', 'k', 'g')).toBe('klipy');
    expect(pickGifProvider('auto', '', 'g')).toBe('giphy');
    expect(pickGifProvider('auto', null, undefined)).toBeNull();
    expect(pickGifProvider('giphy', 'k', 'g')).toBe('giphy');
    expect(pickGifProvider('klipy', '', 'g')).toBeNull();
    expect(pickGifProvider('giphy', 'k', ' ')).toBeNull();
  });

  it('is cleanly off without keys (and warns when a provider was forced)', async () => {
    const warn = vi.fn();
    const off = createGifService({ provider: 'auto', klipyKey: '', giphyKey: '', warn });
    expect(off.available).toBe(false);
    expect(off.provider).toBeNull();
    await expect(off.search('x')).rejects.toBeInstanceOf(GifError);
    expect(warn).not.toHaveBeenCalled();
    createGifService({ provider: 'klipy', klipyKey: '', giphyKey: 'g', warn });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('routes to the chosen provider and stamps GifSearchResponse.provider', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => jsonResponse(url.hostname.includes('klipy') ? klipyDoc : giphyDoc));
    const k = createGifService({ provider: 'auto', klipyKey: 'K', giphyKey: 'G', fetchImpl });
    expect(k.provider).toBe('klipy');
    expect((await k.search('a')).provider).toBe('klipy');
    expect(calls[0]!.hostname).toBe('api.klipy.com');
    const g = createGifService({ provider: 'giphy', klipyKey: 'K', giphyKey: 'G', fetchImpl });
    expect(g.provider).toBe('giphy');
    expect((await g.featured()).provider).toBe('giphy');
    expect(calls[1]!.hostname).toBe('api.giphy.com');
  });

  it('caches per query for 60 s (featured 5 min) and never caches failures', async () => {
    let now = 1000;
    let fail = false;
    const { fetchImpl, mock } = fakeFetch(() => (fail ? jsonResponse({ error: 'nope' }, 503) : jsonResponse(klipyDoc)));
    const svc = createGifService({ provider: 'auto', klipyKey: 'K', giphyKey: null, fetchImpl, now: () => now });

    await svc.search('Hello', { limit: 10 });
    await svc.search('hello ', { limit: 10 }); // same query modulo case/whitespace
    expect(mock).toHaveBeenCalledTimes(1);
    await svc.search('hello', { limit: 10, pos: '2' });
    expect(mock).toHaveBeenCalledTimes(2);
    now += 60_001;
    await svc.search('hello', { limit: 10 });
    expect(mock).toHaveBeenCalledTimes(3);

    await svc.featured();
    now += 200_000;
    await svc.featured();
    expect(mock).toHaveBeenCalledTimes(4);
    now += 100_001;
    await svc.featured();
    expect(mock).toHaveBeenCalledTimes(5);

    fail = true;
    await expect(svc.search('boom')).rejects.toMatchObject({ name: 'GifError', status: 503 });
    fail = false;
    await svc.search('boom');
    expect(mock).toHaveBeenCalledTimes(7);
  });

  it('surfaces a 429 with its status so the HTTP layer can say rate_limited', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({}, 429));
    const svc = createGifService({ provider: 'auto', klipyKey: 'K', giphyKey: null, fetchImpl });
    await expect(svc.search('x')).rejects.toMatchObject({ status: 429 });
  });

  it('clampInt helper', () => {
    expect(clampInt(undefined, 8, 50, 24)).toBe(24);
    expect(clampInt('abc', 8, 50, 24)).toBe(24);
    expect(clampInt('3', 8, 50, 24)).toBe(8);
    expect(clampInt(99.9, 8, 50, 24)).toBe(50);
    expect(clampInt(12.7, 1, 50, 24)).toBe(12);
  });
});

describe('chat GIF URL allowlist', () => {
  it('accepts the documented CDN hosts and any *.klipy.com / *.giphy.com subdomain over https', () => {
    for (const h of [...KLIPY_CDN_HOSTS, ...GIPHY_CDN_HOSTS, 'static9.klipy.com', 'media9.giphy.com', 'klipy.com', 'giphy.com']) {
      expect(isAllowedGifHost(h)).toBe(true);
      expect(isAllowedGifUrl(`https://${h}/x/y.gif?cid=1`)).toBe(true);
    }
    expect(isAllowedGifHost('STATIC.KLIPY.COM')).toBe(true);
  });
  it('rejects look-alikes, other hosts, plain http and junk', () => {
    expect(isAllowedGifHost('static.klipy.com.evil.example')).toBe(false);
    expect(isAllowedGifHost('notklipy.com')).toBe(false);
    expect(isAllowedGifHost('media.tenor.com')).toBe(false);
    expect(isAllowedGifHost('evil.example')).toBe(false);
    expect(isAllowedGifUrl('http://static.klipy.com/x.gif')).toBe(false);
    expect(isAllowedGifUrl('https://evil.example/static.klipy.com/x.gif')).toBe(false);
    expect(isAllowedGifUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedGifUrl('not a url')).toBe(false);
  });
});
