// The invite composer: store the Tailscale share link once, then one tap copies the invite (a link
// to the public /invite page carrying the tailnet URL, the share link and his name) or shows it as
// a QR. The PIN stays out of the message and is told separately.
import { useEffect, useState, type FormEvent } from 'react';
import clsx from 'clsx';
import { Check, ClipboardCopy, ExternalLink, Link2 } from 'lucide-react';
import type { HostSettingsResponse } from '@wochit/shared';
import { useApp } from '../../app/store';
import { ApiError, fetchHostSettings, patchHostSettings } from '../../lib/hostApi';
import { PUBLIC_ORIGIN } from '../../lib/publicOrigin';
import { useHostHealth } from './hostConsoleStore';
import QrSvg from './QrSvg';
import { PUBLISH_COMMAND } from './readiness';
import { inviteMessage, inviteUrl, machineName, pickShareUrl } from './share';
import { CopyButton, useCopy } from './ui';

export const TAILSCALE_ADMIN_URL = 'https://login.tailscale.com/admin/machines';

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Settings can only be changed from the host PC.';
    if (err.status === 401) return 'Wrong PIN.';
    if (err.status === 400) return 'That does not look like a link.';
    return err.message;
  }
  return 'Could not reach the host.';
}

function ShareLinkField({ machine, settings, onSaved }: { machine: string | null; settings: HostSettingsResponse | null; onSaved(s: HostSettingsResponse): void }) {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const stored = settings?.tailscaleShareLink ?? null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (value: string) => {
    if (!pin || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await patchHostSettings(hostOrigin ?? window.location.origin, pin, { tailscaleShareLink: value });
      onSaved(res);
      setDraft('');
      setEditing(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (!value) return;
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      setError('That does not look like a link.');
      return;
    }
    void patch(value);
  };

  if (stored && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="share-link-saved">
        <Check size={16} className="text-ok" aria-hidden="true" />
        <span className="font-medium">Share link saved</span>
        <button type="button" data-testid="share-link-change" onClick={() => setEditing(true)} className="rounded-pill px-2.5 py-1 text-xs text-muted motion hover:bg-white/10 hover:text-text">
          Change
        </button>
        <button type="button" data-testid="share-link-clear" disabled={busy} onClick={() => void patch('')} className="rounded-pill px-2.5 py-1 text-xs text-muted motion hover:bg-white/10 hover:text-bad">
          Clear
        </button>
        {error && (
          <span role="alert" data-testid="share-link-error" className="basis-full text-xs text-bad">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-2" data-testid="share-link-form">
      <label className="text-xs font-medium text-muted" htmlFor="share-link-input">
        Tailscale share link <span className="font-normal">(one time)</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="share-link-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://login.tailscale.com/admin/invite/…"
          data-testid="share-link-input"
          className="min-w-0 flex-1 basis-56 rounded-pill border border-line bg-surface-2 px-3 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          data-testid="share-link-save"
          className="rounded-pill bg-accent px-3 py-1.5 text-xs font-semibold text-white motion hover:brightness-110 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {stored && (
          <button type="button" onClick={() => setEditing(false)} className="rounded-pill px-2.5 py-1.5 text-xs text-muted motion hover:bg-white/10 hover:text-text">
            Cancel
          </button>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>
          Tailscale admin → Machines → <span className="text-text">{machine ?? 'your PC'}</span> → Share → Copy share link
        </span>
        <a
          href={TAILSCALE_ADMIN_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="share-link-admin"
          className="inline-flex items-center gap-1 rounded-pill border border-line px-2.5 py-1 font-semibold text-text motion hover:bg-white/10"
        >
          Open Tailscale admin <ExternalLink size={12} aria-hidden="true" />
        </a>
      </p>
      {error && (
        <p role="alert" data-testid="share-link-error" className="text-xs text-bad">
          {error}
        </p>
      )}
    </form>
  );
}

export default function ShareCard() {
  const { health } = useHostHealth();
  const hostOrigin = useApp((s) => s.hostOrigin);
  const pin = useApp((s) => s.pin);
  const hostNick = useApp((s) => s.you?.nick ?? null);
  const { copied, copy } = useCopy();
  const [settings, setSettings] = useState<HostSettingsResponse | null>(null);

  // The stored share link lives in the host's .env; read it once per console session.
  useEffect(() => {
    if (!pin) return;
    let alive = true;
    fetchHostSettings(hostOrigin ?? window.location.origin, pin)
      .then((s) => alive && setSettings(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hostOrigin, pin]);

  const localUrl = hostOrigin ?? window.location.origin;
  const target = pickShareUrl(health, localUrl);
  const shareLink = settings?.tailscaleShareLink ?? null;
  const invite = target.tailnet ? inviteUrl(PUBLIC_ORIGIN, { tailnetUrl: target.url, shareLink, hostNick }) : null;
  const message = invite ? inviteMessage(invite) : null;

  return (
    <section className="glass rounded-xl p-4" data-testid="share-card" aria-label="Invite" data-tailnet={target.tailnet}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Invite</h2>

      {!target.tailnet && (
        <p className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn" data-testid="share-local-hint" role="status">
          Not published on Tailscale yet, so there is nothing she can open. Run <code className="rounded bg-black/30 px-1">{PUBLISH_COMMAND}</code> on this PC; the invite
          unlocks by itself. <span className="text-muted">({target.url} only works on this PC.)</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-5">
        <div className="min-w-0 flex-1 basis-72">
          <ShareLinkField machine={machineName(target.tailnet ? target.url : '')} settings={settings} onSaved={setSettings} />

          <button
            type="button"
            data-testid="copy-invite"
            data-invite-url={invite ?? undefined}
            disabled={!invite}
            onClick={() => message && copy(message)}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-pill bg-accent px-5 py-3 text-base font-semibold text-white shadow-[0_8px_24px_rgba(139,92,246,.35)] motion hover:brightness-110 active:scale-[.99] disabled:opacity-40 disabled:shadow-none"
          >
            {copied ? <Check size={18} aria-hidden="true" /> : <ClipboardCopy size={18} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy invite'}
          </button>
          <p className="mt-1.5 text-xs text-muted">One link: she installs Tailscale, accepts your share, then lands on WochIt.</p>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted">
            PIN
            <code data-testid="share-pin" className="tnum rounded-lg bg-surface-2 px-3 py-1.5 font-mono text-base tracking-[0.3em] text-text">
              {pin ?? '——'}
            </code>
            {pin && <CopyButton text={pin} label="PIN" testId="copy-pin" size="md" />}
            <span className="basis-full text-xs">Tell her the PIN separately.</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Link2 size={12} aria-hidden="true" />
            <span>Direct address</span>
            <code data-testid="share-url" className={clsx('min-w-0 break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono', target.tailnet ? 'text-text' : 'text-muted')}>
              {target.url}
            </code>
            <CopyButton text={target.url} label="host address" testId="copy-url" />
          </div>
        </div>

        <div className="shrink-0">
          {invite ? (
            <div className="rounded-lg bg-white p-2 shadow-[0_8px_30px_rgba(0,0,0,.4)]">
              <QrSvg text={invite} size={168} />
            </div>
          ) : (
            <div data-testid="share-qr-placeholder" className="grid size-[184px] place-items-center rounded-lg border border-dashed border-line p-3 text-center text-xs text-muted">
              The QR code appears once the host is published on Tailscale
            </div>
          )}
          <p className="mt-1.5 max-w-[184px] text-center text-[11px] text-muted">Or point her camera at this</p>
        </div>
      </div>
    </section>
  );
}
