// WebSocket client for the host. Validates every frame with the shared zod schemas, reconnects
// with backoff, and exposes typed `on(type, handler)` subscriptions. The player agent owns this
// file; the chat agent only calls `send` and `on`.
import { C2S, S2C, PROTOCOL_VERSION } from '@wochit/shared';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export type Hello = Omit<Extract<C2S, { type: 'hello' }>, 'type' | 'v'>;

type Handler<T extends S2C['type']> = (msg: Extract<S2C, { type: T }>) => void;

/** 'https://host:8443' → 'wss://host:8443/ws'. Accepts an origin with or without a path. */
export function wsUrlFor(hostOrigin: string): string {
  const u = new URL(hostOrigin, window.location.href);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Close codes after which reconnecting is pointless (see docs/PROTOCOL.md). */
const FATAL_CLOSE_CODES = new Set([4001, 4002]);

export class WochitSocket {
  private ws: WebSocket | null = null;
  private hello: Hello | null = null;
  private handlers = new Map<string, Set<(msg: S2C) => void>>();
  private statusListeners = new Set<(s: SocketStatus, closeCode?: number) => void>();
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  status: SocketStatus = 'idle';

  constructor(public readonly url: string) {}

  connect(hello: Hello): void {
    this.hello = hello;
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000);
    this.setStatus('closed');
  }

  /** Returns false when the socket is not open; callers may queue or drop. */
  send(msg: C2S): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  on<T extends S2C['type']>(type: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (msg: S2C) => void);
    this.handlers.set(type, set);
    return () => set.delete(handler as (msg: S2C) => void);
  }

  onStatus(cb: (s: SocketStatus, closeCode?: number) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(s: SocketStatus, closeCode?: number): void {
    this.status = s;
    for (const cb of this.statusListeners) cb(s, closeCode);
  }

  private open(): void {
    this.setStatus(this.backoffMs > 1000 ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 1000;
      if (this.hello) ws.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, ...this.hello } satisfies C2S));
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const res = S2C.safeParse(parsed);
      if (!res.success) return;
      const set = this.handlers.get(res.data.type);
      if (set) for (const h of set) h(res.data);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (this.closedByUser || FATAL_CLOSE_CODES.has(ev.code)) {
        this.setStatus('closed', ev.code);
        return;
      }
      this.setStatus('reconnecting', ev.code);
      this.reconnectTimer = setTimeout(() => this.open(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }
}
