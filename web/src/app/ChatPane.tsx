// Layout glue around the chat agent's ChatDrawer: sizes/positions the pane per layout and the
// store's `chat.open`; the drawer itself renders the bar / rail content for its variant.
import clsx from 'clsx';
import ChatDrawer from '../features/chat/ChatDrawer';

export type ChatVariant = 'drawer' | 'column' | 'sheet';

export default function ChatPane({ variant, open }: { variant: ChatVariant; open: boolean }) {
  if (variant === 'sheet') {
    // Tucked: the drawer renders its own 48 px bar (+ the bottom safe-area inset), so size to content.
    return (
      <div className={clsx('relative w-full motion', open ? 'min-h-0 flex-1' : 'shrink-0')} data-testid="chat-pane" data-variant="sheet" data-open={open}>
        <ChatDrawer variant="sheet" />
      </div>
    );
  }
  if (variant === 'drawer') {
    return (
      <div
        className={clsx(
          'absolute inset-y-0 right-0 z-[var(--z-chat-drawer,50)] w-[70%] max-w-[380px] motion',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
        data-testid="chat-pane"
        data-variant="drawer"
        data-open={open}
        aria-hidden={!open}
      >
        <ChatDrawer variant="drawer" />
      </div>
    );
  }
  return (
    <aside
      className={clsx('relative z-[var(--z-chat-drawer,50)] h-full shrink-0 overflow-hidden border-l border-line motion', open ? 'w-[360px]' : 'w-14')}
      data-testid="chat-pane"
      data-variant="column"
      data-open={open}
    >
      <ChatDrawer variant="column" />
    </aside>
  );
}
