// VLC bridge: polls VLC's Lua HTTP interface (/requests/status.json, /requests/playlist.json),
// translates room controls into VLC commands, and can launch VLC on a file. VLC is the master
// clock whenever the room follows it (CLAUDE.md rule 6); this module only reads and relays.
//
// Field names follow VLC 3.0.21's lua/http/requests/README.txt and the captured fixtures under
// host/test/fixtures/vlc/.
import { spawn } from 'node:child_process';
import type { Logger } from '../media/index.js';

export type VlcPlayState = 'playing' | 'paused' | 'stopped' | 'unknown';

/** What status.json tells us, already typed. */
export interface VlcStatus {
  state: VlcPlayState;
  /** 0..1 fraction of the current item. */
  position: number;
  /** Whole seconds; VLC never reports fractions here. */
  lengthSec: number;
  timeSec: number;
  /** `information.category.meta.filename`, when an item is loaded. */
  filename: string | null;
  volume: number | null;
  rate: number | null;
}

export interface VlcPlaylistItem {
  id: string;
  name: string;
  uri: string;
  /** Windows path decoded from a file: URI, or null for non-file inputs. */
  path: string | null;
  duration: number | null;
  current: boolean;
}

export interface VlcPlaylist {
  items: VlcPlaylistItem[];
  current: VlcPlaylistItem | null;
}

/** What the bridge emits every poll (and once when connectivity flips). */
export interface VlcStatusEvent {
  connected: boolean;
  state: VlcPlayState;
  playing: boolean;
  /** 0..1 fraction as VLC reports it. */
  position: number;
  /** position × (probe duration when known, else VLC's whole-second length). */
  positionSec: number;
  lengthSec: number;
  /** Absolute path of the file VLC has open, when it is a local file. */
  path: string | null;
  filename: string | null;
  /** Host clock when the status was read. */
  at: number;
}

/** The surface the room depends on; the test fake implements the same thing. */
export interface VlcBridgeLike {
  /** False when no VLC is configured at all (no exe, no password); then nothing is ever polled. */
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly latest: VlcStatusEvent | null;
  onStatus(cb: (s: VlcStatusEvent) => void): () => void;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(sec: number): Promise<void>;
  /** Spawn VLC with the file, detached so it outlives the host process. */
  launch(filePath: string): Promise<void>;
  /** Tell the bridge the probed duration of a file so positionSec gets sub-second precision. */
  setDurationHint(filePath: string, durationSec: number): void;
  start(): void;
  stop(): void;
}

// ------------------------------------------------------------------ parsing

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toPlayState(v: unknown): VlcPlayState {
  return v === 'playing' || v === 'paused' || v === 'stopped' ? v : 'unknown';
}

/** Parse `/requests/status.json`. Returns null when the document is not a VLC status at all. */
export function parseStatus(json: unknown): VlcStatus | null {
  if (!isRecord(json) || !('state' in json)) return null;
  const position = Math.min(1, Math.max(0, num(json.position) ?? 0));
  let filename: string | null = null;
  const info = json.information;
  if (isRecord(info) && isRecord(info.category)) {
    const meta = info.category.meta;
    if (isRecord(meta)) filename = str(meta.filename);
  }
  return {
    state: toPlayState(json.state),
    position,
    lengthSec: Math.max(0, num(json.length) ?? 0),
    timeSec: Math.max(0, num(json.time) ?? 0),
    filename,
    volume: num(json.volume),
    rate: num(json.rate),
  };
}

/**
 * `file:///C:/Users/x/a%20b.mp4` → `C:\Users\x\a b.mp4`; `file://server/share/x` → `\\server\share\x`;
 * posix `file:///home/x` → `/home/x`. Anything that is not a file URI → null.
 */
