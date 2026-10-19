// One-time bottom sheet for iOS Safari guests: how to put WochIt on the Home Screen.
import { useState } from 'react';
import { Share, SquarePlus, X } from 'lucide-react';
import { dismissInstallHint, readInstallHintEnv, shouldShowInstallHint } from './installHintRules';

export default function InstallHint() {
  const [open, setOpen] = useState(() => shouldShowInstallHint(readInstallHintEnv()));
  if (!open) return null;
  const close = () => {
    dismissInstallHint();
    setOpen(false);
  };
  return (
    <div
      role="dialog"
      aria-label="Add WochIt to your Home Screen"
      data-testid="install-hint"
      className="glass fixed inset-x-3 bottom-3 z-[60] flex items-center gap-3 rounded-xl px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-sm animate-slide-up"
    >
      <SquarePlus size={22} className="shrink-0 text-accent" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-snug">
        <span className="font-semibold">Add WochIt to your Home Screen:</span>{' '}
        <span className="text-muted">
          <Share size={14} className="inline -mt-0.5 text-text" aria-label="Share" /> Share → Add to Home Screen
        </span>
      </p>
      <button type="button" onClick={close} aria-label="Dismiss" data-testid="install-hint-close" className="tap grid shrink-0 place-items-center rounded-pill text-muted hover:bg-white/10 hover:text-text">
        <X size={20} aria-hidden="true" />
      </button>
    </div>
  );
}
