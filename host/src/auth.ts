// PIN comparison, the media token, and the per-address failure limiter.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time string equality. A length mismatch still does one compare so timing stays flat. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function pinMatches(candidate: string | null | undefined, pin: string): boolean {
  if (typeof candidate !== 'string') return false;
  return safeEqual(candidate, pin);
}

/** `HMAC-SHA256(key = pin, message = 'media')`, hex. Appended as `?t=` to every /media URL. */
export function mediaToken(pin: string): string {
  return createHmac('sha256', pin).update('media').digest('hex');
}

export interface FailureLimiterOptions {
  /** Failures allowed inside the window before the address is blocked. Default 5. */
  max?: number;
  /** Sliding window, ms. Default 60 000. */
  windowMs?: number;
  now?: () => number;
}

/** Sliding-window failure counter per address: 5 failures per minute → blocked until one expires. */
export class FailureLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();

  constructor(opts: FailureLimiterOptions = {}) {
    this.max = opts.max ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  private recent(addr: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(addr) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(addr, list);
    else this.failures.delete(addr);
    return list;
  }

  isBlocked(addr: string): boolean {
    return this.recent(addr).length >= this.max;
  }

  /** Records one failure and returns whether the address is now blocked. */
  recordFailure(addr: string): boolean {
    const list = this.recent(addr);
    list.push(this.now());
    this.failures.set(addr, list);
    return list.length >= this.max;
  }

  reset(addr: string): void {
    this.failures.delete(addr);
  }

  /** Drop expired entries. Called opportunistically; the map is tiny in practice. */
  prune(): void {
    for (const addr of [...this.failures.keys()]) this.recent(addr);
  }
}
