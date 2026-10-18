// Guest layout (docs/UI.md screen 2): portrait = stage on top + chat sheet below; landscape phone =
// stage fills, chat drawer over it; desktop = stage left, chat column right.
import { useEffect } from 'react';
import clsx from 'clsx';
import { useApp } from '../../app/store';
import ChatPane from '../../app/ChatPane';
import { useLayout } from '../../lib/useMediaQuery';
import ReactionsOverlay from '../reactions/ReactionsOverlay';
import VideoStage from './VideoStage';

export default function GuestView() {
  const layout = useLayout();
  const chatOpen = useApp((s) => s.chat.open);
  const setChatOpen = useApp((s) => s.setChatOpen);

  // Portrait and desktop show the chat by default; a phone on its side keeps the picture clear.
  useEffect(() => {
    setChatOpen(layout !== 'landscape');
  }, [layout, setChatOpen]);

  const variant = layout === 'desktop' ? 'column' : layout === 'landscape' ? 'drawer' : 'sheet';

  return (
    <div data-testid="guest-view" className={clsx('relative flex h-dvh w-full overflow-hidden bg-bg', layout === 'desktop' ? 'flex-row' : 'flex-col')}>
      <div
        className={clsx(
          'relative bg-black',
          layout === 'portrait' && (chatOpen ? 'aspect-video w-full shrink-0 safe-t' : 'w-full min-h-0 flex-1'),
          layout === 'landscape' && 'absolute inset-0',
          layout === 'desktop' && 'h-full min-w-0 flex-1',
        )}
      >
        <VideoStage />
      </div>
      <ChatPane variant={variant} open={chatOpen} />
      <ReactionsOverlay />
    </div>
  );
}
