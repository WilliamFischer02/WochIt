import { lazy, Suspense, useEffect } from 'react';
import { INVITE_PATH } from '@wochit/shared';
import ConnectScreen from '../features/connect/ConnectScreen';
import GuestView from '../features/player/GuestView';
import ErrorToast from './ErrorToast';
import { useApp } from './store';
import { useShortcuts } from './useShortcuts';

// Guests on phones never need the host console or the invite page; both load on demand.
const HostView = lazy(() => import('../features/hostmode/HostView'));
const InvitePage = lazy(() => import('../features/invite/InvitePage'));

/** The only other route: the guest onboarding page (served by the public origin, see docs/UI.md § 3b). */
const isInviteRoute = window.location.pathname.replace(/\/+$/, '') === INVITE_PATH;

export default function App() {
  const view = useApp((s) => s.view);
  const title = useApp((s) => s.media?.title ?? null);
  useShortcuts();

  useEffect(() => {
    if (isInviteRoute) return;
    document.title = view === 'connect' ? 'WochIt' : title ? `${title} · WochIt` : 'WochIt';
  }, [view, title]);

  if (isInviteRoute) {
    return (
      <Suspense fallback={<div className="min-h-dvh bg-bg" aria-busy="true" />}>
        <InvitePage />
      </Suspense>
    );
  }

  return (
    <>
      {view === 'connect' ? (
        <ConnectScreen />
      ) : view === 'host' ? (
        <Suspense fallback={<div className="h-dvh w-full bg-bg" aria-busy="true" />}>
          <HostView />
        </Suspense>
      ) : (
        <GuestView />
      )}
      <ErrorToast />
    </>
  );
}
