// The scrolling message list: grouped bubbles, system lines, GIFs, enlarged emoji, typing bubble,
// stick-to-bottom with a "new messages" chip when the reader has scrolled up.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown } from 'lucide-react';
import type { ChatMessage, Gif } from '@wochit/shared';
import { useApp } from '../../app/store';
import { TypingDots } from '../presence/MemberChips';
import { formatTime, groupMessages, isEmojiOnly, isVideoUrl, splitLinks, type ChatItem } from './chatUtils';
import { useLongPress } from './hooks';

/** Within this many px of the bottom counts as "at the bottom". */
const STICK_PX = 64;
const GIF_MAX_W = 220;
const GIF_MAX_H = 260;

export default function MessageList({ onOpenGif, collapsed = false }: { onOpenGif: (gif: Gif) => void; collapsed?: boolean }) {
  const messages = useApp((s) => s.chat.messages);
  const youId = useApp((s) => s.you?.id ?? null);
  const offset = useApp((s) => s.serverOffset);
  const members = useApp((s) => s.members);
  const typers = useMemo(() => members.filter((m) => m.typing && m.id !== youId), [members, youId]);
  const items = useMemo(() => groupMessages(messages, youId), [messages, youId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastSeenId = useRef<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [shownTimeId, setShownTimeId] = useState<string | null>(null);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNewCount(0);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    atBottom.current = bottom;
    if (bottom) setNewCount(0);
  }, []);

  // New messages: follow them when at the bottom (or when I sent it), otherwise count them.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    const prevId = lastSeenId.current;
    lastSeenId.current = last?.id ?? null;
    if (!last || last.id === prevId) return;
    const firstRender = prevId === null || !messages.some((m) => m.id === prevId);
    if (firstRender || atBottom.current || last.from.id === youId) {
      scrollToBottom();
      return;
    }
    const prevIndex = messages.findIndex((m) => m.id === prevId);
    const added = messages.slice(prevIndex + 1).filter((m) => m.kind !== 'system').length;
    if (added > 0) setNewCount((c) => c + added);
  }, [messages, youId, scrollToBottom]);

  // Typing bubble appearing/disappearing, keyboard opening, images settling: stay pinned.
  useLayoutEffect(() => {
    if (atBottom.current) scrollToBottom();
  }, [typers.length, scrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!shownTimeId) return;
    const t = setTimeout(() => setShownTimeId(null), 2500);
    return () => clearTimeout(t);
  }, [shownTimeId]);

  return (
    <div className={clsx('relative min-h-0', collapsed ? 'h-0 flex-none overflow-hidden' : 'flex-1')} aria-hidden={collapsed || undefined}>
      <div ref={scrollRef} onScroll={onScroll} className="wc-scroll h-full overflow-y-auto">
        <div
          ref={contentRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Chat messages"
          className="flex min-h-full flex-col justify-end gap-3 px-3 pb-3 pt-4"
        >
          {items.length === 0 && (
            <p className="m-auto max-w-[16rem] text-center text-[13px] leading-relaxed text-muted">
              No messages yet. Say hi <span aria-hidden="true">👋</span>
            </p>
          )}
          {items.map((item) => (
            <Item key={item.key} item={item} offset={offset} onOpenGif={onOpenGif} shownTimeId={shownTimeId} onShowTime={setShownTimeId} />
          ))}
          {typers.length > 0 && (
            <div className="flex items-end gap-2" aria-label={`${typers.map((t) => t.nick).join(', ')} typing`}>
              <div className="flex h-8 items-center rounded-[18px] rounded-bl-[6px] border border-white/5 bg-surface-2 px-3 text-muted">
                <TypingDots />
              </div>
              <span className="pb-1 text-[11px] text-muted">{typers.map((t) => t.nick).join(', ')}</span>
            </div>
          )}
        </div>
      </div>
      {newCount > 0 && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="wc-fade-in absolute bottom-3 left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-surface-2/90 px-3.5 text-[13px] font-medium text-text shadow-[0_8px_24px_rgba(0,0,0,.45)] backdrop-blur-xl hover:bg-surface-2"
          aria-label={`${newCount} new message${newCount === 1 ? '' : 's'}, scroll to latest`}
        >
          <ArrowDown size={15} aria-hidden="true" />
          {newCount === 1 ? 'new message' : `${newCount} new messages`}
        </button>
      )}
    </div>
  );
}

