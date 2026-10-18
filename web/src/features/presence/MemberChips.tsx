// Member chips for the chat header: nick, host crown, typing pulse, "you" highlighted. When
// `onRename` is given, the "you" chip turns into an inline nick editor (pencil → input → Enter).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Crown, Pencil } from 'lucide-react';
import { Nick, type Member } from '@wochit/shared';
import './presence.css';

export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={clsx('wc-typing', className)} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export interface MemberChipsProps {
  members: readonly Member[];
  youId: string | null;
  /** Send the new nick; return false if it could not be sent (keeps the editor open). */
  onRename?: (nick: string) => boolean;
  className?: string;
}

export default function MemberChips({ members, youId, onRename, className }: MemberChipsProps) {
  // You first, then the host, then everyone else in join order.
  const sorted = [...members].sort((a, b) => rank(a, youId) - rank(b, youId));
  return (
    <ul className={clsx('wc-no-scrollbar flex items-center gap-1.5 overflow-x-auto', className)} aria-label="People here">
      {sorted.map((m) => (
        <li key={m.id} className="shrink-0">
          {m.id === youId && onRename ? <YouChip member={m} onRename={onRename} /> : <Chip member={m} you={m.id === youId} />}
        </li>
      ))}
    </ul>
  );
}

function rank(m: Member, youId: string | null): number {
  if (m.id === youId) return 0;
  return m.isHost ? 1 : 2;
}

const chipBase =
  'inline-flex h-7 max-w-[11rem] items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium leading-none';

function Chip({ member, you }: { member: Member; you: boolean }) {
  return (
    <span
      className={clsx(chipBase, you ? 'border-accent/45 bg-accent/15 text-text' : 'border-white/8 bg-white/6 text-text/90')}
      title={member.isHost ? `${member.nick} (host)` : member.nick}
    >
      <ChipInner member={member} you={you} />
    </span>
  );
}

function ChipInner({ member, you }: { member: Member; you: boolean }) {
  return (
    <>
      {member.isHost && <Crown size={12} strokeWidth={2.4} className="shrink-0 text-warn" aria-label="Host" />}
      <span className="truncate">{member.nick}</span>
      {you && <span className="sr-only">(you)</span>}
      {member.typing && !you && (
        <>
          <TypingDots className="ml-0.5 text-muted" />
          <span className="sr-only">is typing</span>
        </>
      )}
    </>
  );
}

function YouChip({ member, onRename }: { member: Member; onRename: (nick: string) => boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(member.nick);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(member.nick);
    setInvalid(false);
    setEditing(true);
  };

  const commit = () => {
    const parsed = Nick.safeParse(draft);
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    if (parsed.data !== member.nick && !onRename(parsed.data)) {
      setInvalid(true);
      return;
    }
    setEditing(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <span className={clsx(chipBase, 'border-accent/70 bg-accent/20 pr-1', invalid && 'border-bad/80')}>
        {member.isHost && <Crown size={12} strokeWidth={2.4} className="shrink-0 text-warn" aria-hidden="true" />}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setEditing(false)}
          maxLength={24}
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
          aria-label="Your nickname"
          aria-invalid={invalid}
          className="w-[8.5rem] bg-transparent text-[16px] leading-none text-text outline-none sm:text-[12.5px]"
        />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      className={clsx(
        chipBase,
        'border-accent/45 bg-accent/15 text-text transition-colors hover:bg-accent/25',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      )}
      aria-label={`Your nickname: ${member.nick}. Edit`}
      title="Change your nickname"
    >
      <ChipInner member={member} you />
      <Pencil size={11} className="ml-0.5 shrink-0 text-muted" aria-hidden="true" />
    </button>
  );
}
