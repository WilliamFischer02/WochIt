// `fixtures/tailscale/serve-status.json` is the real output of `tailscale serve status --json`
// (Tailscale 1.102.4, Windows) on the host PC with WochIt published on :8443 and something else on :443.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TailnetChecker, parseServeStatus, runTailscale, tailscaleDnsName, type ExecFn } from '../src/net/tailscale.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_JSON = readFileSync(path.join(here, 'fixtures', 'tailscale', 'serve-status.json'), 'utf8');
const DNS = 'william-desktop.tail2ac207.ts.net';

describe('parseServeStatus', () => {
  it('finds the :8443 → http://127.0.0.1:8788 mapping in the real output and reports the host', () => {
    expect(parseServeStatus(SERVE_JSON, 8788)).toEqual({ published: true, host: DNS });
    expect(parseServeStatus(JSON.parse(SERVE_JSON), 8788, 8443)).toEqual({ published: true, host: DNS });
  });

  it('is not published for another host port, another HTTPS port, or a non-root handler', () => {
    expect(parseServeStatus(SERVE_JSON, 8799)).toEqual({ published: false, host: null });
    expect(parseServeStatus(SERVE_JSON, 8788, 443)).toEqual({ published: false, host: null }); // :443 proxies 47821
    expect(parseServeStatus(SERVE_JSON, 47821, 443)).toEqual({ published: true, host: DNS });
    const subpath = { Web: { [`${DNS}:8443`]: { Handlers: { '/wochit': { Proxy: 'http://127.0.0.1:8788' } } } } };
    expect(parseServeStatus(subpath, 8788)).toEqual({ published: false, host: null });
  });

  it('accepts localhost / [::1] / trailing slash spellings of the loopback target', () => {
    for (const proxy of ['http://localhost:8788', 'http://[::1]:8788', 'http://127.0.0.1:8788/', 'http://127.0.0.1:8788']) {
      expect(parseServeStatus({ Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: proxy } } } } }, 8788).published).toBe(true);
    }
    expect(parseServeStatus({ Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: 'http://192.168.1.5:8788' } } } } }, 8788).published).toBe(false);
    expect(parseServeStatus({ Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1' } } } } }, 80).published).toBe(true);
  });

  it('empty configs: {} / {"TCP":{},"Web":{}} / null / "" are not published', () => {
    expect(parseServeStatus('{}', 8788)).toEqual({ published: false, host: null });
    expect(parseServeStatus('{"TCP":{},"Web":{}}', 8788)).toEqual({ published: false, host: null });
    expect(parseServeStatus('null', 8788)).toEqual({ published: false, host: null });
    expect(parseServeStatus('', 8788)).toEqual({ published: false, host: null });
    expect(parseServeStatus(undefined, 8788)).toEqual({ published: false, host: null });
  });

  it('garbage never throws', () => {
    expect(parseServeStatus('not json at all', 8788)).toEqual({ published: false, host: null });
    expect(parseServeStatus('[1,2,3]', 8788)).toEqual({ published: false, host: null });
    expect(parseServeStatus({ Web: 'nope' }, 8788)).toEqual({ published: false, host: null });
    expect(parseServeStatus({ Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: 42 } } } } }, 8788).published).toBe(false);
    expect(parseServeStatus({ Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: 'not a url' } } } } }, 8788).published).toBe(false);
    expect(parseServeStatus({ Web: { 'no-port-here': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } } }, 8788).published).toBe(false);
  });
});

type Script = Record<string, { ok: true; stdout: string } | { ok: false; code: string | null; message: string }>;

/** An ExecFn answering per binary name; records every call. */
function fakeExec(script: Script) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const exec: ExecFn = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    return script[bin] ?? { ok: false, code: 'ENOENT', message: `spawn ${bin} ENOENT` };
  };
  return { exec, calls };
}

