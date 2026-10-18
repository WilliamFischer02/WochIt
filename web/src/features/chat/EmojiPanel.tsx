// The emoji picker area above the composer. emoji-picker-element is loaded with import() on the
// first open so it stays out of the main bundle.
import { useEffect, useRef, useState } from 'react';
import type Picker from 'emoji-picker-element/picker';
import type { EmojiClickEvent } from 'emoji-picker-element/shared';

type EmojiModule = typeof import('emoji-picker-element');

/**
 * Where the picker fetches its emoji data. undefined = the library default (jsdelivr CDN, about
 * 440 KB once, then cached in IndexedDB). Point it at a self-hosted copy of
 * emoji-picker-element-data's en/emojibase/data.json to keep the browser off third-party CDNs.
 */
export const EMOJI_DATA_SOURCE: string | undefined = undefined;

let loading: Promise<EmojiModule> | null = null;
let warmed = false;

export function loadEmojiPicker(): Promise<EmojiModule> {
  loading ??= import('emoji-picker-element').catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Load the component and prime the emoji database in the background (composer focus/hover). */
export function warmEmojiPicker(): void {
  if (warmed) return;
  warmed = true;
  loadEmojiPicker()
    .then(async ({ Database }) => {
      const db = new Database(EMOJI_DATA_SOURCE ? { dataSource: EMOJI_DATA_SOURCE } : {});
      await db.ready();
      await db.close();
    })
    .catch(() => {
      warmed = false;
    });
}

const isDefined = () => typeof customElements !== 'undefined' && customElements.get('emoji-picker') !== undefined;

export default function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const [ready, setReady] = useState(isDefined);
  const [failed, setFailed] = useState(false);
  const ref = useRef<Picker>(null);
  const pickRef = useRef(onPick);
  useEffect(() => {
    pickRef.current = onPick;
  });

  useEffect(() => {
    if (ready) return;
    let alive = true;
    loadEmojiPicker().then(
      () => alive && setReady(true),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [ready]);

  useEffect(() => {
    const el = ref.current;
    if (!ready || !el) return;
    const handler = (e: EmojiClickEvent) => {
      const unicode = e.detail.unicode;
      if (unicode) pickRef.current(unicode);
    };
    el.addEventListener('emoji-click', handler);
    return () => el.removeEventListener('emoji-click', handler);
  }, [ready]);

  if (failed) {
    return <p className="grid h-full place-items-center px-6 text-center text-[13px] text-muted">The emoji picker failed to load. Your keyboard's emoji still work.</p>;
  }
  if (!ready) {
    return <div className="wc-skeleton h-full rounded-2xl" aria-label="Loading emoji" role="status" />;
  }
  return <emoji-picker ref={ref} className="dark wc-emoji" data-source={EMOJI_DATA_SOURCE} />;
}