export function vlcUriToPath(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  let p: string;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (url.hostname && url.hostname !== 'localhost') return `\\\\${url.hostname}${p.replace(/\//g, '\\')}`;
  if (/^\/[A-Za-z]:(\/|$)/.test(p)) return p.slice(1).replace(/\//g, '\\');
  return p;
}

/** Parse `/requests/playlist.json`: flatten the tree, find the item flagged `current`. */
export function parsePlaylist(json: unknown): VlcPlaylist {
  const items: VlcPlaylistItem[] = [];
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.type === 'leaf' && typeof node.uri === 'string') {
      const uri = node.uri;
      items.push({
        id: String(node.id ?? ''),
        name: str(node.name) ?? '',
        uri,
        path: vlcUriToPath(uri),
        duration: num(node.duration),
        current: node.current === 'current' || node.current === true,
      });
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  walk(json);
  return { items, current: items.find((i) => i.current) ?? null };
}

// ------------------------------------------------------------------ the bridge

export interface VlcBridgeOptions {
  exe: string;
  host?: string;
  port: number;
  password: string;
  /** Poll interval while connected. Default 250. */
  pollMs?: number;
  /** Poll interval while VLC is unreachable. Default 1000. */
  idlePollMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: Logger;
  /** False disables the bridge entirely (no exe and no password configured). */
  enabled?: boolean;
}

const FAILURES_BEFORE_DISCONNECT = 3;

export class VlcBridge implements VlcBridgeLike {
  readonly enabled: boolean;
  private readonly exe: string;
  private readonly base: string;
  private readonly auth: string;
  private readonly pollMs: number;
  private readonly idlePollMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger | null;
  private readonly port: number;
  private readonly password: string;
  private readonly durations = new Map<string, number>();
  private readonly listeners = new Set<(s: VlcStatusEvent) => void>();

  private _connected = false;
  private _latest: VlcStatusEvent | null = null;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;

  constructor(opts: VlcBridgeOptions) {
    this.exe = opts.exe;
    this.port = opts.port;
    this.password = opts.password;
    this.base = `http://${opts.host ?? '127.0.0.1'}:${opts.port}`;
    this.auth = `Basic ${Buffer.from(`:${opts.password}`, 'utf8').toString('base64')}`;
    this.pollMs = opts.pollMs ?? 250;
    this.idlePollMs = opts.idlePollMs ?? 1000;
    this.timeoutMs = opts.requestTimeoutMs ?? 1500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? null;
    this.enabled = opts.enabled ?? (opts.exe !== '' || opts.password !== '');
  }

  get connected(): boolean {
    return this._connected;
  }

  get latest(): VlcStatusEvent | null {
    return this._latest;
  }

  onStatus(cb: (s: VlcStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  setDurationHint(filePath: string, durationSec: number): void {
    if (durationSec > 0) this.durations.set(normPath(filePath), durationSec);
  }

  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One poll cycle; exposed so tests can drive it without timers. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const statusJson = await this.getJson('/requests/status.json');
      const status = parseStatus(statusJson);
      if (!status) throw new Error('status.json is not a VLC status document');
      let path: string | null = null;
      let filename = status.filename;
      if (status.state !== 'stopped' || status.filename) {
        try {
          const pl = parsePlaylist(await this.getJson('/requests/playlist.json'));
          if (pl.current) {
            path = pl.current.path;
            filename = filename ?? pl.current.name;
          }
        } catch (err) {
          this.log?.debug('vlc playlist.json failed: %s', errMsg(err));
          path = this._latest?.path ?? null;
        }
      }
      this.failures = 0;
      const became = !this._connected;
      this._connected = true;
      const duration = path ? this.durations.get(normPath(path)) : undefined;
      const ev: VlcStatusEvent = {
        connected: true,
        state: status.state,
        playing: status.state === 'playing',
        position: status.position,
        positionSec: status.position * (duration ?? status.lengthSec),
        lengthSec: status.lengthSec,
        path,
        filename,
        at: this.now(),
      };
      this._latest = ev;
      if (became) this.log?.info('VLC connected on %s', this.base);
      this.emit(ev);
    } catch (err) {
      this.failures++;
      if (this._connected && this.failures >= FAILURES_BEFORE_DISCONNECT) {
        this._connected = false;
        this.log?.warn('VLC unreachable (%s)', errMsg(err));
        const ev: VlcStatusEvent = {
          connected: false,
          state: 'unknown',
          playing: false,
          position: 0,
          positionSec: 0,
          lengthSec: 0,
          path: null,
          filename: null,
          at: this.now(),
        };
        this._latest = ev;
        this.emit(ev);
      }
    } finally {
      this.polling = false;
    }
  }

  async play(): Promise<void> {
    await this.command('pl_forceresume');
  }

  async pause(): Promise<void> {
    await this.command('pl_forcepause');
  }

  async seek(sec: number): Promise<void> {
    await this.command('seek', { val: String(Math.max(0, Math.round(sec))) });
  }

  async launch(filePath: string): Promise<void> {
    if (!this.exe) throw new Error('VLC executable not configured');
    const args = [
      '--extraintf',
      'http',
      '--http-host',
      '127.0.0.1',
      '--http-port',
      String(this.port),
      '--http-password',
      this.password,
      '--no-video-title-show',
      filePath,
    ];
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(this.exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      child.once('spawn', () => {
        if (!settled) {
          settled = true;
          child.unref();
          this.log?.info('launched VLC (pid %d) with %s', child.pid ?? -1, filePath);
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------- internals

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedule(this._connected ? this.pollMs : this.idlePollMs));
    }, ms);
    this.timer.unref?.();
  }

  private emit(ev: VlcStatusEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch (err) {
        this.log?.error('vlc status listener threw: %s', errMsg(err));
      }
    }
  }

  private async getJson(pathname: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${pathname}`, {
      headers: { Authorization: this.auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`VLC ${pathname} → HTTP ${res.status}`);
    return (await res.json()) as unknown;
  }

  private async command(command: string, params: Record<string, string> = {}): Promise<void> {
    const q = new URLSearchParams({ command, ...params });
    const res = await this.fetchImpl(`${this.base}/requests/status.json?${q.toString()}`, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`VLC command ${command} → HTTP ${res.status}`);
    // The command response is a status document; swallow the body so the socket is reused.
    await res.arrayBuffer().catch(() => undefined);
  }
}

function normPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
