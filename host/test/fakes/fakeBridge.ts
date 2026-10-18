// A scriptable VlcBridgeLike: tests push status events and read back the commands the room sent.
import type { VlcBridgeLike, VlcStatusEvent } from '../../src/vlc/bridge.js';

export interface FakeBridgeOptions {
  enabled?: boolean;
  now?: () => number;
  /** When set, every command rejects with this error (simulates VLC gone). */
  failCommands?: Error | null;
}

export class FakeBridge implements VlcBridgeLike {
  readonly enabled: boolean;
  connected = false;
  latest: VlcStatusEvent | null = null;
  readonly commands: string[] = [];
  readonly launched: string[] = [];
  readonly durationHints = new Map<string, number>();
  failCommands: Error | null;
  started = false;
  private readonly listeners = new Set<(s: VlcStatusEvent) => void>();
  private readonly now: () => number;

  constructor(opts: FakeBridgeOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? Date.now;
    this.failCommands = opts.failCommands ?? null;
  }

  onStatus(cb: (s: VlcStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Emit a status event; `connected` defaults to true and `playing` is derived from `state`. */
  emit(partial: Partial<VlcStatusEvent> & { path?: string | null }): VlcStatusEvent {
    const state = partial.state ?? 'playing';
    const connected = partial.connected ?? true;
    const lengthSec = partial.lengthSec ?? 600;
    const position = partial.position ?? (partial.positionSec !== undefined ? partial.positionSec / lengthSec : 0);
    const path = partial.path ?? null;
    const duration = path ? this.durationHints.get(path.toLowerCase()) : undefined;
    const ev: VlcStatusEvent = {
      connected,
      state: connected ? state : 'unknown',
      playing: connected && state === 'playing',
      position,
      positionSec: partial.positionSec ?? position * (duration ?? lengthSec),
      lengthSec,
      path,
      filename: partial.filename ?? (path ? path.split(/[\\/]/).pop()! : null),
      at: partial.at ?? this.now(),
    };
    this.connected = connected;
    this.latest = ev;
    for (const cb of this.listeners) cb(ev);
    return ev;
  }

  disconnect(): VlcStatusEvent {
    return this.emit({ connected: false });
  }

  private async cmd(name: string): Promise<void> {
    this.commands.push(name);
    if (this.failCommands) throw this.failCommands;
  }

  play(): Promise<void> {
    return this.cmd('play');
  }

  pause(): Promise<void> {
    return this.cmd('pause');
  }

  seek(sec: number): Promise<void> {
    return this.cmd(`seek:${Math.round(sec)}`);
  }

  async launch(filePath: string): Promise<void> {
    this.launched.push(filePath);
    if (this.failCommands) throw this.failCommands;
  }

  setDurationHint(filePath: string, durationSec: number): void {
    this.durationHints.set(filePath.toLowerCase(), durationSec);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }
}
