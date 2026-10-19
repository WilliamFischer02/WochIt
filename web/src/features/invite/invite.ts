// Pure helpers for the guest onboarding page (/invite): which store to send her to, remembered
// step progress, the "is the host reachable yet" probe, and where "Open WochIt" goes.
import { HealthResponse } from '@wochit/shared';
import { loadPref, savePref } from '../../lib/storage';

export const IOS_STORE_URL = 'https://apps.apple.com/us/app/tailscale/id1470499037';
export const ANDROID_STORE_URL = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';

export type Platform = 'ios' | 'android' | 'other';

export function detectPlatform(ua: string): Platform {
  if (/iP(hone|ad|od)/.test(ua)) return 'ios';
  // iPadOS 13+ pretends to be a Mac; a Mac with touch points is an iPad, but UA alone cannot tell.
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export function storeFor(platform: Platform): { primary: { url: string; label: string }; other: { url: string; label: string } } {
  const ios = { url: IOS_STORE_URL, label: 'App Store' };
  const android = { url: ANDROID_STORE_URL, label: 'Google Play' };
  return platform === 'android' ? { primary: android, other: ios } : { primary: ios, other: android };
}

export type StepId = 1 | 2 | 3 | 4;
export const STEPS: readonly StepId[] = [1, 2, 3, 4];

const PROGRESS_PREF = 'invite.done';

/** Steps she has marked done, remembered per browser (try/catch inside loadPref). */
export function loadProgress(): Set<StepId> {
  const raw = loadPref(PROGRESS_PREF);
  const done = new Set<StepId>();
  if (!raw) return done;
  for (const part of raw.split(',')) {
    const n = Number(part);
    if (n === 1 || n === 2 || n === 3 || n === 4) done.add(n);
  }
  return done;
}

export function saveProgress(done: ReadonlySet<StepId>): void {
  savePref(PROGRESS_PREF, done.size ? [...done].sort().join(',') : null);
}

/** `${h}/?from=invite`, tolerant of a trailing slash on `h`. */
export function openWochitUrl(hostOrigin: string): string {
  return `${hostOrigin.replace(/\/+$/, '')}/?from=invite`;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** True when `${h}/api/health` answers like a WochIt host within `timeoutMs` (CORS, uncached). */
export async function probeHost(hostOrigin: string, timeoutMs = 3000, fetchFn: FetchLike = (i, init) => fetch(i, init)): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${hostOrigin.replace(/\/+$/, '')}/api/health`, { mode: 'cors', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return false;
    return HealthResponse.safeParse(await res.json()).success;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
