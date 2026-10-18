// The three round glass reaction buttons. Tapping sends the reaction and gives the button a
// 120 ms bounce; the screen-filling animation waits for the server echo (ReactionsOverlay).
import { useRef } from 'react';
import clsx from 'clsx';
import { REACTION_EMOJI, type ReactionKind } from '@wochit/shared';
import { usePrefersReducedMotion } from '../chat/hooks';
import { sendReaction, useReactionGate } from './reactionGate';

export interface ReactionButtonsProps {
  size?: 'sm' | 'md';
}

export const REACTION_ORDER: readonly ReactionKind[] = ['cheer', 'boo', 'heart'];

export const REACTION_LABEL: Record<ReactionKind, string> = {
  cheer: 'Cheer',
  boo: 'Boo',
  heart: 'Heart',
};

const PX = { sm: 36, md: 44 } as const;

export default function ReactionButtons({ size = 'md' }: ReactionButtonsProps) {
  const cooling = useReactionGate((s) => s.cooling);
  const reduced = usePrefersReducedMotion();
  const px = PX[size];

  return (
    <div role="group" aria-label="Reactions" className={clsx('flex items-center', size === 'sm' ? 'gap-1.5' : 'gap-2')}>
      {REACTION_ORDER.map((kind, i) => (
        <ReactionButton key={kind} kind={kind} index={i} px={px} cooling={cooling} reduced={reduced} />
      ))}
    </div>
  );
}

function ReactionButton({ kind, index, px, cooling, reduced }: { kind: ReactionKind; index: number; px: number; cooling: boolean; reduced: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const emoji = REACTION_EMOJI[kind][0] ?? '';

  const onClick = () => {
    if (cooling) return;
    if (!sendReaction(kind)) return;
    const el = ref.current;
    if (!reduced && el && typeof el.animate === 'function') {
      el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }], {
        duration: 120,
        easing: 'ease-out',
      });
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={REACTION_LABEL[kind]}
      aria-disabled={cooling}
      title={`${REACTION_LABEL[kind]} (${index + 1})`}
      data-reaction={kind}
      className={clsx(
        'grid shrink-0 touch-manipulation select-none place-items-center rounded-full',
        'border border-white/10 bg-white/8 shadow-[0_4px_18px_rgba(0,0,0,.35)] backdrop-blur-xl',
        'transition-[background-color,opacity] duration-150 hover:bg-white/14',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        cooling && 'opacity-55',
      )}
      style={{ width: px, height: px, fontSize: Math.round(px * 0.5), lineHeight: 1 }}
    >
      <span aria-hidden="true">{emoji}</span>
    </button>
  );
}
