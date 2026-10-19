// Footer line: addresses and PIN with copy buttons, who is connected, cache usage, encoder, and the
// Stop host button (two-step confirm → POST /api/host/shutdown → the "Host stopped" card).
import { useState } from 'react';
import clsx from 'clsx';
import { Power } from 'lucide-react';
import { useApp } from '../../app/store';
import { ApiError, postShutdown } from '../../lib/hostApi';
import { formatBytes } from '../../lib/format';
import { useHostConsole, useHostHealth } from './hostConsoleStore';
import { isTailnetUrl } from './share';
import { CopyButton } from './ui';

function StopHost() {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const setStopped = useHostConsole((s) => s.setStopped);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = async () => {
    if (!pin || busy) return;
    setBusy(true);
    setError(null);
    try {
      await postShutdown(hostOrigin ?? window.location.origin, pin);
      // The agent is going away: close our socket so it does not try to reconnect to nothing.
      useApp.getState().socket?.close();
      setStopped();
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 403 ? 'Only from the host PC.' : err.status === 401 ? 'Wrong PIN.' : err.message);
      else setError('Could not reach the host.');
      setBusy(false);
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <span className="flex items-center gap-2">
        <button
          type="button"
          data-testid="stop-host"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1.5 rounded-pill border border-line px-3 py-1 text-xs font-semibold text-muted motion hover:border-bad/50 hover:bg-bad/10 hover:text-bad"
        >
          <Power size={13} aria-hidden="true" /> Stop host
        </button>
        {error && (
          <span role="alert" data-testid="stop-host-error" className="text-xs text-bad">
            {error}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs" data-testid="stop-host-confirm" role="group" aria-label="Really stop the host?">
      <span className="font-semibold text-text">Really stop?</span>
      <button
        type="button"
        data-testid="stop-host-yes"
        disabled={busy}
        onClick={() => void stop()}
        className="rounded-pill bg-bad px-3 py-1 font-semibold text-white motion hover:brightness-110 disabled:opacity-50"
      >
        {busy ? 'Stopping…' : 'Yes'}
      </button>
      <button
        type="button"
        data-testid="stop-host-no"
        disabled={busy}
        onClick={() => setConfirming(false)}
        className="rounded-pill border border-line px-3 py-1 font-semibold text-muted motion hover:bg-white/10 hover:text-text"
      >
        No
      </button>
    </span>
  );
}

export default function HostFooter() {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const { health } = useHostHealth();

  const origin = hostOrigin ?? window.location.origin;
  const urls = health?.urls && health.urls.length > 0 ? health.urls : [origin];

  return (
    <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs text-muted" data-testid="host-footer">
      {urls.map((url) => {
        const share = isTailnetUrl(url);
        return (
          <span key={url} className="flex items-center gap-1" data-testid="host-url">
            {share ? <span className="rounded-pill bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">share this</span> : 'URL'}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-text">{url}</code>
            <CopyButton text={url} label={share ? 'share URL' : 'host URL'} />
          </span>
        );
      })}
      {pin && (
        <span className="flex items-center gap-1">
          PIN <code className="tnum rounded bg-surface-2 px-1.5 py-0.5 tracking-widest text-text">{pin}</code>
          <CopyButton text={pin} label="PIN" />
        </span>
      )}
      {health?.members && (
        <span data-testid="members-count" className="tnum">
          <span className="text-text">{health.members.hosts}</span> {health.members.hosts === 1 ? 'host' : 'hosts'} ·{' '}
          <span className="text-text">{health.members.guests}</span> {health.members.guests === 1 ? 'guest' : 'guests'}
        </span>
      )}
      {health?.cache && (
        <span data-testid="cache-usage">
          Cache <span className="tnum text-text">{formatBytes(health.cache.usedBytes)}</span> of {formatBytes(health.cache.maxBytes)}
        </span>
      )}
      {health && (
        <span>
          encoder <span className={clsx('text-text', !health.ffmpeg.found && 'text-bad')}>{health.ffmpeg.encoder ?? (health.ffmpeg.found ? 'auto' : 'ffmpeg missing')}</span>
        </span>
      )}
      <span className="ml-auto">
        <StopHost />
      </span>
    </footer>
  );
}
