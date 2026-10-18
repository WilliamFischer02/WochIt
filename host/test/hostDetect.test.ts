import { describe, expect, it } from 'vitest';
import { clientAddress, isLocalAddress, isLoopback, normalizeAddress, ownAddresses, resolveMode } from '../src/net/hostDetect.js';

const OWN = ['127.0.0.1', '::1', '192.168.0.180', '100.118.59.101', 'fd7a:115c:a1e0::b734:3b66', 'fe80::1%12'];

describe('normalizeAddress', () => {
  it('collapses IPv4-mapped IPv6 to IPv4', () => {
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('::FFFF:192.168.0.180')).toBe('192.168.0.180');
    expect(normalizeAddress('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(normalizeAddress('::ffff:c0a8:b4')).toBe('192.168.0.180');
  });
  it('strips brackets, ports and zone ids', () => {
    expect(normalizeAddress('[::1]:51234')).toBe('::1');
    expect(normalizeAddress('[fd7a:115c:a1e0::b734:3b66]')).toBe('fd7a:115c:a1e0::b734:3b66');
    expect(normalizeAddress('10.0.0.5:8080')).toBe('10.0.0.5');
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1');
  });
  it('canonicalises IPv6 spelling', () => {
    expect(normalizeAddress('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(normalizeAddress('FD7A:115C:A1E0:0:0:0:B734:3B66')).toBe('fd7a:115c:a1e0::b734:3b66');
  });
  it('returns null for empty input and passes hostnames through lowercased', () => {
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress('   ')).toBeNull();
    expect(normalizeAddress('William-Desktop.tail2ac207.ts.net')).toBe('william-desktop.tail2ac207.ts.net');
  });
});

describe('isLoopback', () => {
  it('matches 127/8 and ::1 in any spelling', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.255.0.9')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('[::1]:4000')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isLoopback('128.0.0.1')).toBe(false);
    expect(isLoopback('100.118.59.101')).toBe(false);
    expect(isLoopback(null)).toBe(false);
  });
});

describe('isLocalAddress (ARCHITECTURE § Host detection)', () => {
  it('direct loopback peer, no XFF → local', () => {
    expect(isLocalAddress('127.0.0.1', undefined, OWN)).toBe(true);
    expect(isLocalAddress('::1', undefined, OWN)).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1', undefined, OWN)).toBe(true);
  });
  it('direct peer is one of our own interfaces (LAN or Tailscale) → local', () => {
    expect(isLocalAddress('192.168.0.180', undefined, OWN)).toBe(true);
    expect(isLocalAddress('100.118.59.101', undefined, OWN)).toBe(true);
    expect(isLocalAddress('::ffff:100.118.59.101', undefined, OWN)).toBe(true);
    expect(isLocalAddress('fd7a:115c:a1e0::b734:3b66', undefined, OWN)).toBe(true);
    expect(isLocalAddress('FD7A:115C:A1E0:0:0:0:B734:3B66', undefined, OWN)).toBe(true);
  });
  it('direct remote peer → not local', () => {
    expect(isLocalAddress('100.90.1.2', undefined, OWN)).toBe(false);
    expect(isLocalAddress('203.0.113.7', undefined, OWN)).toBe(false);
  });
  it('WOCHIT_HOST_ADDRS extras count as local', () => {
    expect(isLocalAddress('100.90.1.2', undefined, OWN, ['100.90.1.2'])).toBe(true);
    expect(isLocalAddress('127.0.0.1', '100.90.1.2', OWN, ['100.90.1.2'])).toBe(true);
    expect(isLocalAddress('100.90.1.3', undefined, OWN, ['100.90.1.2'])).toBe(false);
  });

  describe('behind tailscale serve (peer is loopback, real client in X-Forwarded-For)', () => {
    it('remote guest through the proxy → not local', () => {
      expect(isLocalAddress('127.0.0.1', '100.90.1.2', OWN)).toBe(false);
    });
    it('host PC browser through the proxy (its own Tailscale IP) → local', () => {
      expect(isLocalAddress('127.0.0.1', '100.118.59.101', OWN)).toBe(true);
      expect(isLocalAddress('127.0.0.1', 'fd7a:115c:a1e0::b734:3b66', OWN)).toBe(true);
    });
    it('host PC browser through the proxy via loopback → local', () => {
      expect(isLocalAddress('127.0.0.1', '127.0.0.1', OWN)).toBe(true);
    });
    it('unwraps exactly one hop: the LAST entry (the one the trusted proxy appended)', () => {
      // A remote guest sent her own forged "X-Forwarded-For: 127.0.0.1"; the proxy appended her real IP.
      expect(isLocalAddress('127.0.0.1', '127.0.0.1, 100.90.1.2', OWN)).toBe(false);
      expect(isLocalAddress('127.0.0.1', ['127.0.0.1', '100.90.1.2'], OWN)).toBe(false);
      // Header arrays (Node joins repeated headers) behave the same.
      expect(isLocalAddress('127.0.0.1', ['100.118.59.101'], OWN)).toBe(true);
    });
    it('garbage or empty XFF behind loopback falls back to the loopback peer', () => {
      expect(isLocalAddress('127.0.0.1', '', OWN)).toBe(true);
      expect(isLocalAddress('127.0.0.1', ' , ', OWN)).toBe(true);
    });
  });

  describe('spoofing: XFF is ignored unless the direct peer is loopback', () => {
    it('a remote peer claiming to be loopback via XFF stays remote', () => {
      expect(isLocalAddress('100.90.1.2', '127.0.0.1', OWN)).toBe(false);
      expect(isLocalAddress('203.0.113.7', '100.118.59.101', OWN)).toBe(false);
    });
    it('a LAN peer (local anyway) with an XFF claiming remote stays local — the header is not consulted', () => {
      expect(isLocalAddress('192.168.0.180', '100.90.1.2', OWN)).toBe(true);
    });
  });

  it('clientAddress reports the effective address used for rate limiting', () => {
    expect(clientAddress('127.0.0.1', '100.90.1.2')).toBe('100.90.1.2');
    expect(clientAddress('100.90.1.2', '127.0.0.1')).toBe('100.90.1.2');
    expect(clientAddress('::ffff:10.1.1.1', undefined)).toBe('10.1.1.1');
    expect(clientAddress(undefined, undefined)).toBeNull();
  });
});

describe('resolveMode table', () => {
  it.each([
    ['auto', true, true, false],
    ['auto', false, false, false],
    ['host', true, true, false],
    ['host', false, false, true],
    ['guest', true, false, false],
    ['guest', false, false, false],
  ] as const)('mode=%s local=%s → isHost=%s notHost=%s', (mode, local, isHost, notHost) => {
    expect(resolveMode(mode, local)).toEqual({ isHost, notHost });
  });
});

describe('ownAddresses', () => {
  it('includes loopback and only normalised addresses', () => {
    const own = ownAddresses();
    expect(own).toContain('127.0.0.1');
    for (const a of own) expect(a).toBe(normalizeAddress(a));
  });
});
