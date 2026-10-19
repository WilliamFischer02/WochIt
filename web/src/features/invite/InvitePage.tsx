// /invite — the guest's onboarding page, served from the public origin (Vercel) because her phone
// cannot reach the host until Tailscale is on. Four big steps, progress remembered, the last one
// live: it probes the host and turns into "Open WochIt" the moment the tailnet works.
import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Check, ExternalLink, LoaderCircle, Play, Power, Smartphone, UserCheck } from 'lucide-react';
import { parseInviteHash, type InviteParams } from '@wochit/shared';
import Logo from '../../app/Logo';
import { detectPlatform, loadProgress, openWochitUrl, probeHost, saveProgress, storeFor, type StepId } from './invite';

const PROBE_EVERY_MS = 3000;
/** After this many failed probes the page also offers "Open WochIt anyway" (see step 4). */
const PROBES_BEFORE_FALLBACK = 3;

function StepCard({
  id,
  title,
  done,
  active,
  onDone,
  icon,
  children,
}: {
  id: StepId;
  title: string;
  done: boolean;
  active: boolean;
  onDone(): void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      data-testid={`invite-step-${id}`}
      data-done={done}
      data-active={active}
      className={clsx('glass rounded-xl p-4 motion', done && 'opacity-80', active && 'border-accent/50 shadow-[0_0_0_1px_rgba(139,92,246,.35),0_8px_40px_rgba(0,0,0,.45)]')}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onDone}
          aria-pressed={done}
          aria-label={done ? `Step ${id} done` : `Mark step ${id} done`}
          data-testid={`invite-step-${id}-check`}
          className={clsx(
            'tap grid size-11 shrink-0 place-items-center rounded-full border text-base font-bold motion',
            done ? 'border-ok bg-ok text-bg' : active ? 'border-accent bg-accent/20 text-text' : 'border-line bg-surface-2 text-muted',
          )}
        >
          {done ? <Check size={22} aria-hidden="true" /> : id}
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <span className="text-muted">{icon}</span>
            {title}
          </h2>
          <div className="mt-1.5 text-sm text-muted">{children}</div>
        </div>
      </div>
    </li>
  );
}

function ActionLink({ href, children, testId, onClick, primary }: { href: string; children: ReactNode; testId?: string; onClick?(): void; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      data-testid={testId}
      className={clsx(
        'tap mt-3 inline-flex items-center justify-center gap-2 rounded-pill px-5 py-3 text-sm font-semibold motion active:scale-[.98]',
        primary ? 'bg-accent text-white shadow-[0_8px_24px_rgba(139,92,246,.35)] hover:brightness-110' : 'border border-line bg-surface-2 text-text hover:bg-white/10',
      )}
    >
      {children}
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  );
}

function Incomplete() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-6 safe-x safe-t safe-b" data-testid="invite-page" data-state="incomplete">
      <div className="glass max-w-sm rounded-xl p-6 text-center animate-fade-in">
        <Logo size={44} className="mx-auto mb-3" />
        <p className="text-base" data-testid="invite-incomplete">
          <span className="font-semibold">This invite link is incomplete,</span> <span className="text-muted">ask William to send it again.</span>
        </p>
      </div>
    </main>
  );
}

