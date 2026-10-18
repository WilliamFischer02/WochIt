import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, PACKAGE_DIR, loadConfig, splitRoots } from '../src/config.js';

const cwd = 'C:\\cwd';
// Expectations go through path.resolve so they hold on Linux CI too, where `X:\...` is relative.
const r = (p: string): string => path.resolve(cwd, p);

describe('splitRoots', () => {
  it('splits on ";", trims, drops empties and duplicates, resolves to absolute', () => {
    expect(splitRoots('X:\\Video Folder\\Plex Movies; X:\\Video Folder ;;"D:\\T"; X:\\Video Folder', cwd)).toEqual([
      r('X:\\Video Folder\\Plex Movies'),
      r('X:\\Video Folder'),
      r('D:\\T'),
    ]);
    expect(splitRoots(undefined, cwd)).toEqual([]);
    expect(splitRoots('', cwd)).toEqual([]);
  });
});

describe('loadConfig', () => {
  const base = { WOCHIT_PIN: '123456' };

  it('applies defaults and resolves web/dist relative to the package', () => {
    const c = loadConfig({ argv: [], env: base, dotenv: false, cwd });
    expect(c.port).toBe(8788);
    expect(c.bind).toBe('127.0.0.1');
    expect(c.pin).toBe('123456');
    expect(c.pinGenerated).toBe(false);
    expect(c.cacheDir).toBe(path.resolve(cwd, './.cache'));
    expect(c.cacheMaxBytes).toBe(60 * 1024 ** 3);
    expect(c.roots).toEqual([]);
    expect(c.encoder).toBe('auto');
    expect(c.vlc.httpPort).toBe(8089);
    expect(c.vlc.passwordConfigured).toBe(false);
    expect(c.vlc.httpPassword.length).toBeGreaterThan(4);
    expect(c.gif).toEqual({ provider: 'auto', klipyKey: null, giphyKey: null });
    expect(c.webDir).toBe(path.resolve(PACKAGE_DIR, '..', 'web', 'dist'));
    expect(c.logsDir).toBe(path.join(PACKAGE_DIR, 'logs'));
    expect(c.fakeMedia).toBe(false);
    expect(c.logLevel).toBe('info');
    expect(c.corsOrigins).toEqual(['https://wochit.vercel.app']);
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('generates a 6-digit PIN when none is set', () => {
    const c = loadConfig({ argv: [], env: {}, dotenv: false, cwd });
    expect(c.pin).toMatch(/^\d{6}$/);
    expect(c.pinGenerated).toBe(true);
  });

  it('CLI flags override the environment', () => {
    const c = loadConfig({
      argv: ['--port', '9000', '--pin', '4321', '--roots', 'D:\\a;D:\\b', '--cache', 'Z:\\cache', '--web-dir', 'W:\\dist', '--fake-media', '-v'],
      env: { ...base, WOCHIT_PORT: '8788', WOCHIT_MEDIA_ROOTS: 'X:\\x', WOCHIT_CACHE_DIR: 'C:\\c', WOCHIT_CACHE_MAX_GB: '2.5', KLIPY_API_KEY: ' k ', WOCHIT_BIND: '0.0.0.0' },
      dotenv: false,
      cwd,
    });
    expect(c.port).toBe(9000);
    expect(c.pin).toBe('4321');
    expect(c.roots).toEqual([r('D:\\a'), r('D:\\b')]);
    expect(c.cacheDir).toBe(r('Z:\\cache'));
    expect(c.cacheMaxBytes).toBe(Math.round(2.5 * 1024 ** 3));
    expect(c.webDir).toBe(r('W:\\dist'));
    expect(c.fakeMedia).toBe(true);
    expect(c.logLevel).toBe('debug');
    expect(c.gif).toEqual({ provider: 'auto', klipyKey: 'k', giphyKey: null });
    expect(c.bind).toBe('0.0.0.0');
  });

  it('reads the GIF provider choice and keys; --bind overrides WOCHIT_BIND', () => {
    const c = loadConfig({ argv: ['--bind', '::'], env: { ...base, WOCHIT_GIF_PROVIDER: 'GIPHY', KLIPY_API_KEY: 'k', GIPHY_API_KEY: 'g', WOCHIT_BIND: '0.0.0.0' }, dotenv: false, cwd });
    expect(c.gif).toEqual({ provider: 'giphy', klipyKey: 'k', giphyKey: 'g' });
    expect(c.bind).toBe('::');
    expect(loadConfig({ argv: [], env: { ...base, WOCHIT_CORS_ORIGINS: 'https://a.example, b.example' }, dotenv: false, cwd }).corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(loadConfig({ argv: [], env: { ...base, WOCHIT_CORS_ORIGINS: 'none' }, dotenv: false, cwd }).corsOrigins).toEqual([]);
    expect(() => loadConfig({ argv: [], env: { ...base, WOCHIT_GIF_PROVIDER: 'tenor' }, dotenv: false, cwd })).toThrow(/WOCHIT_GIF_PROVIDER/);
  });

  it('reads VLC and host address settings', () => {
    const c = loadConfig({
      argv: [],
      env: { ...base, WOCHIT_VLC_EXE: 'C:\\vlc\\vlc.exe', WOCHIT_VLC_HTTP_PORT: '8090', WOCHIT_VLC_HTTP_PASSWORD: 'pw', WOCHIT_HOST_ADDRS: '100.1.2.3, host.ts.net;10.0.0.1' },
      dotenv: false,
      cwd,
    });
    expect(c.vlc).toEqual({ exe: r('C:\\vlc\\vlc.exe'), httpPort: 8090, httpPassword: 'pw', passwordConfigured: true });
    expect(c.hostAddrs).toEqual(['100.1.2.3', 'host.ts.net', '10.0.0.1']);
  });

  it('rejects bad values with ConfigError', () => {
    expect(() => loadConfig({ argv: ['--port', 'abc'], env: base, dotenv: false, cwd })).toThrow(ConfigError);
    expect(() => loadConfig({ argv: ['--port', '70000'], env: base, dotenv: false, cwd })).toThrow(/port/);
    expect(() => loadConfig({ argv: ['--pin', '12'], env: {}, dotenv: false, cwd })).toThrow(/PIN/);
    expect(() => loadConfig({ argv: ['--pin', 'abcd'], env: {}, dotenv: false, cwd })).toThrow(/PIN/);
    expect(() => loadConfig({ argv: [], env: { ...base, WOCHIT_ENCODER: 'hevc' }, dotenv: false, cwd })).toThrow(/WOCHIT_ENCODER/);
    expect(() => loadConfig({ argv: ['--bogus'], env: base, dotenv: false, cwd })).toThrow(ConfigError);
    expect(() => loadConfig({ argv: ['--help'], env: base, dotenv: false, cwd })).toThrow(/help/);
  });
});
