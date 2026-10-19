// The tailscale CLI, used read-only: the tailnet DNS name (`tailscale status --json`) and whether
// `tailscale serve` currently publishes this host on HTTPS (`tailscale serve status --json`).
// Tailscale may not be installed at all; everything here reports that instead of throwing, and
// nothing in this file ever blocks startup. docs/ARCHITECTURE.md § Transport.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../media/index.js';

/** Binaries to try in order. `tailscale` relies on PATH; the absolute one is the Windows installer's default. */
export const TAILSCALE_CANDIDATES: readonly string[] = ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'];

export const DEFAULT_TAILNET_HTTPS_PORT = 8443;

export type ExecResult = { ok: true; stdout: string } | { ok: false; code: string | null; message: string };
/** Run a binary with arguments and a timeout; never rejects. Injectable so tests need no CLI. */
export type ExecFn = (bin: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

const defaultExec: ExecFn = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const code = (err as { code?: unknown }).code;
        resolve({ ok: false, code: typeof code === 'string' ? code : null, message: err.message });
        return;
      }
      resolve({ ok: true, stdout: String(stdout) });
    });
  });

export interface RunTailscaleOptions {
  exec?: ExecFn;
  candidates?: readonly string[];
  /** Default 5000. */
  timeoutMs?: number;
  log?: Logger;
}

export type RunTailscaleResult =
  | { kind: 'ok'; stdout: string }
  /** A binary ran but failed (daemon stopped, timeout, non-zero exit). */
  | { kind: 'failed'; message: string }
  /** No candidate binary could be started (ENOENT everywhere): Tailscale is not installed. */
  | { kind: 'unavailable' };

/** Run `tailscale <args>` trying each candidate binary. Never throws. */
export async function runTailscale(args: readonly string[], opts: RunTailscaleOptions = {}): Promise<RunTailscaleResult> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let failure: string | null = null;
  for (const bin of opts.candidates ?? TAILSCALE_CANDIDATES) {
    if (path.isAbsolute(bin) && !existsSync(bin)) continue;
    const r = await exec(bin, args, timeoutMs);
    if (r.ok) return { kind: 'ok', stdout: r.stdout };
    opts.log?.debug('tailscale %s via %s failed: %s', args.join(' '), bin, r.message);
    if (r.code !== 'ENOENT') failure = r.message;
  }
  return failure === null ? { kind: 'unavailable' } : { kind: 'failed', message: failure };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `tailscale status --json` → Self.DNSName without the trailing dot, or null when unavailable. */
export async function tailscaleDnsName(opts: RunTailscaleOptions = {}): Promise<string | null> {
  const r = await runTailscale(['status', '--json'], { ...opts, timeoutMs: opts.timeoutMs ?? 3000 });
  if (r.kind !== 'ok') return null;
  try {
    const json: unknown = JSON.parse(r.stdout);
    const self = isRecord(json) ? json.Self : undefined;
    const name = isRecord(self) ? self.DNSName : undefined;
    return typeof name === 'string' && name ? name.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ serve status

export interface ServeMapping {
  /** True when the serve config proxies `https://<host>:<httpsPort>/` to this host's port. */
  published: boolean;
  /** Host part of the matching `Web` entry (the tailnet DNS name); null when nothing matched. */
  host: string | null;
}

const NONE: ServeMapping = { published: false, host: null };

/** Is `target` (a `Proxy` value such as `http://127.0.0.1:8788`) this machine's loopback on `port`? */
function proxiesToLocalPort(target: string, port: number): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  const local = h === 'localhost' || h === '[::1]' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  const p = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return local && p === port;
}

/**
 * Parse `tailscale serve status --json` (text or already-parsed) and decide whether HTTPS
 * `httpsPort` is mapped, at path `/`, to `http://127.0.0.1:<hostPort>`. Garbage → not published.
 */
export function parseServeStatus(input: unknown, hostPort: number, httpsPort = DEFAULT_TAILNET_HTTPS_PORT): ServeMapping {
  let json: unknown = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      return NONE;
    }
  }
  if (!isRecord(json) || !isRecord(json.Web)) return NONE;
  for (const [key, cfg] of Object.entries(json.Web)) {
    const m = /^(.+):(\d{1,5})$/.exec(key);
    if (!m?.[1] || Number(m[2]) !== httpsPort) continue;
    if (!isRecord(cfg) || !isRecord(cfg.Handlers)) continue;
    const root = cfg.Handlers['/'];
    if (isRecord(root) && typeof root.Proxy === 'string' && proxiesToLocalPort(root.Proxy, hostPort)) {
      return { published: true, host: m[1] };
    }
  }
  return NONE;
}

// ------------------------------------------------------------------ periodic checker

/** What /api/health reports under `tailnet`. */
export interface TailnetStatus {
  published: boolean;
  /** `https://<dnsname>:<httpsPort>` when the DNS name is known, else null. */
  url: string | null;
  /** Host clock, ms, when the CLI was last consulted. */
  checkedAt: number;
}

export interface TailnetCheckerOptions {
  /** The port this host listens on; the serve config has to proxy to it. */
  hostPort: number;
  /** HTTPS port `tailscale serve` exposes. Default 8443. */
  httpsPort?: number;
  /** Tailnet DNS name when already known (from `tailscaleDnsName`); the serve config's host is the fallback. */
  dnsName?: () => string | null;
  /** Re-check interval. Default 60 000. */
  intervalMs?: number;
  /** CLI timeout per call. Default 5000. */
  timeoutMs?: number;
  exec?: ExecFn;
  candidates?: readonly string[];
  now?: () => number;
  log?: Logger;
}

/**
 * Runs `tailscale serve status --json` once at `start()` (fire-and-forget) and then every
 * `intervalMs`, caching the result for /api/health. `status` is null until the first check
 * finishes and whenever the CLI is not installed, so health simply omits the field.
 */
export class TailnetChecker {
  private readonly hostPort: number;
  private readonly httpsPort: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private current: TailnetStatus | null = null;
  private cliMissing = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly opts: TailnetCheckerOptions) {
    this.hostPort = opts.hostPort;
    this.httpsPort = opts.httpsPort ?? DEFAULT_TAILNET_HTTPS_PORT;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Cached result; null before the first check completes or when the tailscale CLI is missing. */
  get status(): TailnetStatus | null {
    return this.cliMissing ? null : this.current;
  }

  /** True once a check found no tailscale binary at all. */
  get unavailable(): boolean {
    return this.cliMissing;
  }

  /** Run one check now (shared with any check already in flight). Never rejects. */
  check(): Promise<void> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const r = await runTailscale(['serve', 'status', '--json'], {
      exec: this.opts.exec,
      candidates: this.opts.candidates,
      timeoutMs: this.opts.timeoutMs ?? 5000,
      log: this.opts.log,
    });
    const checkedAt = this.now();
    if (r.kind === 'unavailable') {
      if (!this.cliMissing) this.opts.log?.debug('tailscale CLI not found; tailnet publication unknown');
      this.cliMissing = true;
      this.current = null;
      return;
    }
    this.cliMissing = false;
    const mapping = r.kind === 'ok' ? parseServeStatus(r.stdout, this.hostPort, this.httpsPort) : NONE;
    const name = this.opts.dnsName?.() ?? mapping.host;
    const next: TailnetStatus = { published: mapping.published, url: name ? `https://${name}:${this.httpsPort}` : null, checkedAt };
    if (this.current?.published !== next.published) {
      this.opts.log?.info('tailnet publication: %s', next.published ? `${next.url ?? 'https://?'} → 127.0.0.1:${this.hostPort}` : 'not published');
    }
    this.current = next;
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
