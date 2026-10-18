// Host-only library (docs/UI.md screen 3): breadcrumbs, filter, folders/files with duration and
// size, "Open in VLC" (primary) and "Play in browsers" (secondary).
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Film, Folder, LoaderCircle, Search } from 'lucide-react';
import type { LibraryEntry } from '@wochit/shared';
import { useApp } from '../../app/store';
import { ApiError, fetchLibrary } from '../../lib/hostApi';
import { formatBytes, formatTime } from '../../lib/format';

interface Crumb {
  id: string | null;
  name: string;
}

export default function LibraryBrowser() {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const send = useApp((s) => s.send);
  const currentMediaId = useApp((s) => s.media?.id ?? null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: 'Library' }]);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const parent = crumbs[crumbs.length - 1]!;

  useEffect(() => {
    if (!hostOrigin || !pin) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchLibrary(hostOrigin, pin, parent.id)
      .then((r) => {
        if (!alive) return;
        setEntries([...r.entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1)));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setEntries([]);
        if (e instanceof ApiError && e.status === 403) setError('The library is only available from the host PC.');
        else if (e instanceof ApiError && e.status === 401) setError('Wrong PIN for the library.');
        else setError('Could not load the library.');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [hostOrigin, pin, parent.id]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, filter]);

  const open = (e: LibraryEntry) => {
    setFilter('');
    setCrumbs((c) => [...c, { id: e.id, name: e.name }]);
  };

  return (
    <section className="glass rounded-xl p-4" data-testid="library" aria-label="Library">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          {crumbs.map((c, i) => (
            <span key={`${c.id ?? 'root'}-${i}`} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={14} className="text-muted" aria-hidden="true" />}
              <button
                type="button"
                data-testid={`crumb-${i}`}
                onClick={() => setCrumbs((cs) => cs.slice(0, i + 1))}
                className={i === crumbs.length - 1 ? 'font-semibold' : 'text-muted hover:text-text'}
                aria-current={i === crumbs.length - 1 ? 'page' : undefined}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <label className="relative">
          <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter this folder"
            data-testid="library-filter"
            className="w-44 rounded-pill border border-line bg-surface-2 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent"
          />
        </label>
      </div>

      {error && (
        <p className="py-6 text-center text-sm text-bad" role="alert">
          {error}
        </p>
      )}
      {loading && !error && (
        <div className="flex justify-center py-6 text-muted">
          <LoaderCircle className="animate-spin" size={20} aria-label="Loading" />
        </div>
      )}
      {!loading && !error && shown.length === 0 && <p className="py-6 text-center text-sm text-muted">{filter ? 'Nothing matches' : 'Empty folder'}</p>}

      <ul className="divide-y divide-line">
        {shown.map((e) =>
          e.kind === 'dir' ? (
            <li key={e.id}>
              <button type="button" onClick={() => open(e)} data-testid={`lib-row-${e.id}`} className="flex w-full items-center gap-3 px-2 py-2.5 text-left hover:bg-white/5">
                <Folder size={18} className="shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                <ChevronRight size={16} className="text-muted" aria-hidden="true" />
              </button>
            </li>
          ) : (
            <li key={e.id} data-testid={`lib-row-${e.id}`} className="flex flex-wrap items-center gap-3 px-2 py-2.5">
              <Film size={18} className="shrink-0 text-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {e.name}
                  {e.id === currentMediaId && <span className="ml-2 rounded-pill bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">now playing</span>}
                </div>
                <div className="tnum text-xs text-muted">
                  {e.durationSec !== undefined ? formatTime(e.durationSec) : '—'} · {e.sizeBytes !== undefined ? formatBytes(e.sizeBytes) : '—'}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  data-testid={`open-in-vlc-${e.id}`}
                  onClick={() => send({ type: 'open_in_vlc', mediaId: e.id })}
                  className="rounded-pill bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 motion"
                >
                  Open in VLC
                </button>
                <button
                  type="button"
                  data-testid={`play-in-browsers-${e.id}`}
                  onClick={() => send({ type: 'select_media', mediaId: e.id })}
                  className="rounded-pill border border-line bg-surface-2 px-3 py-1.5 text-xs font-semibold hover:bg-white/10 motion"
                >
                  Play in browsers
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
