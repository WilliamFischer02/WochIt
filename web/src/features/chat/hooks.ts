// Small browser hooks shared by the chat, GIF and reactions features.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { useApp } from '../../app/store';

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener('change', cb);
    return () => mql.removeEventListener('change', cb);
  };
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

/** Touch-first device: no hover, fat fingers, on-screen keyboard. */
export const useCoarsePointer = () => useMediaQuery('(pointer: coarse)');

export const TYPING_IDLE_MS = 2000;

/**
 * Sends `typing on` on the first keystroke and `typing off` after 2 s idle, on send, or on
 * unmount. Reads `send` from the store at call time so it never holds a stale socket.
 */
export function useTypingSignal(): { ping: () => void; stop: () => void } {
  const on = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (on.current) {
      on.current = false;
      useApp.getState().send({ type: 'typing', on: false });
    }
  }, []);

  const ping = useCallback(() => {
    if (!on.current) on.current = useApp.getState().send({ type: 'typing', on: true });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(stop, TYPING_IDLE_MS);
  }, [stop]);

  useEffect(() => stop, [stop]);
  return useMemo(() => ({ ping, stop }), [ping, stop]);
}

/** Calls `onLongPress` after 450 ms of a still touch. Spread the handlers on the target. */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') return;
      cancel();
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
  };
}
