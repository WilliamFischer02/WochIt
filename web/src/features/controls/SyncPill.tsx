import clsx from 'clsx';
import { useApp } from '../../app/store';
import { usePlayer } from '../player/playerStore';
import { formatDrift } from '../../lib/format';

export interface SyncPillProps {
  className?: string;
  /** Describe a remote member instead of this player (host view). */
  remote?: boolean;
}

/** Green "In sync", amber "Catching up +0.6s", red "Reconnecting…", with the other member's nick. */
export default function SyncPill({ className, remote }: SyncPillProps) {
  const socketStatus = useApp((s) => s.socketStatus);
  const members = useApp((s) => s.members);
  const you = useApp((s) => s.you);
  const playback = useApp((s) => s.playback);
  const media = useApp((s) => s.media);
  const sync = usePlayer((s) => s.sync);
  const buffering = usePlayer((s) => s.buffering);
  const hasVideo = usePlayer((s) => s.hasVideo);

  const others = members.filter((m) => m.id !== you?.id).map((m) => m.nick);
  const withText = others.length ? ` · with ${others.slice(0, 2).join(' & ')}` : '';

  let tone: 'ok' | 'warn' | 'bad' | 'muted' = 'muted';
  let text: string;
  if (socketStatus === 'reconnecting' || socketStatus === 'connecting') {
    tone = 'bad';
    text = 'Reconnecting…';
  } else if (socketStatus === 'closed') {
    tone = 'bad';
    text = 'Disconnected';
  } else if (remote || !hasVideo) {
    tone = others.length ? 'ok' : 'muted';
    text = others.length ? `${others[0]} connected` : 'No guest yet';
  } else if (!media || !playback?.mediaId) {
    text = 'Waiting';
  } else if (buffering) {
    tone = 'warn';
    text = 'Buffering…';
  } else {
    switch (sync.syncStatus) {
      case 'in-sync':
        tone = 'ok';
        text = 'In sync';
        break;
      case 'catching-up':
        tone = 'warn';
        text = `Catching up ${formatDrift(-sync.driftSec)}`;
        break;
      case 'seeking':
        tone = 'warn';
        text = 'Seeking…';
        break;
      case 'paused':
        tone = 'muted';
        text = 'Paused';
        break;
      case 'waiting':
        tone = 'muted';
        text = playback.playing ? 'Tap to join' : 'Ready';
        break;
    }
  }

  return (
    <span
      className={clsx('glass inline-flex max-w-full items-center gap-2 rounded-pill px-3 py-1 text-xs font-medium whitespace-nowrap', className)}
      aria-live="polite"
      data-testid="sync-pill"
      data-tone={tone}
    >
      <span
        className={clsx('inline-block size-2 shrink-0 rounded-full', {
          'bg-ok shadow-[0_0_8px_var(--color-ok)]': tone === 'ok',
          'bg-warn shadow-[0_0_8px_var(--color-warn)]': tone === 'warn',
          'bg-bad shadow-[0_0_8px_var(--color-bad)]': tone === 'bad',
          'bg-muted': tone === 'muted',
        })}
      />
      <span className="truncate">
        {text}
        <span className="text-muted">{withText}</span>
      </span>
    </span>
  );
}
