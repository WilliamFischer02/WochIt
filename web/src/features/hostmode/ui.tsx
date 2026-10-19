// Small pieces the console panels share: tone colours, the status dot, clipboard copy.
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-text',
  warn: 'text-warn',
  bad: 'text-bad',
  muted: 'text-muted',
};

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok shadow-[0_0_8px_var(--color-ok)]',
  warn: 'bg-warn shadow-[0_0_8px_var(--color-warn)]',
  bad: 'bg-bad shadow-[0_0_8px_var(--color-bad)]',
  muted: 'bg-muted/60',
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={clsx('inline-block size-2.5 shrink-0 rounded-full', TONE_DOT[tone], className)} aria-hidden="true" />;
}

/** Clipboard write with a 1.2 s "copied" flag; a refused clipboard just leaves the flag down. */
export function useCopy(): { copied: boolean; copy(text: string): void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((text: string) => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip) return;
    clip
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  }, []);
  return { copied, copy };
}

export function CopyButton({ text, label, testId, size = 'sm' }: { text: string; label: string; testId?: string; size?: 'sm' | 'md' }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      data-testid={testId}
      onClick={() => copy(text)}
      className={clsx('grid shrink-0 place-items-center rounded-pill text-muted motion hover:bg-white/10 hover:text-text', size === 'sm' ? 'size-7' : 'size-9')}
    >
      {copied ? <Check size={size === 'sm' ? 14 : 16} className="text-ok" /> : <Copy size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}
