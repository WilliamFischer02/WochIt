// Composer: emoji button, auto-growing textarea (Enter sends, Shift+Enter newline), GIF button,
// send button when there is text. The emoji picker / GIF panel opens in-flow above the row so the
// layout stays a plain flex column (no position: fixed), which keeps it above the on-screen
// keyboard on every browser.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { SendHorizontal, Smile } from 'lucide-react';
import type { Gif } from '@wochit/shared';
import { useApp } from '../../app/store';
import GifPanel from '../gif/GifPanel';
import EmojiPanel, { warmEmojiPicker } from './EmojiPanel';
import { useCoarsePointer, useTypingSignal } from './hooks';
import { IconButton, type ChatVariant } from './ui';

const MAX_LEN = 2000;
/** 4 lines × 22 px + 20 px padding. */
const MAX_TEXTAREA_PX = 4 * 22 + 20;

type Panel = 'emoji' | 'gif' | null;

// Survives remounts (rotating the phone swaps the sheet for the drawer).
let savedDraft = '';

export interface ComposerProps {
  variant: ChatVariant;
  /** Short viewports: the open panel takes all the height the message list would have had. */
  fill?: boolean;
  onPanelChange?: (open: boolean) => void;
}

export default function Composer({ variant, fill = false, onPanelChange }: ComposerProps) {
  const [text, setText] = useState(() => savedDraft);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const coarse = useCoarsePointer();
  const typing = useTypingSignal();
  const hasText = text.trim().length > 0;

  useEffect(() => {
    savedDraft = text;
  }, [text]);

  useEffect(() => {
    onPanelChange?.(panel !== null);
  }, [panel, onPanelChange]);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const sendText = () => {
    const body = text.trim();
    if (!body) return;
    const ok = useApp.getState().send({ type: 'chat', kind: 'text', text: body.slice(0, MAX_LEN) });
    if (!ok) {
      setNotice('Not connected. Your message is still here.');
      return;
    }
    typing.stop();
    setText('');
    if (panel === 'emoji') setPanel(null);
  };

  const sendGif = useCallback((gif: Gif): boolean => {
    const ok = useApp.getState().send({ type: 'chat', kind: 'gif', gif });
    if (!ok) {
      setNotice('Not connected. GIF not sent.');
      return false;
    }
    setPanel(null);
    return true;
  }, []);

  const insertEmoji = useCallback(
    (emoji: string) => {
      const el = taRef.current;
      setText((cur) => {
        const start = el?.selectionStart ?? cur.length;
        const end = el?.selectionEnd ?? cur.length;
        const next = (cur.slice(0, start) + emoji + cur.slice(end)).slice(0, MAX_LEN);
        requestAnimationFrame(() => {
          if (!el) return;
          const caret = Math.min(start + emoji.length, next.length);
          el.setSelectionRange(caret, caret);
          if (!coarse) el.focus();
        });
        return next;
      });
      typing.ping();
    },
    [coarse, typing],
  );

  const togglePanel = (which: Exclude<Panel, null>) => {
    setPanel((p) => (p === which ? null : which));
    // On phones, drop the keyboard so the panel has room.
    if (coarse) taRef.current?.blur();
  };

  const closePanel = useCallback(() => {
    setPanel(null);
    if (!coarse) taRef.current?.focus();
  }, [coarse]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendText();
    } else if (e.key === 'Escape' && panel) {
      e.preventDefault();
      e.stopPropagation();
      setPanel(null);
    }
  };

  return (
    <div className={clsx('flex flex-col', fill ? 'min-h-0 flex-1' : 'shrink-0 border-t border-line')}>
      {panel && (
        <div
          className={clsx('wc-fade-in px-2 pt-2', fill && 'min-h-0 flex-1')}
          style={fill ? undefined : { height: 'min(340px, calc(100dvh - 190px))' }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              closePanel();
            }
          }}
        >
          {panel === 'emoji' ? <EmojiPanel onPick={insertEmoji} /> : <GifPanel variant={variant} onPick={sendGif} onClose={closePanel} />}
        </div>
      )}
      {notice && (
        <p role="status" className="px-4 pt-2 text-[12px] text-bad">
          {notice}
        </p>
      )}
      <div className={clsx('flex shrink-0 items-end gap-1 px-1.5 pt-1.5 pb-[max(6px,env(safe-area-inset-bottom))]', fill && 'border-t border-line')}>
        <IconButton
          label={panel === 'emoji' ? 'Close emoji' : 'Emoji'}
          active={panel === 'emoji'}
          aria-expanded={panel === 'emoji'}
          onClick={() => togglePanel('emoji')}
          onPointerEnter={warmEmojiPicker}
        >
          <Smile size={coarse ? 24 : 22} />
        </IconButton>
        <div className="mb-[3px] flex min-w-0 flex-1 rounded-[20px] border border-white/10 bg-surface-2 transition-colors focus-within:border-accent/60">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            maxLength={MAX_LEN}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value.trim()) typing.ping();
              else typing.stop();
            }}
            onKeyDown={onKeyDown}
            onBlur={typing.stop}
            onFocus={() => {
              warmEmojiPicker();
              if (coarse) setPanel(null);
            }}
            placeholder="Message"
            aria-label="Message"
            enterKeyHint="send"
            autoComplete="off"
            className="block max-h-[108px] min-h-[38px] w-full resize-none bg-transparent px-3.5 py-2 text-[16px] leading-[22px] text-text outline-none placeholder:text-muted"
          />
        </div>
        <IconButton
          label={panel === 'gif' ? 'Close GIFs' : 'GIFs'}
          active={panel === 'gif'}
          aria-expanded={panel === 'gif'}
          onClick={() => togglePanel('gif')}
        >
          <span
            className={clsx(
              'grid h-[22px] place-items-center rounded-[6px] border-[1.5px] px-1 text-[10.5px] font-extrabold leading-none tracking-wide',
              panel === 'gif' ? 'border-text' : 'border-current',
            )}
          >
            GIF
          </span>
        </IconButton>
        {hasText && (
          <button
            type="button"
            onClick={sendText}
            // Keep focus (and the phone keyboard) in the textarea.
            onPointerDown={(e) => e.preventDefault()}
            aria-label="Send"
            title="Send (Enter)"
            className="wc-pop-in grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-white shadow-[0_4px_16px_rgba(139,92,246,.45)] transition-transform hover:brightness-110 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <SendHorizontal size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
