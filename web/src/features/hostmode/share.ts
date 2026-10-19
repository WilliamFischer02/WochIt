// Which address to hand a guest, and the invite that goes with it. Pure; see share.test.ts.
import { buildInviteUrl, type HealthResponse } from '@wochit/shared';

/** The tailnet URL is the one he sends to his girlfriend. */
export function isTailnetUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.ts.net');
  } catch {
    return false;
  }
}

export function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}

export interface ShareTarget {
  url: string;
  /** True when `url` works off this PC (published on the tailnet). */
  tailnet: boolean;
}

/**
 * The published tailnet URL when the host says it is published; otherwise a .ts.net URL the host
 * lists when it cannot check (no tailscale CLI); otherwise the local address, flagged as such.
 */
export function pickShareUrl(health: HealthResponse | null, localUrl: string): ShareTarget {
  if (health?.tailnet) {
    if (health.tailnet.published && health.tailnet.url) return { url: health.tailnet.url, tailnet: true };
    return { url: localUrl, tailnet: false };
  }
  const listed = health?.urls?.find(isTailnetUrl);
  if (listed) return { url: listed, tailnet: true };
  return { url: localUrl, tailnet: false };
}

/** "https://william-desktop.tail2ac207.ts.net:8443" → "william-desktop" (the Tailscale machine name). */
export function machineName(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const first = host.split('.')[0];
    return first && !/^\d+$/.test(first) && first !== 'localhost' ? first : null;
  } catch {
    return null;
  }
}

export interface InviteInput {
  /** The published tailnet origin the guest will open once Tailscale is on. */
  tailnetUrl: string;
  /** The Tailscale "share this machine" link, when stored. */
  shareLink: string | null;
  /** The host's nick, for "<n> invited you". */
  hostNick: string | null;
}

/** The one link she taps: the public invite page carrying host, share link and name in its hash. */
export function inviteUrl(publicOrigin: string, input: InviteInput): string {
  const nick = input.hostNick?.trim().slice(0, 24);
  return buildInviteUrl(publicOrigin, {
    h: input.tailnetUrl,
    ...(input.shareLink ? { s: input.shareLink } : {}),
    ...(nick ? { n: nick } : {}),
  });
}

/** The text behind "Copy invite". The PIN is deliberately not in it (told separately). */
export function inviteMessage(url: string): string {
  return `Movie night 🎬 Tap this on your phone and follow the steps: ${url}`;
}
