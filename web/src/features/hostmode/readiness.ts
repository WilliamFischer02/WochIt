// The readiness checklist rules: /api/health (plus the live socket's VLC and presence) → one row
// per check. Pure, so the exact wording and tones are pinned by readiness.test.ts.
import type { HealthResponse } from '@wochit/shared';

export type ReadyKey = 'host' | 'tailnet' | 'vlc' | 'encoder' | 'gif' | 'guests';
export type ReadyTone = 'ok' | 'warn' | 'bad' | 'muted';

export type ReadyAction =
  | { kind: 'copy'; text: string; label: string }
  | { kind: 'follow-vlc' }
  | { kind: 'gif-key' };

export interface ReadyRow {
  key: ReadyKey;
  label: string;
  tone: ReadyTone;
  status: string;
  action?: ReadyAction;
}

export interface ReadinessInput {
  /** Last /api/health answer; null before the first. */
  health: HealthResponse | null;
  /** A poll failed after the host had answered, or it never answered. */
  unreachable?: boolean;
  /** The address this console is open on (loopback). */
  localUrl: string;
  /** Live VLC state from the socket, fresher than the 10 s poll. */
  vlc?: { connected: boolean; following: boolean };
  /** Guests on the presence list, fresher than `health.members`. */
  presenceGuests?: number;
}

/** What to run on the host PC to publish :8443 on the tailnet (see docs/SETUP.md). */
export const PUBLISH_COMMAND = 'scripts\\publish-tailnet.ps1';
export const KLIPY_KEY_URL = 'https://partner.klipy.com';
export const GIPHY_KEY_URL = 'https://developers.giphy.com/dashboard/';

const LABELS: Record<ReadyKey, string> = {
  host: 'Host agent',
  tailnet: 'Tailscale',
  vlc: 'VLC',
  encoder: 'Encoder',
  gif: 'GIFs',
  guests: 'Guests',
};

function row(key: ReadyKey, tone: ReadyTone, status: string, action?: ReadyAction): ReadyRow {
  return action ? { key, label: LABELS[key], tone, status, action } : { key, label: LABELS[key], tone, status };
}

export function readinessRows(input: ReadinessInput): ReadyRow[] {
  const { health, localUrl } = input;
  if (!health) {
    const pending = input.unreachable ? 'Waiting for the host agent' : '…';
    return [
      row('host', input.unreachable ? 'bad' : 'muted', input.unreachable ? `Host agent not answering on ${localUrl}` : `Checking ${localUrl}…`),
      row('tailnet', 'muted', pending),
      row('vlc', 'muted', pending),
      row('encoder', 'muted', pending),
      row('gif', 'muted', pending),
      row('guests', 'muted', pending),
    ];
  }

  const rows: ReadyRow[] = [];

  rows.push(input.unreachable ? row('host', 'bad', `Host agent not answering on ${localUrl}`) : row('host', 'ok', `Host agent v${health.version} on ${localUrl}`));

  if (!health.tailnet) rows.push(row('tailnet', 'warn', 'Tailscale CLI not found on the host'));
  else if (health.tailnet.published && health.tailnet.url) rows.push(row('tailnet', 'ok', `Published: ${health.tailnet.url}`));
  else rows.push(row('tailnet', 'bad', `Not published. Run ${PUBLISH_COMMAND}`, { kind: 'copy', text: PUBLISH_COMMAND, label: 'Copy command' }));

  const vlc = input.vlc ?? { connected: health.vlc.connected, following: health.vlc.following ?? true };
  if (vlc.connected && vlc.following) rows.push(row('vlc', 'ok', 'VLC connected, room follows it'));
  else if (vlc.connected) rows.push(row('vlc', 'warn', 'VLC connected, not followed', { kind: 'follow-vlc' }));
  else rows.push(row('vlc', 'muted', 'Not running. Pick a film below and press Open in VLC'));

  const enc = health.ffmpeg.encoder;
  if (!health.ffmpeg.found) rows.push(row('encoder', 'bad', 'ffmpeg not found'));
  else if (enc && enc.includes('nvenc')) rows.push(row('encoder', 'ok', `GPU encoder ${enc}`));
  else rows.push(row('encoder', 'warn', `Software encoder ${enc ?? 'libx264'}, expect lower quality`));

  if (health.gifSearchAvailable) rows.push(row('gif', 'ok', `GIF search: ${health.gifProvider ?? 'on'}`));
  else rows.push(row('gif', 'bad', 'No key', { kind: 'gif-key' }));

  const guests = input.presenceGuests ?? health.members?.guests ?? 0;
  if (guests > 0) rows.push(row('guests', 'ok', `${guests} connected`));
  else rows.push(row('guests', 'muted', 'None yet. Open the link on your phone to test.'));

  return rows;
}

export interface ReadinessSummary {
  allOk: boolean;
  /** Rows that are not ok. */
  toFix: number;
  text: string;
}

export function readinessSummary(rows: ReadyRow[]): ReadinessSummary {
  const toFix = rows.filter((r) => r.tone !== 'ok').length;
  const allOk = rows.length > 0 && toFix === 0;
  return { allOk, toFix, text: allOk ? 'All set' : `${toFix} ${toFix === 1 ? 'thing' : 'things'} to fix` };
}