function Steps({ params }: { params: InviteParams }) {
  const name = params.n ?? 'Your host';
  const platform = detectPlatform(navigator.userAgent);
  const store = storeFor(platform);
  const [done, setDone] = useState<Set<StepId>>(() => loadProgress());
  const [reachable, setReachable] = useState(false);
  const [probes, setProbes] = useState(0);

  const mark = (id: StepId, value = true) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      saveProgress(next);
      return next;
    });
  };
  const toggle = (id: StepId) => mark(id, !done.has(id));

  // Step 4 is live: keep knocking on the host until it answers, then stop.
  useEffect(() => {
    if (reachable) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async () => {
      const ok = await probeHost(params.h, PROBE_EVERY_MS);
      if (!alive) return;
      setProbes((n) => n + 1);
      if (ok) {
        setReachable(true);
        setDone((prev) => {
          const next = new Set(prev).add(4 as StepId);
          saveProgress(next);
          return next;
        });
        return;
      }
      timer = setTimeout(() => void attempt(), PROBE_EVERY_MS);
    };
    void attempt();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [params.h, reachable]);

  // The next thing to do is highlighted; connecting marks step 4 done, so a finished list rests on 4.
  const active = ([1, 2, 3, 4] as const).find((s) => !done.has(s)) ?? 4;

  return (
    <main className="relative min-h-dvh overflow-x-hidden bg-bg safe-x safe-t safe-b" data-testid="invite-page" data-state="steps" data-platform={platform}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 size-[90vmax] -translate-x-1/2 -translate-y-2/3 rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(closest-side, rgba(139,92,246,.4), transparent 70%)' }}
      />
      <div className="relative mx-auto flex max-w-md flex-col gap-4 px-4 pb-10 pt-8">
        <header className="flex flex-col items-center gap-3 text-center animate-fade-in">
          <Logo size={56} />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">WochIt</p>
            <h1 className="mt-1 text-2xl font-bold leading-tight tracking-tight" data-testid="invite-title">
              <span className="text-accent-2">{name}</span> invited you to a movie night
            </h1>
            <p className="mt-2 text-sm text-muted">Four quick steps, about two minutes. Your progress is saved if you leave.</p>
          </div>
        </header>

        <ol className="flex flex-col gap-3">
          <StepCard id={1} title="Get Tailscale" done={done.has(1)} active={active === 1} onDone={() => toggle(1)} icon={<Smartphone size={16} aria-hidden="true" />}>
            <p>
              It is the private connection to {name}
              {name.endsWith('s') ? "'" : "'s"} PC. Sign in with Apple or Google, whichever is easiest.
            </p>
            <ActionLink href={store.primary.url} testId="invite-store" onClick={() => mark(1)} primary={active === 1}>
              Get it on the {store.primary.label}
            </ActionLink>
            <p className="mt-2 text-xs">
              Not on {platform === 'android' ? 'Android' : 'iPhone'}?{' '}
              <a href={store.other.url} target="_blank" rel="noopener noreferrer" className="text-accent underline" data-testid="invite-store-other">
                {store.other.label}
              </a>
            </p>
          </StepCard>

          <StepCard id={2} title={`Accept ${name}${name.endsWith('s') ? "'" : "'s"} invite`} done={done.has(2)} active={active === 2} onDone={() => toggle(2)} icon={<UserCheck size={16} aria-hidden="true" />}>
            {params.s ? (
              <>
                <p>Sign in with the same account you used in the app, then tap Accept.</p>
                <ActionLink href={params.s} testId="invite-share-link" onClick={() => mark(2)} primary={active === 2}>
                  Open the invite
                </ActionLink>
              </>
            ) : (
              <p data-testid="invite-no-share-link">
                {name} will send you a Tailscale share link; tap it and accept. Sign in with the same account you used in the app, then tap Accept.
              </p>
            )}
          </StepCard>

          <StepCard id={3} title="Turn it on" done={done.has(3)} active={active === 3} onDone={() => toggle(3)} icon={<Power size={16} aria-hidden="true" />}>
            <p>Open the Tailscale app and switch it on. Your phone asks to allow a VPN: allow it. That is the connection.</p>
            {!done.has(3) && (
              <button
                type="button"
                onClick={() => mark(3)}
                data-testid="invite-step-3-done"
                className={clsx(
                  'tap mt-3 inline-flex items-center gap-2 rounded-pill px-5 py-3 text-sm font-semibold motion active:scale-[.98]',
                  active === 3 ? 'bg-accent text-white shadow-[0_8px_24px_rgba(139,92,246,.35)] hover:brightness-110' : 'border border-line bg-surface-2 text-text hover:bg-white/10',
                )}
              >
                <Check size={16} aria-hidden="true" /> It is on
              </button>
            )}
          </StepCard>

          <StepCard id={4} title={reachable ? 'Connected' : 'Connecting'} done={reachable} active={active === 4} onDone={() => undefined} icon={<Play size={16} aria-hidden="true" />}>
            {reachable ? (
              <>
                <p className="text-ok">Found {name}'s PC. You are in.</p>
                <a
                  href={openWochitUrl(params.h)}
                  data-testid="invite-open"
                  className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-pill bg-accent px-5 py-4 text-lg font-semibold text-white shadow-[0_8px_24px_rgba(139,92,246,.35)] motion hover:brightness-110 active:scale-[.98]"
                >
                  <Play size={20} fill="currentColor" aria-hidden="true" /> Open WochIt
                </a>
              </>
            ) : (
              <>
                <p className="flex items-center gap-2" data-testid="invite-probe" data-probes={probes} aria-live="polite">
                  <LoaderCircle size={16} className="shrink-0 animate-spin" aria-hidden="true" />
                  <span>Looking for {name}'s PC… make sure Tailscale is on.</span>
                </p>
                {probes >= PROBES_BEFORE_FALLBACK && (
                  // Chrome (not Safari) may refuse to let a public page probe a private address at all.
                  // The WochIt page itself is same-origin on the tailnet, so opening it works regardless.
                  <>
                    <a
                      href={openWochitUrl(params.h)}
                      data-testid="invite-open-anyway"
                      className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-pill border border-line bg-surface-2 px-5 py-4 text-base font-semibold text-text motion hover:bg-white/10 active:scale-[.98]"
                    >
                      <Play size={18} fill="currentColor" aria-hidden="true" /> Open WochIt anyway
                    </a>
                    <p className="mt-2 text-xs text-muted">If Tailscale is on, it opens. If the page does not load, go back to step 3.</p>
                  </>
                )}
              </>
            )}
          </StepCard>
        </ol>

        <p className="mt-2 text-center text-[11px] text-muted">{name} will tell you the PIN separately.</p>
      </div>
    </main>
  );
}

export default function InvitePage() {
  const [params] = useState(() => parseInviteHash(window.location.hash));
  useEffect(() => {
    document.title = params?.n ? `${params.n} · Movie night · WochIt` : 'Movie night · WochIt';
  }, [params]);
  if (!params) return <Incomplete />;
  return <Steps params={params} />;
}
