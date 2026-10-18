#!/usr/bin/env node
// WochIt host agent CLI: config → media service → VLC bridge → room → HTTP + WebSocket → banner.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { FailureLimiter, mediaToken } from './auth.js';
import { ConfigError, USAGE, loadConfig, type Config } from './config.js';
import { createFakeMediaService } from './dev/fakeMediaService.js';
import { createGifService, type GifService } from './gif/index.js';
import { createLogger } from './log.js';
import { createMediaService, type MediaService } from './media/index.js';
import { isLoopback, ownAddresses } from './net/hostDetect.js';
import { Room } from './room/room.js';
import { createApp } from './server/http.js';
import { attachWebSocket } from './server/ws.js';
import { VlcBridge } from './vlc/bridge.js';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError && err.message === 'help') {
      process.stdout.write(USAGE);
      return;
    }
    process.stderr.write(`wochit-host: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const log = createLogger(config.logLevel);

  // ---- media service
  let media: MediaService;
  if (config.fakeMedia) {
    log.warn('DEV ONLY: --fake-media is active. No real files are served; playlists and segments are synthetic.');
    media = createFakeMediaService({ ffmpegFound: false, encoder: null });
  } else {
    try {
      media = createMediaService({
        ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath,
        encoder: config.encoder,
        cacheDir: config.cacheDir,
        cacheMaxBytes: config.cacheMaxBytes,
        roots: config.roots,
        log: log.child('media'),
      });
    } catch (err) {
      log.error('media service could not be created: %s', err instanceof Error ? err.message : String(err));
      log.error('(dev workaround while the pipeline is unfinished: start with --fake-media)');
      process.exitCode = 1;
      return;
    }
  }
  try {
    await media.init();
  } catch (err) {
    log.error('media service failed to initialise: %s', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // ---- VLC bridge
  const bridge = new VlcBridge({
    exe: config.vlc.exe,
    port: config.vlc.httpPort,
    password: config.vlc.httpPassword,
    log: log.child('vlc'),
    enabled: config.vlc.exe !== '' || config.vlc.passwordConfigured,
  });
  bridge.start();

  // ---- room, gif, auth
  const gif = createGifService({
    provider: config.gif.provider,
    klipyKey: config.gif.klipyKey,
    giphyKey: config.gif.giphyKey,
    warn: (m) => log.warn(m),
  });
  const token = mediaToken(config.pin);
  const limiter = new FailureLimiter();
  const own = ownAddresses();
  const room = new Room({
    media,
    bridge,
    log: log.child('room'),
    mediaToken: token,
    gifSearchAvailable: gif.available,
    chatLogDir: config.logsDir,
  });

  // ---- http + ws
  let publicUrls: string[] = [];
  const app = createApp({
    media,
    room,
    bridge,
    gif,
    log: log.child('http'),
    pin: config.pin,
    mediaToken: token,
    limiter,
    ownAddrs: own,
    extraAddrs: config.hostAddrs,
    webDir: config.webDir,
    version: config.version,
    corsOrigins: config.corsOrigins,
    urls: () => publicUrls,
  });
  const server = createServer(app);
  server.keepAliveTimeout = 65_000;
  const ws = attachWebSocket({
    server,
    room,
    pin: config.pin,
    mediaToken: token,
    limiter,
    ownAddrs: own,
    extraAddrs: config.hostAddrs,
    corsOrigins: config.corsOrigins,
    log: log.child('ws'),
  });

  try {
    await listen(server, config.port, config.bind);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    log.error('cannot listen on %s:%d: %s', config.bind, config.port, e.code === 'EADDRINUSE' ? 'port already in use' : e.message);
    await media.shutdown().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  const tailnet = await tailscaleDnsName(log);
  const urls = publicUrlsFor(config, server, tailnet);
  publicUrls = [urls.local, ...urls.lan, ...(urls.tailnet ? [urls.tailnet] : [])];
  printBanner(config, media, bridge, gif, urls);

  // ---- shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('%s received, shutting down', signal);
    const hard = setTimeout(() => {
      log.warn('shutdown timed out, exiting');
      process.exit(1);
    }, 8000);
    hard.unref();
    try {
      bridge.stop();
      room.dispose();
      await ws.closeAll(1001, 'host shutting down');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await media.shutdown();
      log.info('bye');
    } catch (err) {
      log.error('shutdown error: %s', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(hard);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** `tailscale status --json` → Self.DNSName without the trailing dot, or null when unavailable. */
async function tailscaleDnsName(log: { debug(msg: string, ...rest: unknown[]): void }): Promise<string | null> {
  const candidates = ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'];
  for (const bin of candidates) {
    if (bin.includes('\\') && !existsSync(bin)) continue;
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(bin, ['status', '--json'], { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
      const json = JSON.parse(out) as { Self?: { DNSName?: unknown }; BackendState?: unknown };
      const name = json.Self?.DNSName;
      if (typeof name === 'string' && name) return name.replace(/\.$/, '');
      return null;
    } catch (err) {
      log.debug('tailscale status via %s failed: %s', bin, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

interface PublicUrls {
  port: number;
  local: string;
  lan: string[];
  tailnet: string | null;
}

/** The origins people can open; the banner prints them and /api/health reports them. */
function publicUrlsFor(config: Config, server: Server, tailnet: string | null): PublicUrls {
  const addr = server.address() as AddressInfo | null;
  const port = addr?.port ?? config.port;
  const bindAll = config.bind === '0.0.0.0' || config.bind === '::' || config.bind === '';
  const lanIps = bindAll
    ? Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
        .map((i) => i.address)
    : isLoopback(config.bind)
      ? []
      : [config.bind];
  return {
    port,
    local: `http://127.0.0.1:${port}`,
    lan: lanIps.map((ip) => `http://${ip}:${port}`),
    tailnet: tailnet ? `https://${tailnet}:8443` : null,
  };
}

