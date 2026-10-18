// Full-viewport reactions layer: one DPR-aware <canvas> for the particle rain and tint, plus the
// "Mia 🍅" toasts. Consumes `store.reactions` (server echoes) and removes them by id. The rAF loop
// runs only while something is animating. prefers-reduced-motion → tint + toast only.
import { useEffect, useRef, useState } from 'react';
import { REACTION_EMOJI, type ReactionKind } from '@wochit/shared';
import { useApp, type ReactionEvent } from '../../app/store';
import { usePrefersReducedMotion } from '../chat/hooks';
import { ParticleSystem } from './particles';
import { REACTION_LABEL } from './ReactionButtons';
import './reactions.css';

const TOAST_MS = 1400;
const MAX_TOASTS = 4;
/** Phones report DPR 3; 2 is visually identical for soft emoji and halves the fill cost. */
const MAX_DPR = 2;
const SPRITE_STEP = 6;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

interface Toast {
  id: number;
  text: string;
  label: string;
}

class OverlayEngine {
  readonly system = new ParticleSystem({ width: 1, height: 1 });
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private last = 0;
  private dpr = 1;
  private sprites = new Map<string, HTMLCanvasElement | null>();

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
  }

  detach(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas = null;
    this.ctx = null;
    this.system.clear();
  }

  resize(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (dpr !== this.dpr) this.sprites.clear();
    this.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    this.system.resize(w, h);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.ctx && this.raf === 0) this.system.draw(this.ctx, this.sprite);
  }

  fire(kind: ReactionKind, particles: boolean): void {
    if (particles) this.system.emit(kind);
    else this.system.tint(kind);
    this.start();
  }

  private start(): void {
    if (this.raf || !this.ctx) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (t: number): void => {
    const ctx = this.ctx;
    if (!ctx) {
      this.raf = 0;
      return;
    }
    // Clamp so a stalled tab does not teleport particles.
    const dt = Math.min(0.05, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    const active = this.system.step(dt);
    this.system.draw(ctx, this.sprite);
    this.raf = active ? requestAnimationFrame(this.frame) : 0;
  };

  /** Emoji pre-rendered once per (emoji, size bucket); drawImage is far cheaper than fillText. */
  private sprite = (emoji: string, size: number): CanvasImageSource | null => {
    const bucket = Math.max(SPRITE_STEP, Math.round(size / SPRITE_STEP) * SPRITE_STEP);
    const key = `${emoji}|${bucket}`;
    const hit = this.sprites.get(key);
    if (hit !== undefined) return hit;
    const box = Math.ceil(bucket * 1.25 * this.dpr);
    const c = document.createElement('canvas');
    c.width = box;
    c.height = box;
    const g = c.getContext('2d');
    if (!g) {
      this.sprites.set(key, null);
      return null;
    }
    g.font = `${bucket * this.dpr}px ${EMOJI_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(emoji, box / 2, box / 2 + bucket * this.dpr * 0.06);
    this.sprites.set(key, c);
    return c;
  };
}

export default function ReactionsOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OverlayEngine | null>(null);
  const handledUpTo = useRef(0);
  const reactions = useApp((s) => s.reactions);
  const consumeReactions = useApp((s) => s.consumeReactions);
  const youId = useApp((s) => s.you?.id ?? null);
  const reduced = usePrefersReducedMotion();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new OverlayEngine();
    engineRef.current = engine;
    engine.attach(canvas);
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(canvas);
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      engine.detach();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (reactions.length === 0) return;
    const fresh = reactions.filter((r) => r.id > handledUpTo.current);
    consumeReactions(reactions.map((r) => r.id));
    if (fresh.length === 0) return;
    handledUpTo.current = Math.max(handledUpTo.current, ...fresh.map((r) => r.id));
    // A backgrounded tab would replay a stale rain when it comes back; skip instead.
    if (typeof document !== 'undefined' && document.hidden) return;
    for (const r of fresh) engineRef.current?.fire(r.kind, !reduced);
    const added = fresh.map((r) => toastFor(r, youId));
    setToasts((cur) => [...cur, ...added].slice(-MAX_TOASTS));
    for (const toast of added) {
      const handle = setTimeout(() => {
        toastTimers.current.delete(handle);
        setToasts((cur) => cur.filter((x) => x.id !== toast.id));
      }, TOAST_MS);
      toastTimers.current.add(handle);
    }
  }, [reactions, consumeReactions, reduced, youId]);

  return (
    <>
      <canvas ref={canvasRef} className="wc-reactions-canvas" aria-hidden="true" data-testid="reactions-canvas" />
      <div className="wc-reaction-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="wc-reaction-toast inline-flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/10 px-4 text-[14px] font-semibold text-text shadow-[0_8px_40px_rgba(0,0,0,.45)] backdrop-blur-xl"
          >
            <span aria-hidden="true">{t.text}</span>
            <span className="sr-only">{t.label}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function toastFor(r: ReactionEvent, youId: string | null): Toast {
  const who = youId !== null && r.from.id === youId ? 'You' : r.from.nick;
  return {
    id: r.id,
    text: `${who} ${REACTION_EMOJI[r.kind][0] ?? ''}`,
    label: `${who} sent ${REACTION_LABEL[r.kind].toLowerCase()}`,
  };
}
