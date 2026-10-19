// The chat, in three shells (docs/UI.md § 4). Open/collapsed is `store.chat.open` in every shell.
//
// Contract with the app shell (web/src/app/ChatPane.tsx): the PARENT owns geometry — width
// (360 / 56 px column, 70 % max 380 px drawer), the drawer's slide and z-index, and the sheet's
// flex-1 / 48 px height — and ChatDrawer fills that box (h-full w-full). The parent's views own
// the default-open policy too. What lives here:
//   column — full panel when open; when collapsed, a rail with the chat icon, unread badge and a
//            typing pulse. The panel keeps a fixed 360 px inner width so the width animation clips
//            instead of reflowing.
//   drawer — glass panel plus its own scrim (a child that extends left across the viewport, so it
//            works inside the parent's transformed wrapper); scrim tap or Esc closes; inert when
//            closed so focus cannot wander into it.
//   sheet  — full panel when open; when tucked, a 48 px bar with the last message and unread
//            count (plus the bottom safe-area inset).
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, MessageCircle, PanelRightClose, X } from 'lucide-react';
import type { Gif } from '@wochit/shared';
import { useApp } from '../../app/store';
import MemberChips, { TypingDots } from '../presence/MemberChips';
import { previewText } from './chatUtils';
import Composer from './Composer';
import GifLightbox from './GifLightbox';
import { useMediaQuery } from './hooks';
import MessageList from './MessageList';
import { IconButton, UnreadBadge, type ChatVariant } from './ui';
import './chat.css';

export interface ChatDrawerProps {
  variant: ChatVariant;
}

export default function ChatDrawer({ variant }: ChatDrawerProps) {
  const open = useApp((s) => s.chat.open);
  const unread = useApp((s) => s.chat.unread);
  const markChatRead = useApp((s) => s.markChatRead);

  // Anything that slipped in while the chat was tucked is read once it is open.
  useEffect(() => {
    if (open && unread > 0) markChatRead();
  }, [open, unread, markChatRead]);

  if (variant === 'column') return <ColumnShell open={open} unread={unread} />;
  if (variant === 'drawer') return <DrawerShell open={open} />;
  return <SheetShell open={open} unread={unread} />;
}

// ------------------------------------------------------------------ shells

function ColumnShell({ open, unread }: { open: boolean; unread: number }) {
  const setChatOpen = useApp((s) => s.setChatOpen);
  if (open) {
    return (
      <section aria-label="Chat" className="flex h-full w-full flex-col bg-surface" data-chat-variant="column">
        <ChatPanel variant="column" />
      </section>
    );
  }
  return (
    <section aria-label="Chat" className="flex h-full w-full flex-col items-center gap-2 bg-surface pt-2.5" data-chat-variant="column">
      <button
        type="button"
        onClick={() => setChatOpen(true)}
        aria-label={unread > 0 ? `Open chat, ${unread} unread` : 'Open chat'}
        aria-expanded={false}
        title="Chat (C)"
        className="relative grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-white/6 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <MessageCircle size={22} />
        <UnreadBadge count={unread} className="absolute -right-0.5 -top-0.5" />
      </button>
      <RailTyping />
    </section>
  );
}

function RailTyping() {
  const youId = useApp((s) => s.you?.id ?? null);
  const typing = useApp((s) => s.members.some((m) => m.typing && m.id !== youId));
  return typing ? <TypingDots className="text-muted" /> : null;
}

function DrawerShell({ open }: { open: boolean }) {
  const setChatOpen = useApp((s) => s.setChatOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setChatOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setChatOpen]);

  return (
    <section
      aria-label="Chat"
      inert={!open}
      data-chat-variant="drawer"
      className="relative flex h-full w-full flex-col border-l border-white/8 bg-surface/80 pr-[env(safe-area-inset-right)] shadow-[0_8px_40px_rgba(0,0,0,.45)] backdrop-blur-xl"
    >
      <div
        aria-hidden="true"
        onClick={() => setChatOpen(false)}
        className={clsx(
          'absolute inset-y-0 right-full w-[100vw] bg-black/30 transition-opacity duration-200 ease-out motion-reduce:transition-none',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <ChatPanel variant="drawer" />
    </section>
  );
}

function SheetShell({ open, unread }: { open: boolean; unread: number }) {
  const setChatOpen = useApp((s) => s.setChatOpen);
  const last = useApp((s) => s.chat.messages[s.chat.messages.length - 1]);
  const youId = useApp((s) => s.you?.id ?? null);
  const typers = useApp((s) => s.members.filter((m) => m.typing && m.id !== youId).length);

  if (!open) {
    return (
      <section aria-label="Chat" data-chat-variant="sheet" className="w-full rounded-t-[20px] border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          aria-expanded={false}
          aria-label={unread > 0 ? `Open chat, ${unread} unread` : 'Open chat'}
          className="flex h-12 w-full items-center gap-2.5 px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        >
          <MessageCircle size={20} className="shrink-0 text-muted" aria-hidden="true" />
          <span className={clsx('min-w-0 flex-1 truncate text-[14px]', unread > 0 ? 'font-medium text-text' : 'text-muted')}>
            {typers > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-muted">
                typing <TypingDots />
              </span>
            ) : (
              previewText(last, youId)
            )}
          </span>
          <UnreadBadge count={unread} />
          <ChevronUp size={20} className="shrink-0 text-muted" aria-hidden="true" />
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Chat"
      data-chat-variant="sheet"
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden rounded-t-[20px] border-t border-line bg-surface"
    >
      <ChatPanel variant="sheet" />
    </section>
  );
}

// ------------------------------------------------------------------ shared inner panel

function ChatPanel({ variant }: { variant: ChatVariant }) {
  const [lightbox, setLightbox] = useState<Gif | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const [panelOpen, setPanelOpen] = useState(false);
  // A landscape phone has ~390 px: give an open emoji/GIF panel the whole body.
  const compact = useMediaQuery('(max-height: 520px)');
  const fill = compact && panelOpen;
  return (
    <>
      <ChatHeader variant={variant} />
      <MessageList onOpenGif={setLightbox} collapsed={fill} />
      <Composer variant={variant} fill={fill} onPanelChange={setPanelOpen} />
      {lightbox && <GifLightbox gif={lightbox} onClose={closeLightbox} />}
    </>
  );
}

function ChatHeader({ variant }: { variant: ChatVariant }) {
  const members = useApp((s) => s.members);
  const youId = useApp((s) => s.you?.id ?? null);
  const setChatOpen = useApp((s) => s.setChatOpen);
  const onRename = useCallback((nick: string) => useApp.getState().send({ type: 'nick', nick }), []);

  const close =
    variant === 'column'
      ? { label: 'Collapse chat', icon: <PanelRightClose size={20} /> }
      : variant === 'drawer'
        ? { label: 'Close chat', icon: <X size={22} /> }
        : { label: 'Tuck chat away', icon: <ChevronDown size={24} /> };

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line pl-4 pr-1">
      <h2 className="shrink-0 text-[15px] font-semibold tracking-tight text-text">WochIt</h2>
      <MemberChips members={members} youId={youId} onRename={onRename} className="min-w-0 flex-1 py-1" />
      <IconButton label={close.label} onClick={() => setChatOpen(false)} aria-expanded={true}>
        {close.icon}
      </IconButton>
    </header>
  );
}
