// Desktop keyboard (docs/UI.md § Accessibility): Space play/pause, ←/→ ±5 s, C chat, S subtitles,
// 1/2/3 reactions, Esc closes panels. Ignored while typing.
import { useEffect } from 'react';
import { control, seekRelative } from '../features/controls/intents';
import { usePlayer } from '../features/player/playerStore';
import { sendReaction } from '../features/reactions/reactionGate';
import { useApp } from './store';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || target.closest('[contenteditable=""],[contenteditable="true"]') !== null;
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState();
      if (app.view === 'connect') return;
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      const player = usePlayer.getState();
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          if (app.media) control('toggle');
          return;
        case 'ArrowLeft':
          if ((e.target as HTMLElement | null)?.getAttribute('role') === 'slider') return;
          e.preventDefault();
          if (app.media) seekRelative(-5);
          return;
        case 'ArrowRight':
          if ((e.target as HTMLElement | null)?.getAttribute('role') === 'slider') return;
          e.preventDefault();
          if (app.media) seekRelative(5);
          return;
        case 'c':
        case 'C':
          e.preventDefault();
          app.setChatOpen(!app.chat.open);
          return;
        case 's':
        case 'S':
          e.preventDefault();
          if (app.media) player.toggleMenu('subs');
          return;
        case 'q':
        case 'Q':
          e.preventDefault();
          if (app.media) player.toggleMenu('quality');
          return;
        case '1':
          sendReaction('cheer');
          return;
        case '2':
          sendReaction('boo');
          return;
        case '3':
          sendReaction('heart');
          return;
        case 'Escape':
          if (player.menu) player.setMenu(null);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
