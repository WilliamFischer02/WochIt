import { beforeEach, describe, expect, it } from 'vitest';
import { ANDROID_STORE_URL, IOS_STORE_URL, detectPlatform, loadProgress, openWochitUrl, probeHost, saveProgress, storeFor } from './invite';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PIXEL = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

describe('detectPlatform / storeFor', () => {
  it('sends iPhones to the App Store and Androids to Play, with the other as a fallback', () => {
    expect(detectPlatform(IPHONE)).toBe('ios');
    expect(detectPlatform(PIXEL)).toBe('android');
    expect(detectPlatform(DESKTOP)).toBe('other');
    expect(storeFor('ios').primary.url).toBe(IOS_STORE_URL);
    expect(storeFor('ios').other.url).toBe(ANDROID_STORE_URL);
    expect(storeFor('android').primary.url).toBe(ANDROID_STORE_URL);
    expect(storeFor('other').primary.url).toBe(IOS_STORE_URL);
  });
});

describe('progress', () => {
  beforeEach(() => localStorage.clear());
  it('round-trips the done steps and clears when empty', () => {
    expect(loadProgress()).toEqual(new Set());
    saveProgress(new Set([3, 1]));
    expect(localStorage.getItem('wochit.invite.done')).toBe('1,3');
    expect(loadProgress()).toEqual(new Set([1, 3]));
    saveProgress(new Set());
    expect(localStorage.getItem('wochit.invite.done')).toBeNull();
  });
  it('ignores junk', () => {
    localStorage.setItem('wochit.invite.done', '9,x,2');
    expect(loadProgress()).toEqual(new Set([2]));
  });
});

describe('openWochitUrl', () => {
  it('adds the from=invite marker', () => {
    expect(openWochitUrl('https://pc.tail.ts.net:8443')).toBe('https://pc.tail.ts.net:8443/?from=invite');
    expect(openWochitUrl('https://pc.tail.ts.net:8443/')).toBe('https://pc.tail.ts.net:8443/?from=invite');
  });
});

describe('probeHost', () => {
  const health = { ok: true, version: '0.1.0', protocol: 1, source: 'none', vlc: { connected: false }, ffmpeg: { found: true, encoder: null }, gifSearchAvailable: false };
  it('is true for a WochIt health answer, false for anything else', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const ok = await probeHost('https://pc.tail.ts.net:8443/', 1000, async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => health };
    });
    expect(ok).toBe(true);
    expect(calls[0]?.[0]).toBe('https://pc.tail.ts.net:8443/api/health');
    expect(calls[0]?.[1]).toMatchObject({ mode: 'cors', cache: 'no-store' });
    expect(await probeHost('https://x', 1000, async () => ({ ok: true, json: async () => ({ hello: 'vercel' }) }))).toBe(false);
    expect(await probeHost('https://x', 1000, async () => ({ ok: false, json: async () => ({}) }))).toBe(false);
    expect(
      await probeHost('https://x', 1000, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe(false);
  });
  it('gives up after the timeout', async () => {
    const t0 = Date.now();
    const ok = await probeHost('https://x', 30, (_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
