import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import clsx from 'clsx';
import { formatTime } from '../../lib/format';

export interface ScrubberProps {
  position: number;
  duration: number;
  buffered?: Array<[number, number]>;
  /** Fired on release (and on keyboard steps). */
  onSeek(position: number): void;
  /** Fired at most every `scrubEveryMs` while dragging, so the other side can follow a slow scrub. */
  onScrub?(position: number): void;
  scrubEveryMs?: number;
  disabled?: boolean;
  className?: string;
  label?: string;
}

const STEP_SEC = 5;

export default function Scrubber({
  position,
  duration,
  buffered = [],
  onSeek,
  onScrub,
  scrubEveryMs = 300,
  disabled,
  className,
  label = 'Seek',
}: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<number | null>(null);
  const lastScrubAt = useRef(0);
  const dragging = ghost !== null;
  const safeDur = duration > 0 && Number.isFinite(duration) ? duration : 0;
  const shown = dragging ? ghost : Math.min(position, safeDur || position);
  const pct = safeDur > 0 ? (shown / safeDur) * 100 : 0;

  const posFromEvent = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || safeDur <= 0) return 0;
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - r.left, 0), r.width);
      return (x / r.width) * safeDur;
    },
    [safeDur],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || safeDur <= 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    const p = posFromEvent(e.clientX);
    setGhost(p);
    lastScrubAt.current = performance.now();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const p = posFromEvent(e.clientX);
    setGhost(p);
    const now = performance.now();
    if (onScrub && now - lastScrubAt.current >= scrubEveryMs) {
      lastScrubAt.current = now;
      onScrub(p);
    }
  };
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const p = posFromEvent(e.clientX);
    setGhost(null);
    onSeek(p);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || safeDur <= 0) return;
    let to: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        to = Math.max(0, position - STEP_SEC);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        to = Math.min(safeDur, position + STEP_SEC);
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = safeDur;
        break;
      case 'PageDown':
        to = Math.max(0, position - STEP_SEC * 6);
        break;
      case 'PageUp':
        to = Math.min(safeDur, position + STEP_SEC * 6);
        break;
    }
    if (to !== null) {
      e.preventDefault();
      onSeek(to);
    }
  };

  // Lost pointer capture (alt-tab, etc.): drop the ghost without seeking.
  useEffect(() => {
    if (!dragging) return;
    const cancel = () => setGhost(null);
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [dragging]);

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeDur)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatTime(shown)} of ${formatTime(safeDur)}`}
      aria-disabled={disabled || undefined}
      data-testid="scrubber"
      data-dragging={dragging ? 'true' : 'false'}
      className={clsx(
        'scrubber group relative h-7 w-full touch-none select-none',
        disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => setGhost(null)}
      onKeyDown={onKeyDown}
    >
      {/* track */}
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-pill bg-white/15">
        {safeDur > 0 &&
          buffered.map(([s, e], i) => (
            <div
              key={i}
              className="absolute top-0 h-full bg-white/20"
              style={{ left: `${(s / safeDur) * 100}%`, width: `${Math.max(0, ((e - s) / safeDur) * 100)}%` }}
            />
          ))}
        <div className="absolute top-0 h-full rounded-pill bg-accent" style={{ width: `${pct}%` }} />
      </div>
      {/* knob */}
      <div
        className="scrubber-knob absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,.5)]"
        style={{ left: `${pct}%` }}
      />
      {/* ghost time bubble */}
      {dragging && (
        <div
          className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-pill bg-black/80 px-2 py-0.5 text-xs tnum text-white"
          style={{ left: `${pct}%` }}
          data-testid="scrubber-ghost"
        >
          {formatTime(shown)}
        </div>
      )}
    </div>
  );
}
