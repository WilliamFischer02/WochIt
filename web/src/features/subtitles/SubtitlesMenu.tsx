import clsx from 'clsx';
import { useApp } from '../../app/store';
import { usePlayer, type SubSize } from '../player/playerStore';
import Menu, { MenuItem } from '../controls/Menu';
import { isSupportedSubtitle, subtitleLabel } from './subtitleUtils';

const SIZES: SubSize[] = ['S', 'M', 'L'];

export default function SubtitlesMenu({ onClose }: { onClose(): void }) {
  const media = useApp((s) => s.media);
  const subtitleId = usePlayer((s) => s.subtitleId);
  const setSubtitle = usePlayer((s) => s.setSubtitle);
  const subSize = usePlayer((s) => s.subSize);
  const setSubSize = usePlayer((s) => s.setSubSize);
  const tracks = media?.subtitles ?? [];

  return (
    <Menu title="Subtitles" onClose={onClose} testId="subs-menu">
      <MenuItem selected={subtitleId === null} onClick={() => setSubtitle(media?.id ?? null, null)} testId="subs-option-off" autoFocus>
        Off
      </MenuItem>
      {tracks.map((t) => {
        const ok = isSupportedSubtitle(t);
        return (
          <MenuItem
            key={t.id}
            selected={subtitleId === t.id}
            disabled={!ok}
            onClick={() => setSubtitle(media?.id ?? null, t.id)}
            testId={`subs-option-${t.id}`}
            hint={ok ? (t.lang ?? undefined) : 'not supported yet'}
          >
            {subtitleLabel(t)}
          </MenuItem>
        );
      })}
      {tracks.length === 0 && <div className="px-3 py-2 text-muted">No subtitle tracks</div>}
      <div className="mt-2 flex items-center justify-between border-t border-line px-3 pt-3 pb-1">
        <span className="text-muted">Size</span>
        <div className="flex gap-1" role="radiogroup" aria-label="Subtitle size">
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={subSize === s}
              onClick={() => setSubSize(s)}
              data-testid={`subs-size-${s}`}
              className={clsx('tap rounded-pill px-3 text-sm', subSize === s ? 'bg-accent text-white' : 'bg-white/6 text-muted hover:text-text')}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </Menu>
  );
}
