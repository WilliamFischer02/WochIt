import { useEffect } from 'react';
import ConnectScreen from '../features/connect/ConnectScreen';
import HostView from '../features/hostmode/HostView';
import GuestView from '../features/player/GuestView';
import ErrorToast from './ErrorToast';
import { useApp } from './store';
import { useShortcuts } from './useShortcuts';

export default function App() {
  const view = useApp((s) => s.view);
  const title = useApp((s) => s.media?.title ?? null);
  useShortcuts();

  useEffect(() => {
    document.title = view === 'connect' ? 'WochIt' : title ? `${title} · WochIt` : 'WochIt';
  }, [view, title]);

  return (
    <>
      {view === 'connect' ? <ConnectScreen /> : view === 'host' ? <HostView /> : <GuestView />}
      <ErrorToast />
    </>
  );
}
