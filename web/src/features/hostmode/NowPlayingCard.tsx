import { Pause, Play } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '../../app/store';
import { formatTime } from '../../lib/format';
import { resolveMediaUrl } from '../../lib/media';
import Scrubber from '../controls/Scrubber';
import SyncPill from '../controls/SyncPill';
import { control, useRoomPosition } from '../controls/intents';
import { usePlayer } from '../player/playerStore';
import ReactionButtons from '../reactions/ReactionButtons';
import { encodeStatus } from './encodeStatus';
import { TONE_TEXT } from './ui';

const SOURCE_LABEL = { vlc: 'VLC', browser: 'Browser', none: '—' } as const;

export default function NowPlayingCard() {
  const media = useApp((s) => s.media);
  const playback = useApp((s) => s.playback);
  const transcode = useApp((s) => s.transcode);
  const hostOrigin = useApp((s) => s.hostOrigin);
  const mediaToken = useApp((s) => s.mediaToken);
  const showVideo = usePlayer((s) => s.showVideoOnHost);
  const hasVideo = usePlayer((s) => s.hasVideo);
  const videoTime = usePlayer((s) => s.currentTime);
  const roomPos = useRoomPosition();
  const position = showVideo && hasVideo ? videoTime : roomPos;
  const duration = media?.durationSec ?? 0;
  const playing = !!playback?.playing;
  const poster = media?.posterUrl ? resolveMediaUrl(media.posterUrl, hostOrigin, mediaToken) : null;
  const encode = media ? encodeStatus(transcode, duration) : null;

  return (
    <section className="glass rounded-xl p-4" data-testid="now-playing" aria-label="Now playing">
      <div className="flex gap-4">
        <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-lg bg-surface-2">
          {poster ? <img src={poster} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-muted">—</div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted" data-testid="source-badge">
              {SOURCE_LABEL[playback?.source ?? 'none']}
            </span>
            <SyncPill remote />
          </div>
          <h2 className="mt-2 truncate text-lg font-semibold" data-testid="now-playing-title">
            {media?.title ?? 'Nothing playing yet'}
          </h2>
          {encode && (
            <div className={clsx('tnum mt-0.5 text-xs', TONE_TEXT[encode.tone])} data-testid="encode-status" data-tone={encode.tone} aria-live="polite">
              {encode.text}
            </div>
          )}
          <div className="tnum mt-1 text-2xl font-semibold tracking-tight">
            {formatTime(position)} <span className="text-base font-normal text-muted">/ {formatTime(duration)}</span>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <Scrubber position={position} duration={duration} onSeek={(p) => control('seek', p)} onScrub={(p) => control('seek', p)} disabled={!media} />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="host-play-pause"
          disabled={!media}
          onClick={() => control('toggle')}
          className={clsx('grid size-12 place-items-center rounded-pill bg-accent text-white motion hover:brightness-110 active:scale-95', !media && 'opacity-40')}
        >
          {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="ml-0.5" />}
        </button>
        <ReactionButtons size="md" />
      </div>
    </section>
  );
}
