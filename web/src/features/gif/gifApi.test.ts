import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gif } from '@wochit/shared';
import {
  ATTRIBUTION,
  CACHE_TTL_MS,
  GifApiError,
  RESTING_TEXT,
  clearGifCache,
  effectiveQuery,
  fetchGifs,
  fetchGifsCached,
  gifErrorText,
  gifUrl,
  isResting,
  poweredBy,
  searchPlaceholder,
} from './gifApi';
import { masonry } from './GifPanel';

const gif: Gif = {
  id: 'g1',
  provider: 'klipy',
  url: 'https://static.klipy.com/ii/abc/full.gif',
  previewUrl: 'https://static.klipy.com/ii/abc/preview.gif',
  width: 220,
  height: 124,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('gifUrl / effectiveQuery', () => {
  it('uses featured for an empty query and search otherwise', () => {
    expect(gifUrl({ q: '  ', origin: 'https://host:8443' })).toBe('https://host:8443/api/gif/featured?limit=24');
    expect(gifUrl({ q: 'happy dance', pos: 'abc', origin: 'https://host:8443' })).toBe(
      'https://host:8443/api/gif/search?q=happy+dance&pos=abc&limit=24',
    );
  });

  it('only searches from 2 characters', () => {
    expect(effectiveQuery(' a ')).toBe('');
    expect(effectiveQuery(' ab ')).toBe('ab');
  });
});

describe('fetchGifs', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('wochit.pin', '123456');
    clearGifCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fetchMock.mockReset();
    localStorage.clear();
  });

  it('sends the PIN header and returns validated results', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ provider: 'klipy', results: [gif], next: 'n2' }));
    const res = await fetchGifs({ q: 'cat', origin: 'http://h' });
    expect(res).toEqual({ provider: 'klipy', results: [gif], next: 'n2' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-wochit-pin': '123456' });
  });

  it('prefers the store PIN over localStorage', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ provider: 'giphy', results: [], next: null }));
    await fetchGifs({ q: '', pin: '999999' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-wochit-pin': '999999' });
  });

  it('rejects a response that does not match GifSearchResponse', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ provider: 'klipy', results: [{ id: 1 }], next: null }));
    await expect(fetchGifs({ q: '' })).rejects.toMatchObject({ kind: 'bad_response' });
    fetchMock.mockResolvedValue(jsonResponse({ results: [gif], next: null }));
    await expect(fetchGifs({ q: '' })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('maps 401 to unauthorized, 429 to resting, network failures to network', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad_pin' }, 401));
    await expect(fetchGifs({ q: 'x' })).rejects.toBeInstanceOf(GifApiError);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad_pin' }, 401));
    await expect(fetchGifs({ q: 'x' })).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429));
    const err = await fetchGifs({ q: 'x' }).catch((e: unknown) => e);
    expect(isResting(err)).toBe(true);
    expect(gifErrorText(err)).toBe(RESTING_TEXT);
    expect(RESTING_TEXT).toBe('GIF search is resting for a minute');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchGifs({ q: 'x' })).rejects.toMatchObject({ kind: 'network' });
  });

  it('does not refetch the same page within 5 minutes, shares in-flight requests, and refetches after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    fetchMock.mockImplementation(async () => jsonResponse({ provider: 'klipy', results: [gif], next: null }));
    const [a, b] = await Promise.all([fetchGifsCached({ q: 'cats' }), fetchGifsCached({ q: 'cats' })]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + CACHE_TTL_MS - 1);
    await fetchGifsCached({ q: 'cats' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchGifsCached({ q: 'cats', pos: '24' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_000_000 + CACHE_TTL_MS + 1);
    await fetchGifsCached({ q: 'cats' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429));
    await expect(fetchGifsCached({ q: 'dogs' })).rejects.toMatchObject({ kind: 'rate_limited' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ provider: 'klipy', results: [gif], next: null }));
    await expect(fetchGifsCached({ q: 'dogs' })).resolves.toMatchObject({ results: [gif] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('attribution', () => {
  it('follows the provider the host names, neutral before the first response', () => {
    expect(searchPlaceholder(null)).toBe('Search GIFs');
    expect(searchPlaceholder('klipy')).toBe('Search KLIPY');
    expect(searchPlaceholder('giphy')).toBe('Search GIPHY');
    expect(poweredBy('klipy')).toBe('Powered by KLIPY');
    expect(poweredBy('giphy')).toBe('Powered by GIPHY');
    expect(poweredBy(null)).toBe('');
    expect(ATTRIBUTION.klipy.href).toBe('https://klipy.com');
  });
});

describe('masonry', () => {
  const g = (id: string, w: number, h: number): Gif => ({ ...gif, id, width: w, height: h });

  it('puts each tile in the shortest column and is stable when a page is appended', () => {
    const page1 = [g('a', 100, 200), g('b', 100, 50), g('c', 100, 50), g('d', 100, 100)];
    expect(masonry(page1, 2).map((c) => c.map((x) => x.id))).toEqual([['a'], ['b', 'c', 'd']]);
    const more = masonry([...page1, g('e', 100, 100)], 2).map((c) => c.map((x) => x.id));
    expect(more[0]?.slice(0, 1)).toEqual(['a']);
    expect(more[1]?.slice(0, 3)).toEqual(['b', 'c', 'd']);
    expect(masonry(page1, 3)).toHaveLength(3);
  });
});
