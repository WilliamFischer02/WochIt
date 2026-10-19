import { describe, expect, it } from 'vitest';
import { parseInviteHash, type HealthResponse } from '@wochit/shared';
import { inviteMessage, inviteUrl, isLoopbackUrl, isTailnetUrl, machineName, pickShareUrl } from './share';

const base: HealthResponse = {
  ok: true,
  version: '0.1.0',
  protocol: 1,
  source: 'none',
  vlc: { connected: false },
  ffmpeg: { found: true, encoder: 'h264_nvenc' },
  gifSearchAvailable: false,
  urls: ['http://127.0.0.1:8788', 'https://pc.tail.ts.net:8443'],
};

describe('inviteUrl / inviteMessage', () => {
  it('builds the public invite link with host, share link and name in the hash', () => {
    const url = inviteUrl('https://wochit.vercel.app/', { tailnetUrl: 'https://pc.tail.ts.net:8443', shareLink: 'https://login.tailscale.com/admin/invite/abc', hostNick: 'William' });
    expect(url).toBe('https://wochit.vercel.app/invite#h=https%3A%2F%2Fpc.tail.ts.net%3A8443&s=https%3A%2F%2Flogin.tailscale.com%2Fadmin%2Finvite%2Fabc&n=William');
    expect(parseInviteHash(new URL(url).hash)).toEqual({ h: 'https://pc.tail.ts.net:8443', s: 'https://login.tailscale.com/admin/invite/abc', n: 'William' });
  });
  it('leaves the share link and name out when unknown', () => {
    const url = inviteUrl('https://wochit.vercel.app', { tailnetUrl: 'https://pc.tail.ts.net:8443', shareLink: null, hostNick: null });
    expect(url).toBe('https://wochit.vercel.app/invite#h=https%3A%2F%2Fpc.tail.ts.net%3A8443');
    expect(parseInviteHash(new URL(url).hash)).toEqual({ h: 'https://pc.tail.ts.net:8443' });
  });
  it('wraps the link in the movie-night message without the PIN', () => {
    const msg = inviteMessage('https://wochit.vercel.app/invite#h=x');
    expect(msg).toBe('Movie night 🎬 Tap this on your phone and follow the steps: https://wochit.vercel.app/invite#h=x');
    expect(msg).not.toMatch(/PIN/);
  });
});

describe('pickShareUrl', () => {
  it('uses the published tailnet URL', () => {
    expect(pickShareUrl({ ...base, tailnet: { published: true, url: 'https://pc.tail.ts.net:8443', checkedAt: 1 } }, 'http://127.0.0.1:8788')).toEqual({
      url: 'https://pc.tail.ts.net:8443',
      tailnet: true,
    });
  });
  it('falls back to the local address when the host knows it is not published', () => {
    expect(pickShareUrl({ ...base, tailnet: { published: false, url: null, checkedAt: 1 } }, 'http://127.0.0.1:8788')).toEqual({ url: 'http://127.0.0.1:8788', tailnet: false });
  });
  it('trusts a listed .ts.net URL when the host could not check', () => {
    expect(pickShareUrl(base, 'http://127.0.0.1:8788')).toEqual({ url: 'https://pc.tail.ts.net:8443', tailnet: true });
    expect(pickShareUrl({ ...base, urls: ['http://127.0.0.1:8788'] }, 'http://127.0.0.1:8788')).toEqual({ url: 'http://127.0.0.1:8788', tailnet: false });
    expect(pickShareUrl(null, 'http://localhost:5173')).toEqual({ url: 'http://localhost:5173', tailnet: false });
  });
});

describe('url helpers', () => {
  it('tell tailnet and loopback apart', () => {
    expect(isTailnetUrl('https://pc.tail.ts.net:8443')).toBe(true);
    expect(isTailnetUrl('http://127.0.0.1:8788')).toBe(false);
    expect(isTailnetUrl('not a url')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1:8788')).toBe(true);
    expect(isLoopbackUrl('http://localhost:5173/')).toBe(true);
    expect(isLoopbackUrl('https://pc.tail.ts.net:8443')).toBe(false);
  });
  it('extracts the machine name from a tailnet URL', () => {
    expect(machineName('https://william-desktop.tail2ac207.ts.net:8443')).toBe('william-desktop');
    expect(machineName('http://127.0.0.1:8788')).toBeNull();
    expect(machineName('http://localhost:5173')).toBeNull();
    expect(machineName('nope')).toBeNull();
  });
});
