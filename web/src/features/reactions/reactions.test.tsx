import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { C2S } from '@wochit/shared';
import { useApp } from '../../app/store';
import ReactionButtons from './ReactionButtons';
import ReactionsOverlay from './ReactionsOverlay';
import { LOCAL_GAP_MS, resetReactionGate, sendReaction, useReactionGate } from './reactionGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: C2S[] = [];
const initial = useApp.getState();

beforeEach(() => {
  sent.length = 0;
  resetReactionGate();
  useApp.setState({
    ...initial,
    you: { id: 'me', nick: 'William', isHost: true, typing: false },
    send: (msg: C2S) => {
      sent.push(msg);
      return true;
    },
  });
});

describe('sendReaction gate', () => {
  it('sends, then refuses for the local gap, then allows again', () => {
    expect(sendReaction('cheer', 1000)).toBe(true);
    expect(useReactionGate.getState().cooling).toBe(true);
    expect(sendReaction('boo', 1000 + LOCAL_GAP_MS - 1)).toBe(false);
    expect(sendReaction('boo', 1000 + LOCAL_GAP_MS)).toBe(true);
    expect(sent).toEqual([
      { type: 'reaction', kind: 'cheer' },
      { type: 'reaction', kind: 'boo' },
    ]);
  });

  it('does not start the gap when the socket is down', () => {
    useApp.setState({ send: () => false });
    expect(sendReaction('heart', 5000)).toBe(false);
    expect(useReactionGate.getState().cooling).toBe(false);
  });
});

describe('components', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no canvas backend; the overlay must cope with a null context.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ReactionButtons sends on tap and does not animate locally (no store reaction)', () => {
    act(() => root.render(<ReactionButtons size="sm" />));
    const buttons = host.querySelectorAll('button');
    expect([...buttons].map((b) => b.getAttribute('aria-label'))).toEqual(['Cheer', 'Boo', 'Heart']);
    expect(buttons[0]?.style.width).toBe('36px');
    act(() => buttons[1]?.click());
    expect(sent).toEqual([{ type: 'reaction', kind: 'boo' }]);
    expect(useApp.getState().reactions).toEqual([]);
    expect(buttons[0]?.getAttribute('aria-disabled')).toBe('true');
    act(() => buttons[0]?.click());
    expect(sent).toHaveLength(1);
  });

  it('ReactionsOverlay consumes server echoes and shows a toast for 1.4 s', () => {
    act(() => root.render(<ReactionsOverlay />));
    act(() => {
      useApp.getState().applyS2C({ type: 'reaction', kind: 'boo', from: { id: 'mia', nick: 'Mia' }, at: 1 });
      useApp.getState().applyS2C({ type: 'reaction', kind: 'heart', from: { id: 'me', nick: 'William' }, at: 2 });
    });
    expect(useApp.getState().reactions).toEqual([]);
    const toasts = () => [...host.querySelectorAll('.wc-reaction-toast')].map((t) => t.textContent);
    expect(toasts()).toEqual(['Mia 🍅Mia sent boo', 'You ❤️You sent heart']);
    act(() => vi.advanceTimersByTime(1399));
    expect(toasts()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(2));
    expect(toasts()).toHaveLength(0);
    expect(host.querySelector('canvas')?.className).toContain('wc-reactions-canvas');
  });
});
