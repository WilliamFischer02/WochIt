// Configuration: `.env` (dotenv) + CLI flags, validated with zod into a typed `Config`.
// Precedence: CLI flag > process environment > .env file > default.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { Pin } from '@wochit/shared';
import { isLogLevel, type LogLevel } from './log.js';
import { parseCorsOrigins } from './server/cors.js';

/** `host/` regardless of whether we run from `src/` (tsx) or `dist/` (node). */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EncoderChoiceSchema = z.enum(['auto', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']);
const GifProviderChoiceSchema = z.enum(['auto', 'klipy', 'giphy']);

export const ConfigSchema = z.object({
  /** TCP port for HTTP + WebSocket + HLS + the web app. */
  port: z.number().int().min(1).max(65535),
  /** Interface to bind. Default 127.0.0.1: `tailscale serve` proxies to loopback and Windows never
   *  shows a firewall prompt. `0.0.0.0` opts into plain-HTTP LAN access. */
  bind: z.string().min(1),
  pin: Pin,
  /** True when no PIN was configured and one was generated for this run. */
  pinGenerated: z.boolean(),
  cacheDir: z.string().min(1),
  cacheMaxBytes: z.number().nonnegative(),
  /** Absolute media roots the host may browse. */
  roots: z.array(z.string().min(1)),
  ffmpegPath: z.string(),
  ffprobePath: z.string(),
  encoder: EncoderChoiceSchema,
  vlc: z.object({
    /** Absolute path of vlc.exe, or '' when none was found. */
    exe: z.string(),
    httpPort: z.number().int().min(1).max(65535),
    /** Password for VLC's HTTP interface. Generated per run when unset so launched VLCs still work. */
    httpPassword: z.string().min(1),
    /** True when the password came from configuration (a hand-started VLC can be reached). */
    passwordConfigured: z.boolean(),
  }),
  gif: z.object({
    /** auto: Klipy if it has a key, else GIPHY if it has one, else off. */
    provider: z.enum(['auto', 'klipy', 'giphy']),
    klipyKey: z.string().nullable(),
    giphyKey: z.string().nullable(),
  }),
  /** Extra addresses that count as the host PC (WOCHIT_HOST_ADDRS), normalised later. */
  hostAddrs: z.array(z.string().min(1)),
  /** Origins allowed to call /api and /media and open the WebSocket cross-origin (WOCHIT_CORS_ORIGINS). */
  corsOrigins: z.array(z.string().min(1)),
  /** Directory holding the built web app (index.html, assets/). */
  webDir: z.string().min(1),
  /** Where chat logs go. */
  logsDir: z.string().min(1),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  /** DEV ONLY: use the in-memory fake media service instead of the real pipeline. */
  fakeMedia: z.boolean(),
  version: z.string(),
  packageDir: z.string(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const USAGE = `WochIt host agent

Usage: wochit-host [options]

  --port <n>         Port to listen on (WOCHIT_PORT, default 8788)
  --bind <addr>      Interface to bind (WOCHIT_BIND, default 127.0.0.1; 0.0.0.0 for LAN access)
  --pin <digits>     Room PIN, 4-8 digits (WOCHIT_PIN; generated if unset)
  --roots <a;b;c>    Media roots separated by ";" (WOCHIT_MEDIA_ROOTS)
  --cache <dir>      HLS cache directory (WOCHIT_CACHE_DIR)
  --web-dir <dir>    Built web app directory (default ../web/dist)
  --verbose, -v      Debug logging (WOCHIT_LOG_LEVEL=debug)
  --fake-media       DEV ONLY: in-memory fake media service, no ffmpeg
  --help, -h         This text
`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** CLI arguments without the node/script prefix. Default: process.argv.slice(2). */
  argv?: string[];
  /** Environment to read. Default: a copy of process.env overlaid by .env files. */
  env?: NodeJS.ProcessEnv;
  /** Read .env files (cwd/.env then <repo>/.env). Default true. Tests turn it off. */
  dotenv?: boolean;
  packageDir?: string;
  cwd?: string;
}

function parseIntStrict(name: string, raw: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  return Number.parseInt(raw.trim(), 10);
}

function parseNumber(name: string, raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a number, got "${raw}"`);
  return n;
}

export function generatePin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function splitRoots(raw: string | undefined, cwd: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(';')) {
    const trimmed = part.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) continue;
    const abs = path.resolve(cwd, trimmed);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

const VLC_CANDIDATES = [
  'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
  'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
];

function findVlc(configured: string | undefined): string {
  if (configured && configured.trim()) return path.resolve(configured.trim());
  for (const c of VLC_CANDIDATES) if (existsSync(c)) return c;
  return '';
}

function readVersion(packageDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Throws ConfigError with a readable message on any invalid value; `--help` throws too (caller prints USAGE). */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const packageDir = opts.packageDir ?? PACKAGE_DIR;
  const repoDir = path.resolve(packageDir, '..');
  const cwd = opts.cwd ?? process.cwd();

  let env: NodeJS.ProcessEnv;
  if (opts.env) {
    env = { ...opts.env };
  } else {
    env = { ...process.env };
    if (opts.dotenv !== false) {
      const candidates = [path.join(cwd, '.env'), path.join(repoDir, '.env')].filter((p, i, a) => a.indexOf(p) === i);
      const existing = candidates.filter((p) => existsSync(p));
      if (existing.length) loadDotenv({ path: existing, processEnv: env, quiet: true });
    }
  }

  let parsed: ReturnType<typeof parseArgs<{ options: typeof FLAGS; strict: true; allowPositionals: false }>>;
  try {
    parsed = parseArgs({ args: opts.argv ?? process.argv.slice(2), options: FLAGS, strict: true, allowPositionals: false });
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  const flags = parsed.values;
  if (flags.help) throw new ConfigError('help');

  const portRaw = flags.port ?? env.WOCHIT_PORT ?? '8788';
  const pinRaw = (flags.pin ?? env.WOCHIT_PIN ?? '').trim();
  const pinGenerated = pinRaw === '';
  const pin = pinGenerated ? generatePin() : pinRaw;
  if (!Pin.safeParse(pin).success) throw new ConfigError(`PIN must be 4-8 digits, got "${pinRaw}"`);

  const cacheRaw = flags.cache ?? env.WOCHIT_CACHE_DIR ?? './.cache';
  const cacheDir = path.resolve(cwd, cacheRaw.trim());
  const cacheGb = parseNumber('WOCHIT_CACHE_MAX_GB', env.WOCHIT_CACHE_MAX_GB ?? '60');
  if (cacheGb < 0) throw new ConfigError('WOCHIT_CACHE_MAX_GB must be >= 0');

  const roots = splitRoots(flags.roots ?? env.WOCHIT_MEDIA_ROOTS, cwd);
  const encoder = EncoderChoiceSchema.safeParse((env.WOCHIT_ENCODER ?? 'auto').trim() || 'auto');
  if (!encoder.success) throw new ConfigError(`WOCHIT_ENCODER must be one of ${EncoderChoiceSchema.options.join(', ')}`);

  const vlcPasswordRaw = (env.WOCHIT_VLC_HTTP_PASSWORD ?? '').trim();
  const vlcPassword = vlcPasswordRaw || `wochit-${randomInt(0, 0x7fffffff).toString(36)}`;

  const gifProvider = GifProviderChoiceSchema.safeParse((env.WOCHIT_GIF_PROVIDER ?? 'auto').trim().toLowerCase() || 'auto');
  if (!gifProvider.success) throw new ConfigError(`WOCHIT_GIF_PROVIDER must be one of ${GifProviderChoiceSchema.options.join(', ')}`);
  const klipyKey = (env.KLIPY_API_KEY ?? '').trim();
  const giphyKey = (env.GIPHY_API_KEY ?? '').trim();
  const hostAddrs = (env.WOCHIT_HOST_ADDRS ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const webDir = path.resolve(cwd, flags['web-dir'] ?? path.join(repoDir, 'web', 'dist'));
  const envLevel = (env.WOCHIT_LOG_LEVEL ?? '').trim().toLowerCase();
  const logLevel: LogLevel = flags.verbose ? 'debug' : isLogLevel(envLevel) ? envLevel : 'info';

  const candidate = {
    port: parseIntStrict('port', portRaw),
    bind: (flags.bind ?? env.WOCHIT_BIND ?? '').trim() || '127.0.0.1',
    pin,
    pinGenerated,
    cacheDir,
    cacheMaxBytes: Math.round(cacheGb * 1024 ** 3),
    roots,
    ffmpegPath: (env.WOCHIT_FFMPEG ?? '').trim(),
    ffprobePath: (env.WOCHIT_FFPROBE ?? '').trim(),
    encoder: encoder.data,
    vlc: {
      exe: findVlc(env.WOCHIT_VLC_EXE),
      httpPort: parseIntStrict('WOCHIT_VLC_HTTP_PORT', env.WOCHIT_VLC_HTTP_PORT ?? '8089'),
      httpPassword: vlcPassword,
      passwordConfigured: vlcPasswordRaw !== '',
    },
    gif: { provider: gifProvider.data, klipyKey: klipyKey || null, giphyKey: giphyKey || null },
    hostAddrs,
    corsOrigins: parseCorsOrigins(env.WOCHIT_CORS_ORIGINS),
    webDir,
    logsDir: path.join(packageDir, 'logs'),
    logLevel,
    fakeMedia: flags['fake-media'] === true,
    version: readVersion(packageDir),
    packageDir,
  };

  const result = ConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${issues}`);
  }
  return result.data;
}

const FLAGS = {
  port: { type: 'string' },
  bind: { type: 'string' },
  pin: { type: 'string' },
  roots: { type: 'string' },
  cache: { type: 'string' },
  'web-dir': { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  'fake-media': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;