interface ItemProps {
  item: ChatItem;
  offset: number;
  onOpenGif: (gif: Gif) => void;
  shownTimeId: string | null;
  onShowTime: (id: string) => void;
}

const Item = memo(function Item({ item, offset, onOpenGif, shownTimeId, onShowTime }: ItemProps) {
  if (item.type === 'system') {
    return (
      <p className="mx-auto max-w-[85%] text-center text-[12px] leading-snug text-muted" title={formatTime(item.message.at, offset)}>
        {item.message.text}
      </p>
    );
  }
  const { mine, messages } = item;
  return (
    <section className={clsx('flex flex-col gap-[3px]', mine ? 'items-end' : 'items-start')} aria-label={mine ? 'You' : item.from.nick}>
      {!mine && <div className="px-3 pb-0.5 text-[12px] font-medium text-muted">{item.from.nick}</div>}
      {messages.map((m, i) => (
        <Row
          key={m.id}
          message={m}
          mine={mine}
          first={i === 0}
          last={i === messages.length - 1}
          time={formatTime(m.at, offset)}
          showTime={shownTimeId === m.id}
          onShowTime={onShowTime}
          onOpenGif={onOpenGif}
        />
      ))}
    </section>
  );
});

interface RowProps {
  message: ChatMessage;
  mine: boolean;
  first: boolean;
  last: boolean;
  time: string;
  showTime: boolean;
  onShowTime: (id: string) => void;
  onOpenGif: (gif: Gif) => void;
}

function Row({ message, mine, first, last, time, showTime, onShowTime, onOpenGif }: RowProps) {
  const longPressed = useRef(false);
  const press = useLongPress(() => {
    longPressed.current = true;
    onShowTime(message.id);
  });
  return (
    <div
      className={clsx('wc-row flex max-w-[86%] items-end gap-2', mine && 'flex-row-reverse')}
      data-show={showTime ? 'true' : undefined}
      {...press}
    >
      <Body
        message={message}
        mine={mine}
        first={first}
        last={last}
        onOpenGif={(gif) => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          onOpenGif(gif);
        }}
      />
      <time className="wc-time shrink-0 pb-1 text-[11px] tabular-nums text-muted">{time}</time>
    </div>
  );
}

function Body({ message, mine, first, last, onOpenGif }: Omit<RowProps, 'time' | 'showTime' | 'onShowTime'>) {
  if (message.kind === 'gif' && message.gif) {
    const gif = message.gif;
    const width = Math.min(GIF_MAX_W, Math.round((GIF_MAX_H * gif.width) / gif.height));
    const label = gif.title?.trim() || 'GIF';
    return (
      <button
        type="button"
        onClick={() => onOpenGif(gif)}
        className={clsx(
          'wc-media block min-w-0 overflow-hidden rounded-2xl bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          mine ? 'ring-1 ring-accent/40' : 'ring-1 ring-white/5',
        )}
        style={{ width, maxWidth: '100%', aspectRatio: `${gif.width} / ${gif.height}` }}
        aria-label={`${label}, open larger`}
      >
        {isVideoUrl(gif.previewUrl) ? (
          <video src={gif.previewUrl} autoPlay loop muted playsInline className="h-full w-full object-cover" />
        ) : (
          <img src={gif.previewUrl} alt={label} loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" />
        )}
      </button>
    );
  }

  const text = message.text ?? '';
  if (isEmojiOnly(text)) {
    return (
      <div className="px-1 leading-[1.15]" style={{ fontSize: 'calc(15px * 2.25)' }}>
        {text.trim()}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'min-w-0 whitespace-pre-wrap break-words px-3.5 py-2 text-[15px] leading-[1.35] [overflow-wrap:anywhere]',
        mine ? 'bg-accent text-white' : 'border border-white/5 bg-surface-2 text-text',
        'rounded-[18px]',
        mine ? [!first && 'rounded-tr-[6px]', 'rounded-br-[6px]'] : [!first && 'rounded-tl-[6px]', 'rounded-bl-[6px]'],
        !last && (mine ? 'rounded-br-[6px]' : 'rounded-bl-[6px]'),
      )}
    >
      {splitLinks(text).map((part, i) =>
        part.type === 'link' ? (
          <a
            key={i}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer"
            className={clsx('underline underline-offset-2', mine ? 'decoration-white/60' : 'decoration-accent/70 text-[#c4b5fd]')}
          >
            {part.value}
          </a>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </div>
  );
}
