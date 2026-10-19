// Layout glue around the chat agent's ChatDrawer: sizes/positions the pane per layout and the
// store's `chat.open`; the drawer itself renders the bar / rail content for its variant.
// The desktop column is resizable: a handle on its left edge, width remembered per browser.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import clsx from 'clsx';
import ChatDrawer from '../features/chat/ChatDrawer';
import { loadPref, savePref } from '../lib/storage';

export type ChatVariant = 'drawer' | 'column' | 'sheet';

export const CHAT_COLUMN_MIN = 280;
export const CHAT_COLUMN_MAX = 640;
export const CHAT_COLUMN_DEFAULT = 360;
const CHAT_COLUMN_PREF = 'chat.columnWidth';
const KEY_STEP = 16;

/** Clamp to the allowed range and to 60 % of the window, so the stage always keeps room. */
export function clampColumnWidth(w: number, windowWidth = typeof window === 'undefined' ? 1920 : window.innerWidth): number {
  const max = Math.min(CHAT_COLUMN_MAX, Math.max(CHAT_COLUMN_MIN, Math.floor(windowWidth * 0.6)));
  return Math.round(Math.min(max, Math.max(CHAT_COLUMN_MIN, w)));
}

function loadColumnWidth(): number {
  const n = Number(loadPref(CHAT_COLUMN_PREF));
  return Number.isFinite(n) && n > 0 ? clampColumnWidth(n) : CHAT_COLUMN_DEFAULT;
}

export default function ChatPane({ variant, open }: { variant: ChatVariant; open: boolean }) {
  if (variant === 'sheet') {
    // Tucked: the drawer renders its own 48 px bar (+ the bottom safe-area inset), so size to content.
    return (
      <div className={clsx('relative w-full motion', open ? 'min-h-0 flex-1' : 'shrink-0')} data-testid="chat-pane" data-variant="sheet" data-open={open}>
        <ChatDrawer variant="sheet" />
      </div>
    );
  }
  if (variant === 'drawer') {
    return (
      <div
        className={clsx(
          'absolute inset-y-0 right-0 z-[var(--z-chat-drawer,50)] w-[70%] max-w-[380px] motion',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
        data-testid="chat-pane"
        data-variant="drawer"
        data-open={open}
        aria-hidden={!open}
      >
        <ChatDrawer variant="drawer" />
      </div>
    );
  }
  return <ColumnPane open={open} />;
}

function ColumnPane({ open }: { open: boolean }) {
  const [width, setWidth] = useState(loadColumnWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startW: number; pointerId: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;

  const commit = (w: number) => {
    const c = clampColumnWidth(w);
    setWidth(c);
    savePref(CHAT_COLUMN_PREF, String(c));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { startX: e.clientX, startW: latest.current, pointerId: e.pointerId };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The column sits on the right edge: dragging the handle left widens it.
    setWidth(clampColumnWidth(d.startW + (d.startX - e.clientX)));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(d.pointerId)) e.currentTarget.releasePointerCapture(d.pointerId);
    commit(latest.current);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') commit(latest.current + KEY_STEP);
    else if (e.key === 'ArrowRight') commit(latest.current - KEY_STEP);
    else if (e.key === 'Home') commit(CHAT_COLUMN_DEFAULT);
    else return;
    e.preventDefault();
  };

  return (
    <aside
      className={clsx(
        'relative z-[var(--z-chat-drawer,50)] h-full shrink-0 overflow-hidden border-l border-line',
        !dragging && 'motion',
        !open && 'w-14',
      )}
      style={open ? { width } : undefined}
      data-testid="chat-pane"
      data-variant="column"
      data-open={open}
      data-width={open ? width : undefined}
    >
      {open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat. Drag, or use the arrow keys; Home resets."
          aria-valuemin={CHAT_COLUMN_MIN}
          aria-valuemax={CHAT_COLUMN_MAX}
          aria-valuenow={width}
          tabIndex={0}
          data-testid="chat-resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={() => commit(CHAT_COLUMN_DEFAULT)}
          onKeyDown={onKeyDown}
          title="Drag to resize the chat. Double-click to reset."
          className={clsx(
            'group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none select-none focus-visible:outline-2 focus-visible:outline-accent',
            dragging ? 'bg-accent/60' : 'hover:bg-accent/40',
          )}
        >
          <span
            aria-hidden="true"
            className={clsx(
              'absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/25 motion',
              dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          />
        </div>
      )}
      <ChatDrawer variant="column" />
    </aside>
  );
}
