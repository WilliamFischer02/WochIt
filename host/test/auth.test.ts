import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FailureLimiter, mediaToken, pinMatches, safeEqual } from '../src/auth.js';

describe('pin compare', () => {
  it('matches equal strings and rejects different or differently sized ones', () => {
    expect(safeEqual('123456', '123456')).toBe(true);
    expect(safeEqual('123456', '123457')).toBe(false);
    expect(safeEqual('12345', '123456')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(pinMatches(undefined, '123456')).toBe(false);
    expect(pinMatches(null, '123456')).toBe(false);
    expect(pinMatches('123456', '123456')).toBe(true);
  });
});

describe('mediaToken', () => {
  it('is HMAC-SHA256(key=pin, msg="media") hex, stable and pin-dependent', () => {
    const t = mediaToken('123456');
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(t).toBe(createHmac('sha256', '123456').update('media').digest('hex'));
    expect(mediaToken('123456')).toBe(t);
    expect(mediaToken('654321')).not.toBe(t);
  });
});

describe('FailureLimiter', () => {
  it('blocks after 5 failures within a minute and unblocks as they expire', () => {
    let now = 1_000_000;
    const lim = new FailureLimiter({ now: () => now });
    for (let i = 0; i < 4; i++) expect(lim.recordFailure('a')).toBe(false);
    expect(lim.isBlocked('a')).toBe(false);
    expect(lim.recordFailure('a')).toBe(true);
    expect(lim.isBlocked('a')).toBe(true);
    expect(lim.isBlocked('b')).toBe(false);
    now += 59_000;
    expect(lim.isBlocked('a')).toBe(true);
    now += 1_001;
    expect(lim.isBlocked('a')).toBe(false);
  });
  it('reset clears an address', () => {
    const lim = new FailureLimiter({ max: 2, windowMs: 1000, now: () => 5 });
    lim.recordFailure('x');
    lim.recordFailure('x');
    expect(lim.isBlocked('x')).toBe(true);
    lim.reset('x');
    expect(lim.isBlocked('x')).toBe(false);
  });
});
