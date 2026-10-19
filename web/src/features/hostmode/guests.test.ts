import { describe, expect, it } from 'vitest';
import type { Member, MemberTelemetry } from '@wochit/shared';
import { describeDrift, driftTone, guestRows, guestState, renditionLabel } from './guests';

describe('driftTone / describeDrift', () => {
  it('colours by absolute drift: ok < 0.3, warn < 1.0, bad otherwise', () => {
    expect(driftTone(0)).toBe('ok');
    expect(driftTone(0.29)).toBe('ok');
    expect(driftTone(-0.29)).toBe('ok');
    expect(driftTone(0.3)).toBe('warn');
    expect(driftTone(-0.99)).toBe('warn');
    expect(driftTone(1.0)).toBe('bad');
    expect(driftTone(-4.2)).toBe('bad');
  });
  it('spells the sign and direction with one decimal', () => {
    expect(describeDrift(0.64)).toEqual({ tone: 'warn', text: '+0.6s ahead' });
    expect(describeDrift(-1.25)).toEqual({ tone: 'bad', text: '−1.3s behind' });
    expect(describeDrift(-0.04)).toEqual({ tone: 'ok', text: '0.0s' });
    expect(describeDrift(0.2)).toEqual({ tone: 'ok', text: '+0.2s ahead' });
  });
});

describe('guestState / renditionLabel', () => {
  const base = { position: 1, bufferedAheadSec: 3, rendition: '720p' as const, rttMs: 20 };
  it('stalled beats playing', () => {
    expect(guestState({ ...base, playing: true, stalled: false })).toBe('playing');
    expect(guestState({ ...base, playing: false, stalled: false })).toBe('paused');
    expect(guestState({ ...base, playing: false, stalled: true })).toBe('stalled');
  });
  it('labels renditions for humans', () => {
    expect(renditionLabel('720p')).toBe('720p');
    expect(renditionLabel('auto')).toBe('Auto');
    expect(renditionLabel('native')).toBe('Native');
    expect(renditionLabel(null)).toBe('—');
  });
});

describe('guestRows', () => {
  const members: Member[] = [
    { id: 'h', nick: 'William', isHost: true, typing: false },
    { id: 'g1', nick: 'Mia', isHost: false, typing: false },
    { id: 'g2', nick: 'Sam', isHost: false, typing: false },
  ];
  const report = (id: string, at: number): MemberTelemetry => ({ id, position: 10, playing: true, bufferedAheadSec: 5, rendition: '720p', stalled: false, rttMs: 30, driftSec: 0.1, at });

  it('joins telemetry with presence nicks and lists silent guests after', () => {
    const rows = guestRows(members, [report('g1', 100_000)], 102_000);
    expect(rows.map((r) => [r.id, r.nick, r.telemetry !== null])).toEqual([
      ['g1', 'Mia', true],
      ['g2', 'Sam', false],
    ]);
    expect(rows[0]).toMatchObject({ ageSec: 2, stale: false });
    expect(rows[1]).toMatchObject({ ageSec: null, stale: false });
  });
  it('never lists the host, names unknown reporters "Guest", and greys reports older than 15 s', () => {
    const rows = guestRows(members, [report('gone', 80_000)], 100_000);
    expect(rows.find((r) => r.id === 'h')).toBeUndefined();
    expect(rows[0]).toMatchObject({ id: 'gone', nick: 'Guest', ageSec: 20, stale: true });
  });
  it('is empty with no guests at all', () => {
    expect(guestRows([members[0]!], [], 1)).toEqual([]);
  });
});
