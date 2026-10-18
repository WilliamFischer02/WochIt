// Screen 3 (docs/UI.md): now-playing card, Follow VLC, library, optional local video, footer;
// chat column on the right; reactions overlay over everything.
import { useEffect } from 'react';
import clsx from 'clsx';
import { LogOut } from 'lucide-react';
import { useApp } from '../../app/store';
import ChatPane from '../../app/ChatPane';
import Logo from '../../app/Logo';
import { leaveRoom } from '../connect/join';
import VideoStage from '../player/VideoStage';
import { usePlayer } from '../player/playerStore';
import ReactionsOverlay from '../reactions/ReactionsOverlay';
import HostFooter from './HostFooter';
import LibraryBrowser from './LibraryBrowser';
import NowPlayingCard from './NowPlayingCard';
import VlcCard from './VlcCard';

export default function HostView() {
  const chatOpen = useApp((s) => s.chat.open);
  const setChatOpen = useApp((s) => s.setChatOpen);
  const media = useApp((s) => s.media);
  const showVideo = usePlayer((s) => s.showVideoOnHost);
  const patch = usePlayer((s) => s.patch);

  useEffect(() => {
    setChatOpen(true);
  }, [setChatOpen]);

  return (
    <div data-testid="host-view" className="relative flex h-dvh w-full overflow-hidden bg-bg">
      <main className="min-w-0 flex-1 overflow-y-auto safe-x safe-t safe-b">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-4 desktop:p-6">
          <header className="flex items-center gap-3">
            <Logo size={32} />
            <h1 className="text-lg font-bold tracking-tight">WochIt</h1>
            <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">host</span>
            <div className="flex-1" />
            <button type="button" onClick={leaveRoom} className="flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm text-muted hover:bg-white/6 hover:text-text" data-testid="leave">
              <LogOut size={16} aria-hidden="true" /> Leave
            </button>
          </header>

          {showVideo && (
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black" data-testid="host-stage">
              <VideoStage />
            </div>
          )}

          <NowPlayingCard />

          <label className="flex cursor-pointer items-center gap-2 px-1 text-sm text-muted">
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

          <VlcCard />
          <LibraryBrowser />
          <HostFooter />
        </div>
      </main>
      <ChatPane variant="column" open={chatOpen} />
      <ReactionsOverlay />
    </div>
  );
}
