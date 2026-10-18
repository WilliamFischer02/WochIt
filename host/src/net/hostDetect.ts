// Is this connection coming from the host PC itself? docs/ARCHITECTURE.md § Host detection.
//
// Behind `tailscale serve` every socket arrives from 127.0.0.1 with the real client in
// X-Forwarded-For. We unwrap exactly one hop (the last entry, which the trusted loopback proxy
// appended) and only when the direct peer is loopback, so a remote client cannot spoof locality
// by sending its own X-Forwarded-For.
import os from 'node:os';
import { isIP } from 'node:net';
import type { ClientMode } from '@wochit/shared';

/**
 * Canonical form of an address for comparison: brackets and ports removed, zone ids dropped,
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`, `::ffff:7f00:1`) collapsed to the IPv4, lowercase.
 * Non-IP strings (hostnames from WOCHIT_HOST_ADDRS) are returned trimmed and lowercased.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = raw.trim();
  if (!s) return null;

  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracketed?.[1]) s = bracketed[1];
  else {
    const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(s);
    if (v4port?.[1]) s = v4port[1];
  }

  s = s.toLowerCase();
  const zone = s.indexOf('%');
  if (zone > 0) s = s.slice(0, zone);

  const mappedDotted = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mappedDotted?.[1]) s = mappedDotted[1];
  else {
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (mappedHex?.[1] && mappedHex[2]) {
      const hi = Number.parseInt(mappedHex[1], 16);
      const lo = Number.parseInt(mappedHex[2], 16);
      s = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
  }

  if (isIP(s) === 6) s = compressIPv6(s);
  return s;
}

/** `0:0:0:0:0:0:0:1` → `::1`; leaves already-compressed forms alone. */
function compressIPv6(addr: string): string {
  if (addr.includes('::')) return addr;
  const groups = addr.split(':').map((g) => g.replace(/^0+(?=.)/, ''));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === '0') j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.join(':');
  const head = groups.slice(0, bestStart).join(':');
  const tail = groups.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

export function isLoopback(addr: string | null | undefined): boolean {
  const n = normalizeAddress(addr);
  if (!n) return false;
  return n === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n);
}

type ForwardedHeader = string | string[] | null | undefined;

function lastForwardedHop(xff: ForwardedHeader): string | null {
  if (!xff) return null;
  const joined = Array.isArray(xff) ? xff.join(',') : xff;
  const hops = joined
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const last = hops.at(-1);
  return last ? normalizeAddress(last) : null;
}

/**
 * The address we treat as "the client": the direct peer, or, when the direct peer is loopback
 * (a trusted local proxy such as `tailscale serve`), the last X-Forwarded-For entry.
 */
export function clientAddress(remoteAddr: string | null | undefined, xff: ForwardedHeader): string | null {
  const peer = normalizeAddress(remoteAddr);
  if (!peer) return null;
  if (isLoopback(peer)) {
    const hop = lastForwardedHop(xff);
    if (hop) return hop;
  }
  return peer;
}

/**
 * True when the effective client address is loopback, one of this machine's interface addresses
 * (including Tailscale's), or listed in `extra` (WOCHIT_HOST_ADDRS).
 */
export function isLocalAddress(
  remoteAddr: string | null | undefined,
  xff: ForwardedHeader,
  ownAddrs: Iterable<string>,
  extra: Iterable<string> = [],
): boolean {
  const client = clientAddress(remoteAddr, xff);
  if (!client) return false;
  if (isLoopback(client)) return true;
  for (const a of ownAddrs) if (normalizeAddress(a) === client) return true;
  for (const a of extra) if (normalizeAddress(a) === client) return true;
  return false;
}

/** Every address of every interface on this machine, normalised. Includes loopback and Tailscale. */
export function ownAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    if (!list) continue;
    for (const info of list) {
      const n = normalizeAddress(info.address);
      if (n) out.add(n);
    }
  }
  return [...out];
}

export interface ModeResolution {
  isHost: boolean;
  /** True when `mode: 'host'` was requested from a non-local address: guest + informational `not_host`. */
  notHost: boolean;
}

/** The table in ARCHITECTURE § Host detection. */
export function resolveMode(mode: ClientMode, local: boolean): ModeResolution {
  switch (mode) {
    case 'auto':
      return { isHost: local, notHost: false };
    case 'host':
      return local ? { isHost: true, notHost: false } : { isHost: false, notHost: true };
    case 'guest':
      return { isHost: false, notHost: false };
  }
}
