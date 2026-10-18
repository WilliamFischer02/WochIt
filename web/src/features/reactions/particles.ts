// Pure particle system for the reactions overlay (docs/ARCHITECTURE.md § Reactions). No DOM, no
// timers: the overlay owns the canvas and the requestAnimationFrame loop and calls step/draw.
import { REACTION_EMOJI, type ReactionKind } from '@wochit/shared';

export const SPAWN_WINDOW_S = 1.2;
export const MIN_PARTICLES = 18;
export const MAX_PARTICLES_PER_BURST = 28;
export const MAX_LIVE = 80;
export const SIZE_RANGE: readonly [number, number] = [24, 48];
export const SPEED_RANGE: readonly [number, number] = [90, 160];
export const LIFE_RANGE: readonly [number, number] = [2.8, 4];
/** Fraction of a particle's life spent fading out at the end. */
export const FADE_FRACTION = 0.4;
export const TINT_DURATION_S = 1.6;

export const TINTS: Record<ReactionKind, { r: number; g: number; b: number; a: number }> = {
  cheer: { r: 255, g: 196, b: 0, a: 0.09 },
  boo: { r: 96, g: 160, b: 64, a: 0.11 },
  heart: { r: 255, g: 88, b: 140, a: 0.09 },
};

export interface Particle {
  emoji: string;
  /** Centre x without sway, CSS px. */
  x: number;
  y: number;
  size: number;
  /** Fall speed, px/s. */
  vy: number;
  swayAmp: number;
  /** Radians per second. */
  swayFreq: number;
  phase: number;
  rot: number;
  /** Radians per second. */
  vrot: number;
  age: number;
  life: number;
}

interface PendingSpawn {
  at: number;
  kind: ReactionKind;
}

interface Tint {
  kind: ReactionKind;
  age: number;
}

/** Opacity of a particle: 1 until the last 40 % of its life, then linear to 0. */
export function particleAlpha(age: number, life: number): number {
  if (age >= life) return 0;
  const fadeStart = life * (1 - FADE_FRACTION);
  if (age <= fadeStart) return 1;
  return Math.max(0, 1 - (age - fadeStart) / (life - fadeStart));
}

/** Tint strength 0..1: a sine hump that fades in and back out over TINT_DURATION_S. */
export function tintEnvelope(age: number): number {
  if (age <= 0 || age >= TINT_DURATION_S) return 0;
  return Math.sin((Math.PI * age) / TINT_DURATION_S);
}

function lerp(range: readonly [number, number], t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

/** Returns a pre-rendered bitmap of `emoji` drawn at `size` px inside a 1.25 × size box. */
export type SpriteSource = (emoji: string, size: number) => CanvasImageSource | null;

export interface ParticleSystemOptions {
  width: number;
  height: number;
  /** Injectable for tests; defaults to Math.random. Must return [0, 1). */
  random?: () => number;
  maxLive?: number;
}

export class ParticleSystem {
  width: number;
  height: number;
  readonly particles: Particle[] = [];
  private pending: PendingSpawn[] = [];
  private tints: Tint[] = [];
  private clock = 0;
  private readonly random: () => number;
  private readonly maxLive: number;
  /** Diagnostics for tests and the dev harness. */
  spawned = 0;
  dropped = 0;

  constructor(opts: ParticleSystemOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.random = opts.random ?? Math.random;
    this.maxLive = opts.maxLive ?? MAX_LIVE;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** Full effect: a tint plus 18–28 particles scheduled over the next 1.2 s. Returns the count. */
  emit(kind: ReactionKind): number {
    this.tint(kind);
    const span = MAX_PARTICLES_PER_BURST - MIN_PARTICLES + 1;
    const count = MIN_PARTICLES + Math.min(span - 1, Math.floor(this.random() * span));
    for (let i = 0; i < count; i++) {
      // Evenly spread with jitter so the first ones appear at once and the rain stays steady.
      const at = this.clock + ((i + this.random()) / count) * SPAWN_WINDOW_S;
      this.pending.push({ at, kind });
    }
    this.pending.sort((a, b) => a.at - b.at);
    return count;
  }

  /** Reduced-motion variant: just the tint. */
  tint(kind: ReactionKind): void {
    this.tints.push({ kind, age: 0 });
  }

  get liveCount(): number {
    return this.particles.length;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get active(): boolean {
    return this.particles.length > 0 || this.pending.length > 0 || this.tints.length > 0;
  }

  /** Advance by dt seconds. Returns false when nothing is left to animate (stop the loop). */
  step(dt: number): boolean {
    if (!this.active) return false;
    this.clock += dt;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      if (!p) continue;
      this.advance(p, dt);
      if (p.age >= p.life || p.y - p.size > this.height) this.particles.splice(i, 1);
    }

    while (this.pending.length > 0 && (this.pending[0]?.at ?? Infinity) <= this.clock) {
      const job = this.pending.shift();
      if (!job) break;
      if (this.particles.length >= this.maxLive) {
        this.dropped++;
        continue;
      }
      const p = this.makeParticle(job.kind);
      // Catch up the part of this frame that elapsed after its scheduled time.
      this.advance(p, this.clock - job.at);
      this.particles.push(p);
      this.spawned++;
    }

    for (let i = this.tints.length - 1; i >= 0; i--) {
      const t = this.tints[i];
      if (!t) continue;
      t.age += dt;
      if (t.age >= TINT_DURATION_S) this.tints.splice(i, 1);
    }

    return this.active;
  }

  /** Draw onto a context already scaled to CSS pixels. Clears first. */
  draw(ctx: CanvasRenderingContext2D, sprite?: SpriteSource): void {
    ctx.clearRect(0, 0, this.width, this.height);
    for (const t of this.tints) {
      const c = TINTS[t.kind];
      const a = c.a * tintEnvelope(t.age);
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${a.toFixed(4)})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    for (const p of this.particles) {
      const alpha = particleAlpha(p.age, p.life);
      if (alpha <= 0) continue;
      const x = p.x + Math.sin(p.phase + p.age * p.swayFreq) * p.swayAmp;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, p.y);
      ctx.rotate(p.rot);
      const img = sprite?.(p.emoji, p.size) ?? null;
      if (img) {
        const box = p.size * 1.25;
        ctx.drawImage(img, -box / 2, -box / 2, box, box);
      } else {
        ctx.font = `${p.size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.emoji, 0, 0);
      }
      ctx.restore();
    }
  }

  clear(): void {
    this.particles.length = 0;
    this.pending.length = 0;
    this.tints.length = 0;
  }

  private advance(p: Particle, dt: number): void {
    p.age += dt;
    p.y += p.vy * dt;
    p.rot += p.vrot * dt;
  }

  private makeParticle(kind: ReactionKind): Particle {
    const r = this.random;
    const set = REACTION_EMOJI[kind];
    const emoji = set[Math.min(set.length - 1, Math.floor(r() * set.length))] ?? set[0] ?? '✨';
    const size = lerp(SIZE_RANGE, r());
    return {
      emoji,
      x: r() * this.width,
      y: -size,
      size,
      vy: lerp(SPEED_RANGE, r()),
      swayAmp: 10 + r() * 26,
      swayFreq: (0.6 + r() * 0.8) * Math.PI * 2,
      phase: r() * Math.PI * 2,
      rot: (r() - 0.5) * 0.6,
      vrot: (r() - 0.5) * 1.6,
      age: 0,
      life: lerp(LIFE_RANGE, r()),
    };
  }
}
