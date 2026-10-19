// The checklist at the top of the console: is everything in place for her to join and watch?
// Rules live in readiness.ts; this file is the rows, the inline actions and the collapse.
import { useState, type FormEvent } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { useApp } from '../../app/store';
import { ApiError, patchHostSettings } from '../../lib/hostApi';
import { loadPref, savePref } from '../../lib/storage';
import { refreshHealth, useHostHealth } from './hostConsoleStore';
import { GIPHY_KEY_URL, KLIPY_KEY_URL, readinessRows, readinessSummary, type ReadyRow } from './readiness';
import { CopyButton, StatusDot, TONE_TEXT } from './ui';

const COLLAPSE_PREF = 'console.readinessCollapsed';

type GifProvider = 'klipy' | 'giphy';

function GifKeyForm({ onSaved }: { onSaved(status: string): void }) {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const [provider, setProvider] = useState<GifProvider>('klipy');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed || !pin || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await patchHostSettings(hostOrigin ?? window.location.origin, pin, provider === 'klipy' ? { klipyApiKey: trimmed } : { giphyApiKey: trimmed });
      setKey('');
      useApp.setState({ gifSearchAvailable: res.gifSearchAvailable });
      onSaved(`Saved. GIF search: ${res.gifProvider ?? provider}`);
      void refreshHealth();
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 403 ? 'Settings can only be changed from the host PC.' : err.status === 401 ? 'Wrong PIN.' : err.message);
      else setError('Could not reach the host.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="flex basis-full flex-wrap items-center gap-2 pl-6" data-testid="gif-key-form">
      <div role="radiogroup" aria-label="GIF provider" className="flex rounded-pill border border-line bg-surface-2 p-0.5 text-xs">
        {(['klipy', 'giphy'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={provider === p}
            data-testid={`gif-provider-${p}`}
            onClick={() => setProvider(p)}
            className={clsx('rounded-pill px-2.5 py-1 font-semibold motion', provider === p ? 'bg-accent text-white' : 'text-muted hover:text-text')}
          >
            {p === 'klipy' ? 'Klipy' : 'GIPHY'}
          </button>
        ))}
      </div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={provider === 'klipy' ? 'Paste your Klipy key' : 'Paste your GIPHY key'}
        aria-label={provider === 'klipy' ? 'Klipy API key' : 'GIPHY API key'}
        data-testid="gif-key-input"
        className="w-56 max-w-full rounded-pill border border-line bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={busy || !key.trim()}
        data-testid="gif-key-save"
        className="rounded-pill bg-accent px-3 py-1.5 text-xs font-semibold text-white motion hover:brightness-110 disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      <a
        href={provider === 'klipy' ? KLIPY_KEY_URL : GIPHY_KEY_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="gif-key-link"
        className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
      >
        Get a free key <ExternalLink size={12} aria-hidden="true" />
      </a>
      {error && (
        <span role="alert" data-testid="gif-key-error" className="basis-full text-xs text-bad">
          {error}
        </span>
      )}
    </form>
  );
}

function RowAction({ row, onGifSaved }: { row: ReadyRow; onGifSaved(status: string): void }) {
  const send = useApp((s) => s.send);
  const action = row.action;
  if (!action) return null;
  switch (action.kind) {
    case 'copy':
      return (
        <span className="flex items-center gap-1 text-xs text-muted">
          <CopyButton text={action.text} label={action.label.replace(/^Copy /, '')} testId={`ready-action-${row.key}`} />
        </span>
      );
    case 'follow-vlc':
      return (
        <button
          type="button"
          data-testid={`ready-action-${row.key}`}
          onClick={() => send({ type: 'follow_vlc', on: true })}
          className="rounded-pill bg-accent px-3 py-1 text-xs font-semibold text-white motion hover:brightness-110"
        >
          Follow
        </button>
      );
    case 'gif-key':
      return <GifKeyForm onSaved={onGifSaved} />;
  }
}

export default function ReadinessPanel() {
  const { health, unreachable } = useHostHealth();
  const hostOrigin = useApp((s) => s.hostOrigin);
  const vlc = useApp((s) => s.vlc);
  const members = useApp((s) => s.members);
  const [collapsed, setCollapsed] = useState(() => loadPref(COLLAPSE_PREF) === '1');
  // After a successful key save the row reads "Saved. GIF search: <provider>" for this session.
  const [gifSaved, setGifSaved] = useState<string | null>(null);

  const localUrl = hostOrigin ?? window.location.origin;
  let rows = readinessRows({ health, unreachable, localUrl, vlc, presenceGuests: members.filter((m) => !m.isHost).length });
  if (gifSaved) rows = rows.map((r) => (r.key === 'gif' ? { key: r.key, label: r.label, tone: 'ok', status: gifSaved } : r));
  const summary = readinessSummary(rows);
  const isCollapsed = collapsed && summary.allOk;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    savePref(COLLAPSE_PREF, next ? '1' : null);
  };

  return (
    <section className="glass rounded-xl px-4 py-3" data-testid="readiness" aria-label="Readiness checks" data-collapsed={isCollapsed}>
      <header className="flex items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Ready to watch?</h2>
        <span
          data-testid="readiness-summary"
          className={clsx('rounded-pill px-2 py-0.5 text-xs font-semibold', summary.allOk ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn')}
        >
          {summary.text}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggle}
          disabled={!summary.allOk}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? 'Show the checks' : 'Collapse the checks'}
          title={summary.allOk ? undefined : 'Collapses once everything is set'}
          data-testid="readiness-toggle"
          className="grid size-8 place-items-center rounded-pill text-muted motion hover:bg-white/10 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </header>
      {!isCollapsed && (
        <ul className="mt-2 divide-y divide-line">
          {rows.map((row) => (
            <li key={row.key} data-testid={`ready-row-${row.key}`} data-tone={row.tone} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <StatusDot tone={row.tone} />
              <span className="w-20 shrink-0 text-sm font-medium">{row.label}</span>
              <span data-testid={`ready-status-${row.key}`} className={clsx('min-w-0 flex-1 break-words text-sm', TONE_TEXT[row.tone])}>
                {row.status}
              </span>
              <RowAction row={row} onGifSaved={setGifSaved} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
