import { describe, expect, it } from 'vitest';
import { REACTION_EMOJI } from '@wochit/shared';
import {
  LIFE_RANGE,
  MAX_LIVE,
  MAX_PARTICLES_PER_BURST,
  MIN_PARTICLES,
  ParticleSystem,
  SIZE_RANGE,
  SPAWN_WINDOW_S,
  SPEED_RANGE,
  TINT_DURATION_S,
  particleAlpha,
  tintEnvelope,
} from './particles';

const DT = 1 / 60;

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(sys: ParticleSystem, seconds: number, onFrame?: () => void): void {
  for (let t = 0; t < seconds; t += DT) {
    sys.step(DT);
    onFrame?.();
  }
}

describe('ParticleSystem.emit', () => {
  it('spawns 18 particles at the low end and 28 at the high end, all within 1.2 s', () => {
    const cases: Array<[() => number, number]> = [
      [() => 0, MIN_PARTICLES],
      [() => 0.999999, MAX_PARTICLES_PER_BURST],
    ];
    for (const [rand, expected] of cases) {
      const sys = new ParticleSystem({ width: 400, height: 100_000, random: rand });
      expect(sys.emit('cheer')).toBe(expected);
      run(sys, SPAWN_WINDOW_S + DT);
      expect(sys.spawned).toBe(expected);
      expect(sys.pendingCount).toBe(0);
    }
  });

  it('spreads spawns over the window instead of dumping them at once', () => {
    const sys = new ParticleSystem({ width: 400, height: 2000, random: seeded(1) });
    const count = sys.emit('heart');
    sys.step(0.3);
    expect(sys.spawned).toBeGreaterThan(0);
    expect(sys.spawned).toBeLessThan(count);
  });

  it('draws emoji from the kind and keeps size, speed and life in spec', () => {
    const sys = new ParticleSystem({ width: 400, height: 100_000, random: seeded(7) });
    for (const kind of ['cheer', 'boo', 'heart'] as const) sys.emit(kind);
    run(sys, SPAWN_WINDOW_S + DT);
    expect(sys.liveCount).toBeGreaterThanOrEqual(3 * MIN_PARTICLES);
    const all = new Set<string>([...REACTION_EMOJI.cheer, ...REACTION_EMOJI.boo, ...REACTION_EMOJI.heart]);
    for (const p of sys.particles) {
      expect(all.has(p.emoji)).toBe(true);
      expect(p.size).toBeGreaterThanOrEqual(SIZE_RANGE[0]);
      expect(p.size).toBeLessThanOrEqual(SIZE_RANGE[1]);
      expect(p.vy).toBeGreaterThanOrEqual(SPEED_RANGE[0]);
      expect(p.vy).toBeLessThanOrEqual(SPEED_RANGE[1]);
      expect(p.life).toBeGreaterThanOrEqual(LIFE_RANGE[0]);
      expect(p.life).toBeLessThanOrEqual(LIFE_RANGE[1]);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(400);
    }
  });

  it('starts particles above the top edge', () => {
    const sys = new ParticleSystem({ width: 400, height: 2000, random: () => 0.5 });
    sys.emit('boo');
    sys.step(0.0001);
    sys.step(0.05);
    const first = sys.particles[0];
    expect(first).toBeDefined();
    if (first) expect(first.y).toBeLessThan(0);
  });
});

describe('cap', () => {
  it('never exceeds 80 live particles and drops the excess spawns', () => {
    const sys = new ParticleSystem({ width: 400, height: 100_000, random: () => 0.999999 });
    for (let i = 0; i < 5; i++) sys.emit('cheer'); // 5 × 28 = 140 requested
    let peak = 0;
    run(sys, SPAWN_WINDOW_S + 0.1, () => {
      peak = Math.max(peak, sys.liveCount);
    });
    expect(peak).toBe(MAX_LIVE);
    expect(sys.spawned).toBe(MAX_LIVE);
    expect(sys.dropped).toBe(5 * MAX_PARTICLES_PER_BURST - MAX_LIVE);
  });
});

describe('lifetime and decay', () => {
  it('particleAlpha is opaque for 60 % of life then fades linearly to 0', () => {
    expect(particleAlpha(0, 3)).toBe(1);
    expect(particleAlpha(1.79, 3)).toBe(1);
    expect(particleAlpha(1.8, 3)).toBeCloseTo(1, 9);
    expect(particleAlpha(2.4, 3)).toBeCloseTo(0.5, 5);
    expect(particleAlpha(3, 3)).toBe(0);
    expect(particleAlpha(5, 3)).toBe(0);
  });

  it('removes every particle by the end of its life and then reports idle', () => {
    const sys = new ParticleSystem({ width: 400, height: 100_000, random: seeded(3) });
    sys.emit('heart');
    let active = true;
    let t = 0;
    while (active && t < 10) {
      active = sys.step(DT);
      t += DT;
    }
    expect(active).toBe(false);
    expect(sys.liveCount).toBe(0);
    // Last spawn ≤ 1.2 s, longest life 4 s.
    expect(t).toBeLessThanOrEqual(SPAWN_WINDOW_S + LIFE_RANGE[1] + 2 * DT);
    expect(t).toBeGreaterThan(LIFE_RANGE[0]);
  });

  it('culls particles that fall below the bottom edge before their life ends', () => {
    const sys = new ParticleSystem({ width: 400, height: 50, random: () => 0.5 });
    sys.emit('cheer');
    run(sys, SPAWN_WINDOW_S + 1.6);
    expect(sys.liveCount).toBe(0);
    expect(sys.spawned).toBeGreaterThan(0);
  });
});

describe('tint', () => {
  it('fades in and out over 1.6 s', () => {
    expect(tintEnvelope(0)).toBe(0);
    expect(tintEnvelope(TINT_DURATION_S / 2)).toBeCloseTo(1, 5);
    expect(tintEnvelope(TINT_DURATION_S)).toBe(0);
  });

  it('tint-only (reduced motion) stays active for 1.6 s and spawns nothing', () => {
    const sys = new ParticleSystem({ width: 400, height: 800 });
    sys.tint('boo');
    expect(sys.step(1)).toBe(true);
    expect(sys.step(0.7)).toBe(false);
    expect(sys.spawned).toBe(0);
  });
});

describe('idle', () => {
  it('step with no particles reports idle', () => {
    const sys = new ParticleSystem({ width: 400, height: 800 });
    expect(sys.active).toBe(false);
    expect(sys.step(DT)).toBe(false);
  });
});
