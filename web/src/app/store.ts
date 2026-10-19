// Single zustand store shared by every feature. The player agent owns connection/room/playback
// slices; the chat agent owns chat/reactions slices and may add keys under them. `applyS2C` is
// the one place server messages mutate state, so both agents extend it rather than listening to
// the socket separately.
import { create } from 'zustand';
import type { C2S, ChatMessage, ErrorCode, MediaInfo, Member, MemberTelemetry, PlaybackState, ReactionKind, RenditionId, S2C } from '@wochit/shared';
import type { SocketStatus, WochitSocket } from '../lib/socket';

export type View = 'connect' | 'guest' | 'host';

export interface ReactionEvent {
  id: number;
  kind: ReactionKind;
  from: { id: string; nick: string };
  at: number;
}

export interface TranscodeInfo {
  status: 'starting' | 'running' | 'done' | 'error';
  readyToSec?: number;
  message?: string;
}

export interface AppState {
  // ---- connection (player agent)
  socket: WochitSocket | null;
  socketStatus: SocketStatus;
  /** Last error from the server, cleared on the next welcome. */
  lastError: { code: ErrorCode; message: string } | null;
  hostOrigin: string | null;
  /** The room PIN the user joined with; needed as `x-wochit-pin` on REST calls (library, gifs). */
  pin: string | null;
  view: View;
  /** Host-clock minus local-clock, ms. Set by the sync controller from ClockSync. */
  serverOffset: number;

  // ---- room (player agent)
  you: Member | null;
  members: Member[];
  playback: PlaybackState | null;
  media: MediaInfo | null;
  mediaToken: string | null;
  gifSearchAvailable: boolean;
  vlc: { connected: boolean; following: boolean };
  /** Encode progress per rendition for the current media; cleared when the media changes. */
  transcode: Partial<Record<RenditionId, TranscodeInfo>>;
  /** Host connections only: every guest's latest player report (S2C `telemetry`). Cleared on disconnect. */
  telemetry: MemberTelemetry[];

  // ---- chat + reactions (chat agent)
  chat: {
    messages: ChatMessage[];
    unread: number;
    open: boolean;
  };
  /** Pending reaction events; the overlay consumes and removes them by id. */
  reactions: ReactionEvent[];

  // ---- actions
  setSocket(socket: WochitSocket | null): void;
  setSocketStatus(s: SocketStatus): void;
  setHostOrigin(origin: string | null): void;
  setPin(pin: string | null): void;
  setView(v: View): void;
  setServerOffset(ms: number): void;
  setLastError(err: { code: ErrorCode; message: string } | null): void;
  /** Proxy to the socket; false when not connected. */
  send(msg: C2S): boolean;
  /** The single reducer for server messages. */
  applyS2C(msg: S2C): void;
  setChatOpen(open: boolean): void;
  markChatRead(): void;
  consumeReactions(ids: number[]): void;
  reset(): void;
}

let reactionSeq = 0;

const initial = {
  socket: null,
  socketStatus: 'idle' as SocketStatus,
  lastError: null,
  hostOrigin: null,
  pin: null,
  view: 'connect' as View,
  serverOffset: 0,
  you: null,
  members: [],
  playback: null,
  media: null,
  mediaToken: null,
  gifSearchAvailable: false,
  vlc: { connected: false, following: true },
  transcode: {},
  telemetry: [] as MemberTelemetry[],
  chat: { messages: [], unread: 0, open: false },
  reactions: [],
};

export const useApp = create<AppState>((set, get) => ({
  ...initial,

  setSocket: (socket) => set({ socket }),
  // Telemetry is only as fresh as the connection: drop it the moment the socket is gone.
  setSocketStatus: (socketStatus) => set(socketStatus === 'open' || socketStatus === 'connecting' ? { socketStatus } : { socketStatus, telemetry: [] }),
  setHostOrigin: (hostOrigin) => set({ hostOrigin }),
  setPin: (pin) => set({ pin }),
  setView: (view) => set({ view }),
  setServerOffset: (serverOffset) => set({ serverOffset }),
  setLastError: (lastError) => set({ lastError }),

  send: (msg) => get().socket?.send(msg) ?? false,

  applyS2C: (msg) => {
    switch (msg.type) {
      case 'welcome':
        set({
          lastError: null,
          you: msg.you,
          members: msg.room.members,
          playback: msg.room.state,
          media: msg.room.media,
          mediaToken: msg.mediaToken,
          gifSearchAvailable: msg.gifSearchAvailable,
          vlc: msg.vlc,
          chat: { ...get().chat, messages: msg.room.recentChat },
          view: msg.you.isHost ? 'host' : 'guest',
        });
        return;
      case 'pong':
        return; // handled by the sync controller, which subscribes directly
      case 'state': {
        const cur = get().playback;
        if (cur && msg.state.seq < cur.seq) return;
        set({ playback: msg.state });
        return;
      }
      case 'media':
        set({ media: msg.media, transcode: {} });
        return;
      case 'presence':
        set({ members: msg.members });
        return;
      case 'chat': {
        const { chat } = get();
        const unread = chat.open ? 0 : chat.unread + (msg.message.kind === 'system' ? 0 : 1);
        set({ chat: { ...chat, messages: [...chat.messages.slice(-199), msg.message], unread } });
        return;
      }
      case 'reaction':
        set({ reactions: [...get().reactions, { id: ++reactionSeq, kind: msg.kind, from: msg.from, at: msg.at }] });
        return;
      case 'transcode': {
        // Progress for another media (a late message after a switch) must not paint the current one.
        const current = get().media;
        if (current && msg.mediaId !== current.id) return;
        set({
          transcode: {
            ...get().transcode,
            [msg.rendition]: { status: msg.status, readyToSec: msg.readyToSec, message: msg.message },
          },
        });
        return;
      }
      case 'vlc':
        set({ vlc: { connected: msg.connected, following: msg.following } });
        return;
      case 'telemetry':
        set({ telemetry: msg.members });
        return;
      case 'error':
        set({ lastError: { code: msg.code, message: msg.message } });
        return;
    }
  },

  setChatOpen: (open) => set({ chat: { ...get().chat, open, unread: open ? 0 : get().chat.unread } }),
  markChatRead: () => set({ chat: { ...get().chat, unread: 0 } }),
  consumeReactions: (ids) => set({ reactions: get().reactions.filter((r) => !ids.includes(r.id)) }),

  reset: () => {
    get().socket?.close();
    set({ ...initial });
  },
}));
