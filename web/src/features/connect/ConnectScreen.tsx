// Screen 1 (docs/UI.md): centred glass card — host URL (only when this page is not served by the
// host), PIN, nickname, Auto / host / guest switch, Join.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';
import type { ClientMode } from '@wochit/shared';
import { useApp } from '../../app/store';
import { fetchHealth } from '../../lib/hostApi';
import { loadPref } from '../../lib/storage';
import Logo from '../../app/Logo';
import { joinRoom, normalizeHostOrigin, parseMode } from './join';

type HostDetect = 'checking' | 'same-origin' | 'remote';

const MODES: Array<{ value: ClientMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'host', label: "I'm on the host PC" },
  { value: 'guest', label: "I'm a guest" },
];

export default function ConnectScreen() {
  const params = new URLSearchParams(window.location.search);
  const [detect, setDetect] = useState<HostDetect>('checking');
  const [host, setHost] = useState(() => params.get('h') ?? loadPref('host') ?? '');
  const [pin, setPin] = useState(() => loadPref('pin') ?? '');
  const [nick, setNick] = useState(() => loadPref('nick') ?? '');
  const [mode, setMode] = useState<ClientMode>(() => parseMode(params.get('mode')) ?? parseMode(loadPref('mode')) ?? 'auto');
  const [joining, setJoining] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const lastError = useApp((s) => s.lastError);
  const socketStatus = useApp((s) => s.socketStatus);
  const socket = useApp((s) => s.socket);
  const triedOrigin = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchHealth(window.location.origin).then((h) => {
      if (alive) setDetect(h ? 'same-origin' : 'remote');
    });
    return () => {
      alive = false;
    };
  }, []);

  // The socket closed (bad PIN → 4001) or could not reach the host (first attempt → reconnecting).
  useEffect(() => {
    if (!joining) return;
    if (socketStatus === 'closed') setJoining(false);
    if (socketStatus === 'reconnecting') {
      socket?.close();
      useApp.getState().setSocket(null);
      setJoining(false);
      setLocalError(`Could not reach the host at ${triedOrigin.current ?? 'that address'}`);
    }
  }, [socketStatus, joining, socket]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const origin = detect === 'same-origin' ? window.location.origin : normalizeHostOrigin(host);
    if (!origin) return setLocalError('Enter the host address, e.g. william-desktop.tail2ac207.ts.net:8443');
    if (!/^\d{4,8}$/.test(pin)) return setLocalError('The PIN is 4–8 digits');
    const name = nick.trim();
    if (name.length < 1 || name.length > 24) return setLocalError('Pick a name, up to 24 characters');
    triedOrigin.current = origin;
    setJoining(true);
    joinRoom({ hostOrigin: origin, pin, nick: name, mode });
  };

  const serverError =
    lastError?.code === 'bad_pin' ? 'Wrong PIN' : lastError?.code === 'rate_limited' ? 'Too many tries — wait a minute' : lastError && joining === false ? lastError.message : null;
  const error = localError ?? serverError;
  const showHost = detect === 'remote';

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-bg p-4 safe-x safe-t safe-b">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/3 size-[70vmax] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(closest-side, rgba(139,92,246,.35), transparent 70%)' }}
      />
      <form onSubmit={onSubmit} className="glass relative w-full max-w-sm rounded-xl p-6 animate-fade-in" data-testid="connect-card" noValidate>
        <div className="mb-6 flex items-center gap-3">
          <Logo size={40} />
          <div>
            <h1 className="text-xl font-bold tracking-tight">WochIt</h1>
            <p className="text-xs text-muted">Watch together, in sync</p>
          </div>
        </div>

        {showHost && (
          <label className="mb-4 block">
            <span className="mb-1 block text-xs font-medium text-muted">Host</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="william-desktop.tail2ac207.ts.net:8443"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              data-testid="host-url"
              className="w-full rounded-xl border border-line bg-surface-2 px-3 py-3 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
            />
          </label>
        )}

        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-muted">PIN</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={8}
            placeholder="••••••"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            data-testid="pin"
            aria-label="Room PIN"
            className="tnum w-full rounded-xl border border-line bg-surface-2 px-3 py-3 text-center text-2xl tracking-[0.5em] outline-none placeholder:tracking-[0.3em] placeholder:text-muted/50 focus:border-accent"
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-muted">Your name</span>
          <input
            type="text"
            autoComplete="nickname"
            maxLength={24}
            placeholder="Mia"
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            data-testid="nick"
            className="w-full rounded-xl border border-line bg-surface-2 px-3 py-3 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
          />
        </label>

        <div className="mb-5 flex rounded-pill border border-line bg-surface-2 p-1 text-xs" role="radiogroup" aria-label="Where are you">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              data-testid={`mode-${m.value}`}
              onClick={() => setMode(m.value)}
              className={clsx('flex-1 rounded-pill px-2 py-2 motion', mode === m.value ? 'bg-accent text-white' : 'text-muted hover:text-text')}
            >
              {m.label}
            </button>
          ))}
        </div>

        {error && (
          <p className="mb-3 text-sm text-bad" role="alert" data-testid="connect-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={joining}
          data-testid="join"
          className="flex w-full items-center justify-center gap-2 rounded-pill bg-accent py-3 font-semibold text-white shadow-[0_8px_24px_rgba(139,92,246,.35)] hover:brightness-110 active:scale-[.99] disabled:opacity-70 motion"
        >
          {joining && <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />}
          {joining ? 'Joining…' : 'Join'}
        </button>
        {detect === 'same-origin' && <p className="mt-3 text-center text-[11px] text-muted">Connected to this host</p>}
      </form>
    </main>
  );
}
