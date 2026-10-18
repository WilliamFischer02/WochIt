import { useSyncExternalStore } from 'react';

// matchMedia-driven (event based, no resize listeners). Used only where a *different component*
// must be rendered per layout (the chat drawer variants); everything else is CSS.
export function useMediaQuery(query: string): boolean {
  const subscribe = (cb: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
    const mq = window.matchMedia(query);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  };
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, get, () => false);
}

export type Layout = 'portrait' | 'landscape' | 'desktop';

/** desktop ≥ 900 px; landscape = a phone/tablet on its side; portrait otherwise. */
export function useLayout(): Layout {
  const desktop = useMediaQuery('(min-width: 900px)');
  const landscape = useMediaQuery('(orientation: landscape)');
  if (desktop) return 'desktop';
  return landscape ? 'landscape' : 'portrait';
}
