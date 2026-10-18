import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { HealthResponse } from '@wochit/shared';
import { useApp } from '../../app/store';
import { fetchHealth } from '../../lib/hostApi';
import { formatBytes } from '../../lib/format';

/** How often the footer re-reads /api/health so the cache number moves while transcoding. */
const HEALTH_REFRESH_MS = 30_000;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="grid size-7 place-items-center rounded-pill text-muted hover:bg-white/10 hover:text-text"
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** The tailnet URL is the one he sends to his girlfriend. */
function isTailnetUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.ts.net');
  } catch {
    return false;
  }
}

function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}

export default function HostFooter() {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    if (!hostOrigin) return;
    let alive = true;
    const refresh = () => {
      void fetchHealth(hostOrigin).then((h) => {
        if (alive && h) setHealth(h);
      });
    };
    refresh();
    const id = setInterval(refresh, HEALTH_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [hostOrigin]);

  const origin = hostOrigin ?? window.location.origin;
  const urls = health?.urls && health.urls.length > 0 ? health.urls : [origin];
  const onlyLoopback = urls.every(isLoopbackUrl);

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
      {health?.cache && (
        <span data-testid="cache-usage">
          Cache <span className="tnum text-text">{formatBytes(health.cache.usedBytes)}</span> of {formatBytes(health.cache.maxBytes)}
        </span>
      )}
      {health && (
        <span>
          encoder <span className="text-text">{health.ffmpeg.encoder ?? (health.ffmpeg.found ? 'auto' : 'ffmpeg missing')}</span>
        </span>
      )}
      {onlyLoopback && <span className="basis-full">Guests need your Tailscale URL (see Setup); this one only works on this PC.</span>}
    </footer>
  );
}