function printBanner(config: Config, media: MediaService, bridge: VlcBridge, gif: GifService, urls: PublicUrls): void {
  const { port } = urls;
  const stats = media.stats();

  const lines: string[] = [];
  lines.push('');
  lines.push(`  WochIt host v${config.version}${config.fakeMedia ? '   [DEV: fake media]' : ''}`);
  lines.push('');
  lines.push(`  Local:      ${urls.local}/`);
  for (const u of urls.lan) lines.push(`  Network:    ${u}/`);
  if (!urls.lan.length) lines.push(`  Network:    off (bound to ${config.bind}; set WOCHIT_BIND=0.0.0.0 for plain-HTTP LAN access)`);
  if (urls.tailnet) {
    lines.push(`  Tailnet:    ${urls.tailnet}/   (needs: tailscale serve --bg --https=8443 http://127.0.0.1:${port})`);
  } else {
    lines.push('  Tailnet:    tailscale CLI not found or not running');
  }
  lines.push(`  CORS:       ${config.corsOrigins.length ? config.corsOrigins.join(', ') : 'same-origin only'}`);
  lines.push('');
  lines.push(`  PIN:        ${config.pin}${config.pinGenerated ? '   (generated for this run; set WOCHIT_PIN to keep one)' : ''}`);
  lines.push(`  ffmpeg:     ${media.ffmpegFound ? `${config.ffmpegPath || '(on PATH)'} · encoder ${media.encoder ?? 'none'}` : 'NOT FOUND — transcoding disabled'}`);
  lines.push(
    `  VLC:        ${
      !bridge.enabled
        ? 'bridge disabled (no vlc.exe found, no WOCHIT_VLC_HTTP_PASSWORD)'
        : bridge.connected
          ? `connected on 127.0.0.1:${config.vlc.httpPort}`
          : `waiting on 127.0.0.1:${config.vlc.httpPort}${config.vlc.passwordConfigured ? '' : ' (password generated; only VLCs launched from WochIt will connect)'}`
    }`,
  );
  lines.push(`  GIF search: ${gif.available ? gif.provider : 'off (set KLIPY_API_KEY or GIPHY_API_KEY)'}`);
  lines.push(`  Cache:      ${config.cacheDir}  ${formatBytes(stats.cacheBytes)} used of ${formatBytes(stats.cacheMaxBytes || config.cacheMaxBytes)}`);
  if (config.roots.length) {
    lines.push('  Roots:');
    for (const r of config.roots) lines.push(`              ${r}${existsSync(r) ? '' : '   (missing)'}`);
  } else {
    lines.push('  Roots:      none configured (WOCHIT_MEDIA_ROOTS) — only files VLC opens can be served');
  }
  lines.push('');
  lines.push('  Host PC:    open the Local URL (or ?mode=host). Guests: the Tailnet URL. Ctrl+C stops.');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

void main().catch((err: unknown) => {
  process.stderr.write(`wochit-host: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
