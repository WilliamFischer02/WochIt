// Tiny shared presentational pieces for the chat drawer.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export type ChatVariant = 'drawer' | 'column' | 'sheet';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  active?: boolean;
}

/** 44×44 round icon button (minimum tap target per docs/UI.md). */
export function IconButton({ label, children, active, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
        active ? 'bg-accent/20 text-text' : 'text-muted hover:bg-white/6 hover:text-text',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={clsx(
        'inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent-2 px-1 text-[11px] font-bold leading-none text-bg tabular-nums',
        className,
      )}
      aria-hidden="true"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
