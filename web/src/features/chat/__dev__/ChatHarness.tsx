// Dev-only harness: mounts ChatDrawer in any variant over a fake stage with a fake store and a
// loopback `send`, plus buttons that inject chat, typing and reactions. Open
// http://localhost:5173/dev-chat.html (?v=sheet|drawer|column&open=0|1&gifs=0|1&bar=0).
// Never imported by the app.
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { MessageCircle } from 'lucide-react';
import type { C2S, ChatMessage, ReactionKind } from '@wochit/shared';
import { useApp } from '../../../app/store';
import ReactionButtons from '../../reactions/ReactionButtons';
import ReactionsOverlay from '../../reactions/ReactionsOverlay';
import ChatDrawer from '../ChatDrawer';
import { UnreadBadge, type ChatVariant } from '../ui';
import { MIA, SYSTEM, YOU, fakeGif, installFakeGifApi, seedMessages } from './fixtures';

const params = new URLSearchParams(window.location.search);
let seq = 0;

function serverChat(from: { id: string; nick: string }, body: Pick<ChatMessage, 'kind' | 'text' | 'gif'>) {
  useApp.getState().applyS2C({
    type: 'chat',
    message: { id: `dev-${++seq}`, from, kind: body.kind, text: body.text, gif: body.gif, at: Date.now() },
  });
}

function setTyping(id: string, typing: boolean) {
  const { members } = useApp.getState();
  useApp.getState().applyS2C({ type: 'presence', members: members.map((m) => (m.id === id ? { ...m, typing } : m)) });
}

function react(kind: ReactionKind, from = MIA) {
  useApp.getState().applyS2C({ type: 'reaction', kind, from: { id: from.id, nick: from.nick }, at: Date.now() });
}

/** Loopback "server": echoes what the UI sends after a 40 ms fake round trip. */
function fakeSend(msg: C2S): boolean {
  const you = useApp.getState().you;
  if (!you) return false;
  const me = { id: you.id, nick: you.nick };
  setTimeout(() => {
    switch (msg.type) {
      case 'chat':
        serverChat(me, { kind: msg.kind, text: msg.text, gif: msg.gif });
        return;
      case 'reaction':
        react(msg.kind, { ...you });
        return;
      case 'typing':
        setTyping(you.id, msg.on);
        return;
      case 'nick': {
        const old = you.nick;
        const members = useApp.getState().members.map((m) => (m.id === you.id ? { ...m, nick: msg.nick } : m));
        useApp.setState({ you: { ...you, nick: msg.nick } });
        useApp.getState().applyS2C({ type: 'presence', members });
        serverChat(SYSTEM, { kind: 'system', text: `${old} is now ${msg.nick}` });
        return;
      }
      default:
        return;
    }
  }, 40);
  return true;
}

let seeded = false;
export function seedStore() {
  if (seeded) return;
  seeded = true;
  installFakeGifApi();
  const now = Date.now();
  useApp.setState({
    you: YOU,
    members: [YOU, { ...MIA, typing: params.get('typing') === '1' }],
    gifSearchAvailable: params.get('gifs') !== '0',
    serverOffset: 0,
    chat: { messages: seedMessages(now), unread: Number(params.get('unread') ?? '0'), open: params.get('open') !== '0' },
    send: fakeSend,
  });
}

const devApi = {
  react,
  incoming(text = 'did you see that?!') {
    serverChat({ id: MIA.id, nick: MIA.nick }, { kind: 'text', text });
  },
  incomingGif() {
    serverChat({ id: MIA.id, nick: MIA.nick }, { kind: 'gif', gif: fakeGif(`dev-gif-${++seq}`, 'no way', 330, 220, 150) });
  },
  typing(on: boolean) {
    setTyping(MIA.id, on);
  },
  open(on: boolean) {
    useApp.getState().setChatOpen(on);
  },
  gifs(on: boolean) {
    useApp.setState({ gifSearchAvailable: on });
  },
};

declare global {
  interface Window {
    __chatDev?: typeof devApi;
  }
}
window.__chatDev = devApi;

function autoVariant(): ChatVariant {
  if (window.innerWidth >= 900) return 'column';
  return window.innerWidth > window.innerHeight ? 'drawer' : 'sheet';
}

