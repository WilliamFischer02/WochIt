import clsx from 'clsx';
import { useApp } from '../../app/store';

export default function VlcCard() {
  const vlc = useApp((s) => s.vlc);
  const media = useApp((s) => s.media);
  const playback = useApp((s) => s.playback);
  const send = useApp((s) => s.send);

  const status = vlc.connected ? `VLC connected${playback?.source === 'vlc' && media ? ` · ${media.title}` : ''}` : 'VLC not reachable';

  return (
    <section className="glass flex flex-wrap items-center gap-3 rounded-xl px-4 py-3" data-testid="vlc-card">
      <button
        type="button"
        role="switch"
        aria-checked={vlc.following}
        aria-label="Follow VLC"
        data-testid="follow-vlc"
        onClick={() => send({ type: 'follow_vlc', on: !vlc.following })}
        className="flex items-center gap-2"
      >
        <span className={clsx('relative inline-block h-6 w-11 rounded-pill motion', vlc.following ? 'bg-accent' : 'bg-white/15')}>
          <span className={clsx('absolute top-0.5 size-5 rounded-full bg-white motion', vlc.following ? 'left-[22px]' : 'left-0.5')} />
        </span>
        <span className="text-sm font-medium">Follow VLC</span>
      </button>
      <span className="text-sm text-muted" data-testid="vlc-status">
        <span className={clsx('mr-2 inline-block size-2 rounded-full', vlc.connected ? 'bg-ok' : 'bg-muted')} aria-hidden="true" />
        {status}
      </span>
      {!vlc.connected && <span className="basis-full text-xs text-muted">Start VLC from here or enable its web interface — see Setup.</span>}
    </section>
  );
}