describe('runTailscale / tailscaleDnsName', () => {
  it('tries candidates in order; ENOENT everywhere → unavailable; a real failure → failed', async () => {
    const none = fakeExec({});
    expect(await runTailscale(['serve', 'status', '--json'], { exec: none.exec, candidates: ['tailscale', 'ts2'] })).toEqual({ kind: 'unavailable' });
    expect(none.calls.map((c) => c.bin)).toEqual(['tailscale', 'ts2']);

    const second = fakeExec({ ts2: { ok: true, stdout: '{}' } });
    expect(await runTailscale(['x'], { exec: second.exec, candidates: ['tailscale', 'ts2'] })).toEqual({ kind: 'ok', stdout: '{}' });

    const down = fakeExec({ tailscale: { ok: false, code: null, message: 'exit 1: failed to connect to local tailscaled' } });
    expect(await runTailscale(['x'], { exec: down.exec, candidates: ['tailscale', 'ts2'] })).toEqual({ kind: 'failed', message: 'exit 1: failed to connect to local tailscaled' });
  });

  it('skips absolute candidates that do not exist on disk without calling exec', async () => {
    const f = fakeExec({});
    await runTailscale(['x'], { exec: f.exec, candidates: ['C:\\definitely\\not\\here\\tailscale.exe', 'tailscale'] });
    expect(f.calls.map((c) => c.bin)).toEqual(['tailscale']);
  });

  it('tailscaleDnsName strips the trailing dot and is null on anything odd', async () => {
    const ok = fakeExec({ tailscale: { ok: true, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${DNS}.` } }) } });
    expect(await tailscaleDnsName({ exec: ok.exec, candidates: ['tailscale'] })).toBe(DNS);
    expect(ok.calls[0]).toEqual({ bin: 'tailscale', args: ['status', '--json'] });
    expect(await tailscaleDnsName({ exec: fakeExec({ tailscale: { ok: true, stdout: '{"Self":{}}' } }).exec, candidates: ['tailscale'] })).toBeNull();
    expect(await tailscaleDnsName({ exec: fakeExec({ tailscale: { ok: true, stdout: 'garbage' } }).exec, candidates: ['tailscale'] })).toBeNull();
    expect(await tailscaleDnsName({ exec: fakeExec({}).exec, candidates: ['tailscale'] })).toBeNull();
  });
});

describe('TailnetChecker', () => {
  it('caches a published status with the URL built from the known DNS name', async () => {
    const f = fakeExec({ tailscale: { ok: true, stdout: SERVE_JSON } });
    const c = new TailnetChecker({ hostPort: 8788, dnsName: () => DNS, exec: f.exec, candidates: ['tailscale'], now: () => 1234 });
    expect(c.status).toBeNull(); // nothing checked yet
    await c.check();
    expect(c.status).toEqual({ published: true, url: `https://${DNS}:8443`, checkedAt: 1234 });
    expect(c.unavailable).toBe(false);
    expect(f.calls[0]).toEqual({ bin: 'tailscale', args: ['serve', 'status', '--json'] });
  });

  it('falls back to the serve config host when the DNS name is unknown; not published → url still known, published false', async () => {
    const f = fakeExec({ tailscale: { ok: true, stdout: SERVE_JSON } });
    const c = new TailnetChecker({ hostPort: 8788, exec: f.exec, candidates: ['tailscale'], now: () => 1 });
    await c.check();
    expect(c.status).toEqual({ published: true, url: `https://${DNS}:8443`, checkedAt: 1 });

    const other = new TailnetChecker({ hostPort: 8799, dnsName: () => DNS, exec: f.exec, candidates: ['tailscale'], now: () => 2 });
    await other.check();
    expect(other.status).toEqual({ published: false, url: `https://${DNS}:8443`, checkedAt: 2 });

    const nameless = new TailnetChecker({ hostPort: 8799, exec: f.exec, candidates: ['tailscale'], now: () => 3 });
    await nameless.check();
    expect(nameless.status).toEqual({ published: false, url: null, checkedAt: 3 });
  });

  it('CLI missing → unavailable and status null; daemon down or garbage → not published, never throws', async () => {
    const missing = new TailnetChecker({ hostPort: 8788, exec: fakeExec({}).exec, candidates: ['tailscale'] });
    await missing.check();
    expect(missing.status).toBeNull();
    expect(missing.unavailable).toBe(true);

    const down = new TailnetChecker({ hostPort: 8788, dnsName: () => DNS, exec: fakeExec({ tailscale: { ok: false, code: null, message: 'timeout' } }).exec, candidates: ['tailscale'], now: () => 9 });
    await down.check();
    expect(down.status).toEqual({ published: false, url: `https://${DNS}:8443`, checkedAt: 9 });
    expect(down.unavailable).toBe(false);

    const garbage = new TailnetChecker({ hostPort: 8788, exec: fakeExec({ tailscale: { ok: true, stdout: '<html>' } }).exec, candidates: ['tailscale'], now: () => 10 });
    await garbage.check();
    expect(garbage.status).toEqual({ published: false, url: null, checkedAt: 10 });
  });

  it('start() checks at once and then on the interval; stop() ends it; concurrent checks share one run', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeExec({ tailscale: { ok: true, stdout: SERVE_JSON } });
      const c = new TailnetChecker({ hostPort: 8788, dnsName: () => DNS, exec: f.exec, candidates: ['tailscale'], intervalMs: 60_000 });
      c.start();
      c.start(); // idempotent
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toHaveLength(1);
      expect(c.status?.published).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.calls).toHaveLength(3);
      c.stop();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(f.calls).toHaveLength(3);

      const p1 = c.check();
      const p2 = c.check();
      await Promise.all([p1, p2]);
      expect(f.calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
