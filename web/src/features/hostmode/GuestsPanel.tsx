// Every guest's player as the host sees it from telemetry: state, position, drift, buffer,
// rendition, round trip, and how fresh the report is.
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useApp } from '../../app/store';
import { formatTime } from '../../lib/format';
import { describeDrift, GUEST_STATE_LABEL, guestRows, guestState, renditionLabel, type GuestRow, type GuestState } from './guests';
import { TONE_TEXT } from './ui';

const STATE_CHIP: Record<GuestState, string> = {
  playing: 'bg-ok/15 text-ok',
  paused: 'bg-white/8 text-muted',
  stalled: 'bg-warn/15 text-warn',
};

/** Date.now(), re-read every `everyMs` so "updated n s ago" ticks. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function Stat({ label, children, testId, className }: { label: string; children: React.ReactNode; testId?: string; className?: string }) {
  return (
    <span className={clsx('tnum inline-flex items-baseline gap-1 text-sm', className)} data-testid={testId}>
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </span>
  );
}

function Row({ row }: { row: GuestRow }) {
  const t = row.telemetry;
  const drift = t ? describeDrift(t.driftSec) : null;
  const state = t ? guestState(t) : null;
  return (
    <li
      data-testid={`guest-row-${row.id}`}
      data-stale={row.stale}
      data-state={state ?? 'none'}
      className={clsx('flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2.5 motion', row.stale && 'opacity-50')}
    >
      <span className="min-w-[6rem] truncate text-sm font-semibold" data-testid={`guest-nick-${row.id}`}>
        {row.nick}
      </span>
      {t && state && drift ? (
        <>
          <span className={clsx('rounded-pill px-2 py-0.5 text-[11px] font-semibold', STATE_CHIP[state])} data-testid={`guest-state-${row.id}`}>
            {GUEST_STATE_LABEL[state]}
          </span>
          <Stat label="at" testId={`guest-position-${row.id}`}>
            {formatTime(t.position)}
          </Stat>
          <Stat label="drift" testId={`guest-drift-${row.id}`} className={TONE_TEXT[drift.tone]}>
            <span data-tone={drift.tone}>{drift.text}</span>
          </Stat>
          <Stat label="buffer" testId={`guest-buffer-${row.id}`}>
            {Math.round(t.bufferedAheadSec)} s
          </Stat>
          <Stat label="quality" testId={`guest-rendition-${row.id}`}>
            {renditionLabel(t.rendition)}
          </Stat>
          {t.rttMs !== null && (
            <Stat label="rtt" testId={`guest-rtt-${row.id}`}>
              {t.rttMs} ms
            </Stat>
          )}
          <span className="ml-auto text-xs text-muted" data-testid={`guest-age-${row.id}`}>
            updated {Math.round(row.ageSec ?? 0)}s ago
          </span>
        </>
      ) : (
        <span className="text-sm text-muted">Connected, no player yet</span>
      )}
    </li>
  );
}

export default function GuestsPanel() {
  const members = useApp((s) => s.members);
  const telemetry = useApp((s) => s.telemetry);
  const serverOffset = useApp((s) => s.serverOffset);
  const now = useNow(1000);
  const rows = guestRows(members, telemetry, now + serverOffset);

  return (
    <section className="glass rounded-xl px-4 py-3" data-testid="guests" aria-label="Guests">
      <header className="flex items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Guests</h2>
        <span className="tnum text-xs text-muted" data-testid="guests-count">
          {rows.length}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-muted" data-testid="guests-empty">
          No guest connected. Open the link on another device; it appears here within a few seconds.
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </ul>
      )}
    </section>
  );
}
