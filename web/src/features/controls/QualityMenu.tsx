import { useApp } from '../../app/store';
import { formatBitrate } from '../../lib/format';
import { usePlayer } from '../player/playerStore';
import Menu, { MenuItem } from './Menu';

export default function QualityMenu({ onClose }: { onClose(): void }) {
  const levels = usePlayer((s) => s.levels);
  const current = usePlayer((s) => s.currentLevel);
  const activeHeight = usePlayer((s) => s.activeHeight);
  const ahead = usePlayer((s) => s.bufferedAheadSec);
  const switching = usePlayer((s) => s.switching);
  const api = usePlayer((s) => s.api);
  const engine = usePlayer((s) => s.engine);
  const transcode = useApp((s) => s.transcode);

  const sorted = [...levels].sort((a, b) => b.height - a.height);
  const pick = (index: number) => {
    api?.setLevel(index);
    onClose();
  };

  return (
    <Menu title="Quality" onClose={onClose} testId="quality-menu">
      <div className="px-3 pb-2 text-xs text-muted" data-testid="buffer-meter">
        {switching ? 'Switching…' : `${Math.round(ahead)} s buffered`}
        {engine === 'native' && ' · native player'}
      </div>
      <MenuItem selected={current === -1} onClick={() => pick(-1)} testId="quality-option-auto" hint={activeHeight ? `now ${activeHeight}p` : undefined} autoFocus>
        Auto
      </MenuItem>
      {sorted.map((l) => {
        const t = l.renditionId ? transcode[l.renditionId] : undefined;
        const hint = t && t.status !== 'done' ? `Preparing… ${t.readyToSec !== undefined ? `${Math.round(t.readyToSec)} s ready` : ''}` : undefined;
        return (
          <MenuItem key={l.index} selected={current === l.index} onClick={() => pick(l.index)} testId={`quality-option-${l.height}p`} hint={hint}>
            {l.height}p · {formatBitrate(l.bitrateKbps)}
          </MenuItem>
        );
      })}
      {sorted.length === 0 && <div className="px-3 py-2 text-muted">No renditions yet</div>}
    </Menu>
  );
}
