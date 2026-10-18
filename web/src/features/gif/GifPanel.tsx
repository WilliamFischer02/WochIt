// GIF picker that replaces the emoji area above the composer: search (debounced 400 ms, from 2
// characters) or Featured, masonry grid with aspect-correct tiles, infinite scroll via `next`,
// tap to send. Provider-neutral: the host proxies Klipy or GIPHY and names it in each response;
// the placeholder and footer follow that provider's attribution rules. Pages are cached 5 min.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Hourglass, ImageOff, Search, X } from 'lucide-react';
import type { Gif } from '@wochit/shared';
import { useApp } from '../../app/store';
import { useCoarsePointer, useMediaQuery } from '../chat/hooks';
import {
  ATTRIBUTION,
  GIF_PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  effectiveQuery,
  fetchGifsCached,
  gifErrorText,
  isResting,
  searchPlaceholder,
  type GifProvider,
} from './gifApi';

export interface GifPanelProps {
  variant: 'drawer' | 'column' | 'sheet';
  /** Send the GIF. Return true when it went out; the panel then asks to close. */
  onPick: (gif: Gif) => boolean;
  onClose: () => void;
}

interface FeedError {
  text: string;
  /** HTTP 429: the provider quota is spent; shown calmly, without a retry button. */
  resting: boolean;
}

interface Feed {
  query: string;
  provider: GifProvider | null;
  items: Gif[];
  next: string | null;
  loading: boolean;
  error: FeedError | null;
}

function feedError(err: unknown): FeedError {
  return { text: gifErrorText(err), resting: isResting(err) };
}

// The last provider the host reported, so a reopened panel shows the right placeholder at once.
// null until the first response arrives; the placeholder then reads "Search GIFs".
let lastProvider: GifProvider | null = null;

/** Greedy shortest-column masonry. Prefix-stable, so appending a page never reshuffles tiles. */
export function masonry(items: readonly Gif[], columns: number): Gif[][] {
  const cols: Gif[][] = Array.from({ length: columns }, () => []);
  const heights = new Array<number>(columns).fill(0);
  for (const g of items) {
    let best = 0;
    for (let i = 1; i < columns; i++) if ((heights[i] ?? 0) < (heights[best] ?? 0)) best = i;
    cols[best]?.push(g);
    heights[best] = (heights[best] ?? 0) + tileRatio(g);
  }
  return cols;
}

/** Height/width, clamped so panoramas and skyscrapers stay tappable. */
function tileRatio(g: Gif): number {
  return Math.min(1.6, Math.max(0.45, g.height / g.width));
}

function mergeUnique(a: readonly Gif[], b: readonly Gif[]): Gif[] {
  const seen = new Set(a.map((g) => g.id));
  const out = [...a];
  for (const g of b) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
  }
  return out;
}

const SKELETON: ReadonlyArray<readonly number[]> = [
  [0.62, 0.9, 0.56, 0.75],
  [0.8, 0.58, 0.95, 0.6],
  [0.7, 0.66, 0.85, 0.55],
];