export default function ChatHarness() {
  const [variant, setVariant] = useState<ChatVariant>(() => {
    const v = params.get('v');
    return v === 'sheet' || v === 'drawer' || v === 'column' ? v : autoVariant();
  });
  const open = useApp((s) => s.chat.open);
  const showBar = params.get('bar') !== '0';

  // Geometry mirrors web/src/features/player/GuestView.tsx + web/src/app/ChatPane.tsx (the real
  // integration): the parent sizes and slides the pane, ChatDrawer fills it.
  return (
    <div className={clsx('relative flex h-dvh w-full overflow-hidden bg-bg text-text', variant === 'column' ? 'flex-row' : 'flex-col')}>
      {variant === 'sheet' && (
        <>
          <Stage className={open ? 'aspect-video w-full shrink-0' : 'w-full min-h-0 flex-1'} />
          <div className={clsx('relative w-full min-h-0 motion', open ? 'flex-1' : 'h-12 shrink-0')}>
            <ChatDrawer variant="sheet" />
          </div>
        </>
      )}
      {variant === 'drawer' && (
        <>
          <Stage className="absolute inset-0" showToggle />
          <div
            className={clsx('absolute inset-y-0 right-0 z-40 w-[70%] max-w-[380px] motion', open ? 'translate-x-0' : 'pointer-events-none translate-x-full')}
            aria-hidden={!open}
          >
            <ChatDrawer variant="drawer" />
          </div>
        </>
      )}
      {variant === 'column' && (
        <>
          <div className="grid h-full min-w-0 flex-1 place-items-center p-6">
            <Stage className="aspect-video w-full max-w-[1100px] rounded-[20px]" />
          </div>
          <aside className={clsx('h-full shrink-0 overflow-hidden border-l border-line motion', open ? 'w-[360px]' : 'w-14')}>
            <ChatDrawer variant="column" />
          </aside>
        </>
      )}
      <ReactionsOverlay />
      {showBar && <DevBar variant={variant} onVariant={setVariant} />}
    </div>
  );
}

/** A fake video frame with a controls row so the overlay and drawer have something to sit on. */
function Stage({ className, showToggle }: { className?: string; showToggle?: boolean }) {
  const open = useApp((s) => s.chat.open);
  const unread = useApp((s) => s.chat.unread);
  return (
    <div className={clsx(!className?.includes('absolute') && 'relative', 'overflow-hidden bg-black', className)}>
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 70% 35%, #d08a3c 0%, #8a4a1f 28%, #3a1c0c 55%, #0b0704 85%), linear-gradient(180deg, #000 0%, transparent 30%)',
        }}
      />
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-10">
        <span className="tnum text-[12px] text-white/80">1:12:40 / 2:46:00</span>
        <div className="flex-1" />
        <ReactionButtons size="sm" />
        <div className="flex-1" />
        {showToggle && (
          <button
            type="button"
            onClick={() => useApp.getState().setChatOpen(!open)}
            aria-label="Toggle chat"
            className="relative grid h-11 w-11 place-items-center rounded-full text-white/90"
          >
            <MessageCircle size={22} />
            <UnreadBadge count={unread} className="absolute -right-0.5 top-0" />
          </button>
        )}
      </div>
    </div>
  );
}

function DevBar({ variant, onVariant }: { variant: ChatVariant; onVariant: (v: ChatVariant) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const gifs = useApp((s) => s.gifSearchAvailable);
  const [miaTyping, setMiaTyping] = useState(false);
  useEffect(() => devApi.typing(miaTyping), [miaTyping]);
  const btn = 'h-7 rounded-full border border-white/10 bg-white/10 px-2.5 text-[11px] font-medium hover:bg-white/20';
  if (collapsed) {
    return (
      <button type="button" onClick={() => setCollapsed(false)} className={clsx(btn, 'fixed left-2 top-2 z-[100]')}>
        dev
      </button>
    );
  }
  return (
    <div className="glass fixed left-2 top-2 z-[100] flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-1 rounded-2xl p-1.5">
      {(['sheet', 'drawer', 'column'] as const).map((v) => (
        <button key={v} type="button" onClick={() => onVariant(v)} className={clsx(btn, v === variant && 'bg-accent/60')}>
          {v}
        </button>
      ))}
      <button type="button" className={btn} onClick={() => devApi.incoming()}>
        Mia msg
      </button>
      <button type="button" className={btn} onClick={() => devApi.incomingGif()}>
        Mia GIF
      </button>
      <button type="button" className={btn} onClick={() => setMiaTyping((t) => !t)}>
        typing {miaTyping ? 'off' : 'on'}
      </button>
      <button type="button" className={btn} onClick={() => react('cheer')}>
        👏
      </button>
      <button type="button" className={btn} onClick={() => react('boo')}>
        🍅
      </button>
      <button type="button" className={btn} onClick={() => react('heart')}>
        ❤️
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => {
          react('cheer');
          react('boo');
          react('heart');
          react('cheer');
        }}
      >
        ×4
      </button>
      <button type="button" className={btn} onClick={() => devApi.gifs(!gifs)}>
        GIFs {gifs ? 'on' : 'off'}
      </button>
      <button type="button" className={btn} onClick={() => setCollapsed(true)}>
        hide
      </button>
    </div>
  );
}
