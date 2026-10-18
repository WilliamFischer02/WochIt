import { useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';

export interface MenuProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  testId?: string;
}

/** Bottom sheet on phones, popover anchored bottom-right on desktop (≥ 900 px). Esc / backdrop close. */
export default function Menu({ title, onClose, children, testId }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <>
      <div className="absolute inset-0 z-30 bg-black/40 desktop:bg-transparent" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-label={title}
        data-testid={testId}
        className={clsx(
          'glass absolute z-40 flex flex-col text-sm animate-slide-up',
          'inset-x-0 bottom-0 max-h-[70%] rounded-t-xl safe-b',
          'desktop:inset-x-auto desktop:bottom-16 desktop:right-3 desktop:w-72 desktop:max-h-[60%] desktop:rounded-xl desktop:pb-0',
        )}
        style={{ backgroundColor: 'rgba(20,20,28,.92)' }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" aria-label="Close" className="tap -mr-2 grid place-items-center rounded-pill text-muted hover:text-text" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto px-2 pb-2">{children}</div>
      </div>
    </>
  );
}

export interface MenuItemProps {
  selected?: boolean;
  disabled?: boolean;
  onClick?(): void;
  children: ReactNode;
  hint?: ReactNode;
  testId?: string;
  autoFocus?: boolean;
}

export function MenuItem({ selected, disabled, onClick, children, hint, testId, autoFocus }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      data-testid={testId}
      data-autofocus={autoFocus ? '' : undefined}
      onClick={onClick}
      className={clsx(
        'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left tap',
        disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/6',
        selected && 'text-text',
        !selected && !disabled && 'text-muted',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{children}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
      {selected && <span aria-hidden="true" className="text-accent">✓</span>}
    </button>
  );
}
