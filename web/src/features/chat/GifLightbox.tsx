// Full-screen view of a GIF message's full-size `url`. Portalled to <body> so a transformed
// ancestor (the sliding drawer) cannot trap its position: fixed.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Gif } from '@wochit/shared';
import { isVideoUrl } from './chatUtils';

export default function GifLightbox({ gif, onClose }: { gif: Gif; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus({ preventScroll: true });
    };
  }, [onClose]);

  const ratio = `${gif.width} / ${gif.height}`;
  const label = gif.title?.trim() || 'GIF';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="wc-fade-in fixed inset-0 grid place-items-center bg-black/80 p-4 backdrop-blur-md"
      style={{ zIndex: 'var(--z-lightbox, 70)' }}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-[max(12px,env(safe-area-inset-right))] top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/10 text-text backdrop-blur-xl hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X size={22} />
      </button>
      <figure className="wc-pop-in flex max-h-full max-w-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <div
          className="overflow-hidden rounded-[20px] bg-surface-2 shadow-[0_8px_40px_rgba(0,0,0,.45)]"
          style={{ aspectRatio: ratio, width: `min(92vw, ${Math.max(gif.width, 320)}px, calc(78dvh * ${gif.width / gif.height}))` }}
        >
          {isVideoUrl(gif.url) ? (
            <video src={gif.url} poster={gif.previewUrl} autoPlay loop muted playsInline className="wc-media h-full w-full object-contain" />
          ) : (
            <img src={gif.url} alt={label} className="wc-media h-full w-full object-contain" draggable={false} />
          )}
        </div>
        {gif.title && <figcaption className="max-w-[80vw] truncate text-sm text-muted">{gif.title}</figcaption>}
      </figure>
    </div>,
    document.body,
  );
}
