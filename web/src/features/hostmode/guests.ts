// Rows for the guests panel: presence members joined with their latest telemetry, plus the drift
// and state vocabulary. Pure; see guests.test.ts.
import type { Member, MemberTelemetry, PlayerTelemetry } from '@wochit/shared';
import { formatDrift } from '../../lib/format';

export type DriftTone = 'ok' | 'warn' | 'bad';

/** ok under 0.3 s, warn under 1 s, bad from there (the sync policy seeks past 1 s). */
export function driftTone(driftSec: number): DriftTone {
  const abs = Math.abs(driftSec);
  if (abs < 0.3) return 'ok';
  if (abs < 1.0) return 'warn';
  return 'bad';
}

/** "+0.6s ahead" / "−1.2s behind" / "0.0s". */
export function describeDrift(driftSec: number): { tone: DriftTone; text: string } {
  const tone = driftTone(driftSec);
  const tenths = Math.round(driftSec * 10) / 10;
  if (tenths === 0) return { tone, text: '0.0s' };
  return { tone, text: `${formatDrift(driftSec)} ${driftSec < 0 ? 'behind' : 'ahead'}` };
}

export type GuestState = 'playing' | 'paused' | 'stalled';

export function guestState(t: PlayerTelemetry): GuestState {
  if (t.stalled) return 'stalled';
  return t.playing ? 'playing' : 'paused';
}

export const GUEST_STATE_LABEL: Record<GuestState, string> = { playing: 'Playing', paused: 'Paused', stalled: 'Stalled' };

export function renditionLabel(r: PlayerTelemetry['rendition']): string {
  if (r === null) return '—';
  if (r === 'auto') return 'Auto';
  if (r === 'native') return 'Native';
  return r;
}

/** A report older than this is shown greyed out. */
export const STALE_AFTER_MS = 15_000;

export interface GuestRow {
  id: string;
  nick: string;
  telemetry: MemberTelemetry | null;
  /** Seconds since the report arrived at the host, by the host's clock; null without a report. */
  ageSec: number | null;
  stale: boolean;
}

/**
 * One row per telemetry report (nick from presence, "Guest" when the member already left), then
 * one per guest on the presence list who has not reported yet.
 */
export function guestRows(members: readonly Member[], telemetry: readonly MemberTelemetry[], serverNow: number): GuestRow[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const rows: GuestRow[] = telemetry.map((t) => {
    const ageSec = Math.max(0, (serverNow - t.at) / 1000);
    return { id: t.id, nick: byId.get(t.id)?.nick ?? 'Guest', telemetry: t, ageSec, stale: ageSec * 1000 > STALE_AFTER_MS };
  });
  const reported = new Set(telemetry.map((t) => t.id));
  for (const m of members) {
    if (m.isHost || reported.has(m.id)) continue;
    rows.push({ id: m.id, nick: m.nick, telemetry: null, ageSec: null, stale: false });
  }
  return rows;
}
