// Opens the room socket, routes every server frame into the store, and sends `hello`.
import type { ClientMode, S2C } from '@wochit/shared';
import { useApp } from '../../app/store';
import { WochitSocket, wsUrlFor } from '../../lib/socket';
import { getClientId, savePref } from '../../lib/storage';

const S2C_TYPES = ['welcome', 'pong', 'state', 'media', 'chat', 'reaction', 'presence', 'transcode', 'vlc', 'telemetry', 'error'] as const satisfies readonly S2C['type'][];
// Compile-time check that the list above covers every S2C type.
type Missing = Exclude<S2C['type'], (typeof S2C_TYPES)[number]>;
const _allTypesCovered: Missing extends never ? true : never = true;
void _allTypesCovered;

export interface JoinOptions {
  hostOrigin: string;
  pin: string;
  nick: string;
  mode: ClientMode;
}

export function joinRoom(opts: JoinOptions): WochitSocket {
  const app = useApp.getState();
  app.socket?.close();
  app.setHostOrigin(opts.hostOrigin);
  app.setPin(opts.pin);
  app.setLastError(null);
  savePref('host', opts.hostOrigin);
  savePref('pin', opts.pin);
  savePref('nick', opts.nick);
  savePref('mode', opts.mode);

  const sock = new WochitSocket(wsUrlFor(opts.hostOrigin));
  for (const t of S2C_TYPES) sock.on(t, (m) => useApp.getState().applyS2C(m));
  sock.onStatus((s) => useApp.getState().setSocketStatus(s));
  app.setSocket(sock);
  sock.connect({ pin: opts.pin, nick: opts.nick, clientId: getClientId(), mode: opts.mode });
  return sock;
}

export function leaveRoom(): void {
  useApp.getState().reset();
}

/** "host:8443" → "https://host:8443"; bare localhost gets http. Returns null when unparsable. */
export function normalizeHostOrigin(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${/^(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(raw) ? 'http' : 'https'}://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function parseMode(v: string | null | undefined): ClientMode | null {
  return v === 'auto' || v === 'host' || v === 'guest' ? v : null;
}
