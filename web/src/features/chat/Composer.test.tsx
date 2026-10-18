import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { C2S } from '@wochit/shared';
import { useApp } from '../../app/store';
import Composer from './Composer';
import { TYPING_IDLE_MS } from './hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: C2S[] = [];
const initial = useApp.getState();
let host: HTMLDivElement;
let root: Root;

function textarea(): HTMLTextAreaElement {
  const el = host.querySelector('textarea');
  if (!el) throw new Error('no textarea');
  return el;
}

function type(value: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  useApp.setState({
    ...initial,
    you: { id: 'me', nick: 'William', isHost: true, typing: false },
    send: (msg: C2S) => {
      sent.push(msg);
      return true;
    },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Composer variant="sheet" />));
  // The draft deliberately survives remounts (module-level); start each test empty.
  type('');
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Composer', () => {
  it('sends typing on once, then off after 2 s idle', () => {
    type('h');
    type('he');
    type('hey');
    expect(sent).toEqual([{ type: 'typing', on: true }]);
    act(() => vi.advanceTimersByTime(TYPING_IDLE_MS - 1));
    expect(sent).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(sent).toEqual([
      { type: 'typing', on: true },
      { type: 'typing', on: false },
    ]);
  });

  it('Enter sends trimmed text, clears the field and stops typing; Shift+Enter does not send', () => {
    type('  hello there  ');
    press('Enter', { shiftKey: true });
    expect(sent.filter((m) => m.type === 'chat')).toHaveLength(0);
    press('Enter');
    expect(sent).toEqual([
      { type: 'typing', on: true },
      { type: 'chat', kind: 'text', text: 'hello there' },
      { type: 'typing', on: false },
    ]);
    expect(textarea().value).toBe('');
  });

  it('keeps the draft and says so when the socket is down', () => {
    useApp.setState({ send: () => false });
    type('offline msg');
    press('Enter');
    expect(textarea().value).toBe('offline msg');
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/Not connected/);
  });

  it('shows the send button only when there is text', () => {
    expect(host.querySelector('button[aria-label="Send"]')).toBeNull();
    type('x');
    expect(host.querySelector('button[aria-label="Send"]')).not.toBeNull();
  });
});
