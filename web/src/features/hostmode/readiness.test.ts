import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '@wochit/shared';
import { PUBLISH_COMMAND, readinessRows, readinessSummary, type ReadyKey } from './readiness';

const LOCAL = 'http://127.0.0.1:8788';

function health(over: Partial<HealthResponse> = {}): HealthResponse {
  return {
    ok: true,
    version: '0.1.0',
    protocol: 1,
    source: 'vlc',
    vlc: { connected: true, following: true },
    ffmpeg: { found: true, encoder: 'h264_nvenc' },
    gifSearchAvailable: true,
    gifProvider: 'klipy',
    tailnet: { published: true, url: 'https://pc.tail.ts.net:8443', checkedAt: 1 },
    members: { hosts: 1, guests: 1 },
    ...over,
  };
}

function byKey(rows: ReturnType<typeof readinessRows>) {
  return Object.fromEntries(rows.map((r) => [r.key, r])) as Record<ReadyKey, (typeof rows)[number]>;
}

describe('readinessRows', () => {
  it('always yields the six checks in order', () => {
    expect(readinessRows({ health: null, localUrl: LOCAL }).map((r) => r.key)).toEqual(['host', 'tailnet', 'vlc', 'encoder', 'gif', 'guests']);
    expect(readinessRows({ health: health(), localUrl: LOCAL }).map((r) => r.key)).toEqual(['host', 'tailnet', 'vlc', 'encoder', 'gif', 'guests']);
  });

  it('is all green for a published, GPU, keyed host with a guest', () => {
    const r = byKey(readinessRows({ health: health(), localUrl: LOCAL }));
    expect(r.host).toMatchObject({ tone: 'ok', status: 'Host agent v0.1.0 on http://127.0.0.1:8788' });
    expect(r.tailnet).toMatchObject({ tone: 'ok', status: 'Published: https://pc.tail.ts.net:8443' });
    expect(r.vlc).toMatchObject({ tone: 'ok', status: 'VLC connected, room follows it' });
    expect(r.encoder).toMatchObject({ tone: 'ok', status: 'GPU encoder h264_nvenc' });
    expect(r.gif).toMatchObject({ tone: 'ok', status: 'GIF search: klipy' });
    expect(r.guests).toMatchObject({ tone: 'ok', status: '1 connected' });
    expect(readinessSummary(readinessRows({ health: health(), localUrl: LOCAL }))).toEqual({ allOk: true, toFix: 0, text: 'All set' });
  });

  it('host: bad with a muted rest before the first answer fails, muted "checking" otherwise', () => {
    const checking = byKey(readinessRows({ health: null, localUrl: LOCAL }));
    expect(checking.host).toMatchObject({ tone: 'muted', status: 'Checking http://127.0.0.1:8788…' });
    const gone = byKey(readinessRows({ health: null, unreachable: true, localUrl: LOCAL }));
    expect(gone.host).toMatchObject({ tone: 'bad', status: 'Host agent not answering on http://127.0.0.1:8788' });
    const dropped = byKey(readinessRows({ health: health(), unreachable: true, localUrl: LOCAL }));
    expect(dropped.host.tone).toBe('bad');
  });

  it('tailnet: not published gets a copyable publish command; no CLI is a warning', () => {
    const bad = byKey(readinessRows({ health: health({ tailnet: { published: false, url: null, checkedAt: 1 } }), localUrl: LOCAL }));
    expect(bad.tailnet).toEqual({
      key: 'tailnet',
      label: 'Tailscale',
      tone: 'bad',
      status: 'Not published. Run scripts\\publish-tailnet.ps1',
      action: { kind: 'copy', text: PUBLISH_COMMAND, label: 'Copy command' },
    });
    const warn = byKey(readinessRows({ health: health({ tailnet: undefined }), localUrl: LOCAL }));
    expect(warn.tailnet).toMatchObject({ tone: 'warn', status: 'Tailscale CLI not found on the host' });
  });

  it('vlc: connected-not-followed offers Follow; not connected is muted; live socket state wins', () => {
    const warn = byKey(readinessRows({ health: health(), localUrl: LOCAL, vlc: { connected: true, following: false } }));
    expect(warn.vlc).toMatchObject({ tone: 'warn', status: 'VLC connected, not followed', action: { kind: 'follow-vlc' } });
    const off = byKey(readinessRows({ health: health(), localUrl: LOCAL, vlc: { connected: false, following: true } }));
    expect(off.vlc).toMatchObject({ tone: 'muted', status: 'Not running. Pick a film below and press Open in VLC' });
    const fromHealth = byKey(readinessRows({ health: health({ vlc: { connected: false } }), localUrl: LOCAL }));
    expect(fromHealth.vlc.tone).toBe('muted');
  });

  it('encoder: software is a warning, missing ffmpeg is bad', () => {
    const soft = byKey(readinessRows({ health: health({ ffmpeg: { found: true, encoder: 'libx264' } }), localUrl: LOCAL }));
    expect(soft.encoder).toMatchObject({ tone: 'warn', status: 'Software encoder libx264, expect lower quality' });
    const none = byKey(readinessRows({ health: health({ ffmpeg: { found: false, encoder: null } }), localUrl: LOCAL }));
    expect(none.encoder).toMatchObject({ tone: 'bad', status: 'ffmpeg not found' });
  });

  it('gif: no key is bad with the inline key form', () => {
    const r = byKey(readinessRows({ health: health({ gifSearchAvailable: false, gifProvider: null }), localUrl: LOCAL }));
    expect(r.gif).toMatchObject({ tone: 'bad', status: 'No key', action: { kind: 'gif-key' } });
    const legacy = byKey(readinessRows({ health: health({ gifProvider: undefined }), localUrl: LOCAL }));
    expect(legacy.gif).toMatchObject({ tone: 'ok', status: 'GIF search: on' });
  });

  it('guests: presence count beats the polled count; zero is muted', () => {
    const live = byKey(readinessRows({ health: health({ members: { hosts: 1, guests: 0 } }), localUrl: LOCAL, presenceGuests: 2 }));
    expect(live.guests).toMatchObject({ tone: 'ok', status: '2 connected' });
    const none = byKey(readinessRows({ health: health({ members: { hosts: 1, guests: 0 } }), localUrl: LOCAL }));
    expect(none.guests).toMatchObject({ tone: 'muted', status: 'None yet. Open the link on your phone to test.' });
  });

  it('summary counts every non-ok row as a thing to fix', () => {
    const rows = readinessRows({ health: health({ gifSearchAvailable: false, members: { hosts: 1, guests: 0 } }), localUrl: LOCAL, vlc: { connected: false, following: true } });
    expect(readinessSummary(rows)).toEqual({ allOk: false, toFix: 3, text: '3 things to fix' });
    const one = readinessRows({ health: health({ gifSearchAvailable: false }), localUrl: LOCAL });
    expect(readinessSummary(one).text).toBe('1 thing to fix');
  });
});
