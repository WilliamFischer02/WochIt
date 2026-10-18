// Client-side reaction rate gate shared by every ReactionButtons instance and the 1/2/3 keyboard
// shortcuts. The host enforces REACTION_MIN_GAP_MS too; this keeps taps from being silently
// dropped and greys the buttons out for the gap.
import { create } from 'zustand';
import { REACTION_MIN_GAP_MS, type ReactionKind } from '@wochit/shared';
import { useApp } from '../../app/store';

/** A little slack over the host's gap so network jitter does not get a tap dropped. */
export const LOCAL_GAP_MS = REACTION_MIN_GAP_MS + 60;

export const useReactionGate = create<{ cooling: boolean }>(() => ({ cooling: false }));

let lastSentAt = -Infinity;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Sends a reaction unless one went out less than LOCAL_GAP_MS ago. Returns whether it was sent.
 * Never animates locally: the overlay fires on the server's echo so both screens match.
 */
export function sendReaction(kind: ReactionKind, now: number = Date.now()): boolean {
  if (now - lastSentAt < LOCAL_GAP_MS) return false;
  if (!useApp.getState().send({ type: 'reaction', kind })) return false;
  lastSentAt = now;
  useReactionGate.setState({ cooling: true });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    useReactionGate.setState({ cooling: false });
  }, LOCAL_GAP_MS);
  return true;
}

/** Test hook. */
export function resetReactionGate(): void {
  lastSentAt = -Infinity;
  if (timer) clearTimeout(timer);
  timer = null;
  useReactionGate.setState({ cooling: false });
}
