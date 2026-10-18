import { describe, expect, it } from 'vitest';
import { DEFAULT_CORS_ORIGINS, classifyOrigin, normalizeOrigin, parseCorsOrigins } from '../src/server/cors.js';

describe('normalizeOrigin', () => {
  it('lowercases, drops paths and trailing slashes, assumes https for bare hosts', () => {
    expect(normalizeOrigin('https://WochIt.vercel.app/')).toBe('https://wochit.vercel.app');
    expect(normalizeOrigin('https://wochit.vercel.app/some/path?q=1')).toBe('https://wochit.vercel.app');
    expect(normalizeOrigin('wochit.vercel.app')).toBe('https://wochit.vercel.app');
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeOrigin('ftp://x.y')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('not a url at all://')).toBeNull();
  });
});

describe('parseCorsOrigins', () => {
  it('defaults to the Vercel page, accepts lists, and "none" disables cross-origin', () => {
    expect(parseCorsOrigins(undefined)).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(parseCorsOrigins('')).toEqual(['https://wochit.vercel.app']);
    expect(parseCorsOrigins('https://a.example, http://b.example:8080 ;https://a.example/')).toEqual(['https://a.example', 'http://b.example:8080']);
    expect(parseCorsOrigins('none')).toEqual([]);
    expect(parseCorsOrigins('OFF')).toEqual([]);
    expect(parseCorsOrigins('garbage://, https://ok.example')).toEqual(['https://ok.example']);
  });
});

describe('classifyOrigin', () => {
  const allow = ['https://wochit.vercel.app'];
  it('absent Origin is same-origin', () => {
    expect(classifyOrigin(undefined, '127.0.0.1:8788', allow)).toBe('same');
  });
  it('Origin host equal to the Host header is same-origin regardless of scheme (tailscale serve terminates TLS)', () => {
    expect(classifyOrigin('http://127.0.0.1:8788', '127.0.0.1:8788', allow)).toBe('same');
    expect(classifyOrigin('https://william-desktop.tail2ac207.ts.net:8443', 'william-desktop.tail2ac207.ts.net:8443', allow)).toBe('same');
    expect(classifyOrigin('https://William-Desktop.tail2ac207.ts.net:8443', 'william-desktop.tail2ac207.ts.net:8443', allow)).toBe('same');
  });
  it('listed origins are allowed; everything else is denied', () => {
    expect(classifyOrigin('https://wochit.vercel.app', '127.0.0.1:8788', allow)).toBe('allowed');
    expect(classifyOrigin('https://wochit.vercel.app/', '127.0.0.1:8788', allow)).toBe('allowed');
    expect(classifyOrigin('http://wochit.vercel.app', '127.0.0.1:8788', allow)).toBe('denied'); // scheme matters for the allowlist
    expect(classifyOrigin('https://evil.example', '127.0.0.1:8788', allow)).toBe('denied');
    expect(classifyOrigin('https://wochit.vercel.app.evil.example', '127.0.0.1:8788', allow)).toBe('denied');
    expect(classifyOrigin('null', '127.0.0.1:8788', allow)).toBe('denied');
    expect(classifyOrigin('https://anything.example', '127.0.0.1:8788', [])).toBe('denied');
  });
});
