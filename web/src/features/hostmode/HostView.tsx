// Screen 3 (docs/UI.md): the host console. Main column top to bottom: readiness checks, share
// card, now playing, VLC, guests, "show video here too", library, footer. Chat column on the
// right; reactions overlay over everything. After Stop host, one centred card replaces it all.
import { useEffect } from 'react';
import clsx from 'clsx';
import { LogOut, MessageCircle, Power } from 'lucide-react';
import { useApp } from '../../app/store';
import ChatPane from '../../app/ChatPane';
import Logo from '../../app/Logo';
import { useLayout } from '../../lib/useMediaQuery';
import { leaveRoom } from '../connect/join';
import VideoStage from '../player/VideoStage';
import { usePlayer } from '../player/playerStore';
import ReactionsOverlay from '../reactions/ReactionsOverlay';
import GuestsPanel from './GuestsPanel';
import HostFooter from './HostFooter';
import { useHostConsole } from './hostConsoleStore';
import LibraryBrowser from './LibraryBrowser';
import NowPlayingCard from './NowPlayingCard';
import ReadinessPanel from './ReadinessPanel';
import ShareCard from './ShareCard';
import VlcCard from './VlcCard';

function HostStopped() {
  const resetConsole = useHostConsole((s) => s.resetConsole);
  return (
    <div className="grid h-dvh w-full place-items-center bg-bg p-6 safe-x safe-t safe-b" data-testid="host-stopped">
      <div className="glass flex max-w-sm flex-col items-center gap-4 rounded-xl px-8 py-10 text-center animate-fade-in">
        <span className="grid size-12 place-items-center rounded-full bg-white/8 text-muted">
          <Power size={22} aria-hidden="true" />
        </span>
        <p className="text-base">
          <span className="font-semibold">Host stopped.</span> <span className="text-muted">You can close this window.</span>
        </p>
        <button
          type="button"
          onClick={() => {
            resetConsole();
            leaveRoom();
          }}
          className="mt-2 rounded-pill px-3 py-1.5 text-xs text-muted hover:bg-white/6 hover:text-text"
        >
          Back to the connect screen
        </button>
      </div>
    </div>
  );
}

export default function HostView() {
  const chatOpen = useApp((s) => s.chat.open);
  const unread = useApp((s) => s.chat.unread);
  const setChatOpen = useApp((s) => s.setChatOpen);
  const media = useApp((s) => s.media);
  const showVideo = usePlayer((s) => s.showVideoOnHost);
  const patch = usePlayer((s) => s.patch);
  const stopped = useHostConsole((s) => s.stopped);
  // A desktop screen, but it must still work on a narrow window: below 900 px the panels take the
  // full width and the chat becomes a drawer over them, toggled from the header.
  const desktop = useLayout() === 'desktop';

  useEffect(() => {
    setChatOpen(desktop);
  }, [desktop, setChatOpen]);

  if (stopped) return <HostStopped />;

  return (
    <div data-testid="host-view" className="relative flex h-dvh w-full overflow-hidden bg-bg">
      <main className="min-w-0 flex-1 overflow-y-auto safe-x safe-t safe-b">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-4 desktop:p-6">
          <header className="flex items-center gap-3">
            <Logo size={32} />
            <h1 className="text-lg font-bold tracking-tight">WochIt</h1>
            <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">host</span>
            <div className="flex-1" />
            {!desktop && (
              <button
                type="button"
                onClick={() => setChatOpen(!chatOpen)}
                aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
                aria-expanded={chatOpen}
                data-testid="host-chat-toggle"
                className="relative grid size-9 place-items-center rounded-pill text-muted hover:bg-white/6 hover:text-text"
              >
                <MessageCircle size={20} aria-hidden="true" />
                {unread > 0 && (
                  <span className="tnum absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-pill bg-accent px-1 text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>
                )}
              </button>
            )}
            <button type="button" onClick={leaveRoom} className="flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm text-muted hover:bg-white/6 hover:text-text" data-testid="leave">
              <LogOut size={16} aria-hidden="true" /> Leave
            </button>
          </header>

          <ReadinessPanel />
          <ShareCard />

          {showVideo && (
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black" data-testid="host-stage">
              <VideoStage />
            </div>
          )}

          <NowPlayingCard />
          <VlcCard />
          <GuestsPanel />

          <label className="flex cursor-pointer flex-wrap items-center gap-2 px-1 text-sm text-muted">
            <input
              type="checkbox"
              checked={showVideo}
              onChange={(e) => patch({ showVideoOnHost: e.target.checked })}
              data-testid="show-video"
              className="size-4 accent-[var(--color-accent)]"
              disabled={!media}
            />
            Show video here too
            <span className={clsx('text-xs', !media && 'opacity-50')}>(for testing; the host PC normally watches in VLC)</span>
          </label>

          <LibraryBrowser />
          <HostFooter />
        </div>
      </main>
      <ChatPane variant={desktop ? 'column' : 'drawer'} open={chatOpen} />
      <ReactionsOverlay />
    </div>
  );
}