export default function GifPanel({ variant, onPick, onClose }: GifPanelProps) {
  const available = useApp((s) => s.gifSearchAvailable);
  const origin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const wide = useMediaQuery('(min-width: 900px)');
  const coarse = useCoarsePointer();
  const columns = variant === 'column' && wide ? 3 : 2;

  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [feed, setFeed] = useState<Feed>(() => ({ query: '', provider: lastProvider, items: [], next: null, loading: true, error: null }));
  const [reload, setReload] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Debounce typing; below 2 characters (or cleared) it is Featured, immediately.
  useEffect(() => {
    const next = effectiveQuery(q);
    const t = setTimeout(() => setQuery(next), next ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [q]);

  // First page for the current query.
  useEffect(() => {
    if (!available) return;
    let current = true;
    setFeed((f) => ({ query, provider: f.provider, items: [], next: null, loading: true, error: null }));
    scrollRef.current?.scrollTo?.({ top: 0 });
    fetchGifsCached({ q: query, origin, pin, limit: GIF_PAGE_SIZE }).then(
      (res) => {
        lastProvider = res.provider;
        if (!current) return;
        setFeed({ query, provider: res.provider, items: mergeUnique([], res.results), next: res.next, loading: false, error: null });
      },
      (err: unknown) => {
        if (!current) return;
        setFeed((f) => ({ query, provider: f.provider, items: [], next: null, loading: false, error: feedError(err) }));
      },
    );
    return () => {
      current = false;
    };
  }, [query, origin, pin, available, reload]);

  const loadMore = useCallback(() => {
    if (feed.loading || !feed.next || feed.error) return;
    const forQuery = feed.query;
    setFeed((f) => ({ ...f, loading: true }));
    fetchGifsCached({ q: forQuery, pos: feed.next, origin, pin, limit: GIF_PAGE_SIZE }).then(
      (res) =>
        setFeed((f) =>
          f.query === forQuery ? { ...f, items: mergeUnique(f.items, res.results), next: res.next, loading: false } : f,
        ),
      (err: unknown) => setFeed((f) => (f.query === forQuery ? { ...f, loading: false, error: feedError(err) } : f)),
    );
  }, [feed, origin, pin]);

  // Infinite scroll: fetch the next page when the sentinel comes within 200 px.
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), {
      root,
      rootMargin: '0px 0px 200px 0px',
    });
    io.observe(target);
    return () => io.disconnect();
  }, [loadMore]);

  const cols = useMemo(() => masonry(feed.items, columns), [feed.items, columns]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (q) setQ('');
    else onClose();
  };

  if (!available) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader onClose={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 pb-4 text-center">
          <ImageOff size={28} className="text-muted" aria-hidden="true" />
          <p className="text-[14px] font-medium text-text">GIF search is off</p>
          <p className="max-w-[18rem] text-[13px] leading-relaxed text-muted">
            Add <Key>KLIPY_API_KEY</Key> (free at partner.klipy.com) or <Key>GIPHY_API_KEY</Key> to .env on the host PC.
          </p>
          <p className="max-w-[18rem] text-[12px] text-muted/80">Then restart the host.</p>
        </div>
      </div>
    );
  }

  const showSkeleton = feed.loading && feed.items.length === 0;
  const empty = !feed.loading && !feed.error && feed.items.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 pb-2">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-white/10 bg-surface-2 px-3.5 focus-within:border-accent/60">
          <Search size={16} className="shrink-0 text-muted" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus={!coarse}
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            placeholder={searchPlaceholder(feed.provider)}
            aria-label="Search GIFs"
            className="min-w-0 flex-1 bg-transparent text-[16px] text-text outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="-mr-1.5 grid h-8 w-8 place-items-center rounded-full text-muted hover:text-text">
              <X size={15} />
            </button>
          )}
        </label>
        <CloseButton onClose={onClose} />
      </div>
      <div className="flex shrink-0 items-baseline justify-between px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <span>{query ? `Results for “${query}”` : 'Featured'}</span>
      </div>
      <div ref={scrollRef} className="wc-scroll min-h-0 flex-1 overflow-y-auto rounded-xl" aria-busy={feed.loading}>
        {feed.error?.resting && feed.items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" role="status">
            <Hourglass size={24} className="text-muted" aria-hidden="true" />
            <p className="text-[13px] text-muted">{feed.error.text}</p>
          </div>
        ) : feed.error && feed.items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-[13px] text-muted">{feed.error.text}</p>
            <button
              type="button"
              onClick={() => setReload((n) => n + 1)}
              className="h-9 rounded-full border border-white/10 bg-white/8 px-4 text-[13px] font-medium text-text hover:bg-white/12"
            >
              Retry
            </button>
          </div>
        ) : empty ? (
          <p className="grid h-full place-items-center px-6 text-center text-[13px] text-muted">No GIFs for “{query}”.</p>
        ) : (
          <div className="flex gap-1.5">
            {showSkeleton
              ? Array.from({ length: columns }, (_, c) => (
                  <div key={c} className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {(SKELETON[c] ?? []).map((r, i) => (
                      <div key={i} className="wc-skeleton w-full rounded-xl" style={{ aspectRatio: `1 / ${r}` }} />
                    ))}
                  </div>
                ))
              : cols.map((col, c) => (
                  <div key={c} className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {col.map((g) => (
                      <Tile key={g.id} gif={g} onPick={onPick} />
                    ))}
                  </div>
                ))}
          </div>
        )}
        <div ref={sentinelRef} className="h-px" aria-hidden="true" />
        {feed.loading && feed.items.length > 0 && <p className="py-3 text-center text-[12px] text-muted">Loading more…</p>}
        {feed.error && feed.items.length > 0 &&
          (feed.error.resting ? (
            <p className="py-3 text-center text-[12px] text-muted" role="status">
              {feed.error.text}
            </p>
          ) : (
            <button type="button" onClick={() => setFeed((f) => ({ ...f, error: null }))} className="w-full py-3 text-center text-[12px] text-muted underline">
              {feed.error.text} Tap to retry.
            </button>
          ))}
      </div>
      <p className="flex h-[22px] shrink-0 items-end justify-center text-[10.5px] font-semibold tracking-wide text-muted">
        {feed.provider && (
          <a href={ATTRIBUTION[feed.provider].href} target="_blank" rel="noopener noreferrer" className="hover:text-text">
            {ATTRIBUTION[feed.provider].poweredBy}
          </a>
        )}
      </p>
    </div>
  );
}

function Tile({ gif, onPick }: { gif: Gif; onPick: (gif: Gif) => boolean }) {
  const label = gif.title?.trim() || 'GIF';
  return (
    <button
      type="button"
      onClick={() => onPick(gif)}
      className={clsx(
        'wc-media relative block w-full overflow-hidden rounded-xl bg-surface-2 transition-transform active:scale-[0.97]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      )}
      style={{ aspectRatio: `1 / ${tileRatio(gif)}` }}
      aria-label={`Send ${label}`}
      title={label}
    >
      <img src={gif.previewUrl} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
    </button>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close GIFs"
      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted hover:bg-white/6 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      <X size={18} />
    </button>
  );
}

function PanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center justify-between pb-1 pl-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">GIFs</span>
      <CloseButton onClose={onClose} />
    </div>
  );
}

function Key({ children }: { children: string }) {
  return <code className="rounded bg-white/8 px-1 py-0.5 text-[12px] text-text">{children}</code>;
}
