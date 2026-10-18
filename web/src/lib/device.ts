// Feature detection, evaluated lazily so the module is safe to import under jsdom.

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(hover: none)').matches;
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iP(hone|ad|od)/.test(ua)) return true;
  // iPadOS 13+ reports as a Mac; the touch check tells it apart.
  return ua.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document;
}

/** Native HLS (Safari) available on this <video>? */
export function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

interface IOSVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

/** Fullscreen on the stage container where supported, else iOS's video-only fullscreen. */
export async function toggleFullscreen(container: HTMLElement, video: HTMLVideoElement | null): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => undefined);
    return;
  }
  if (document.fullscreenEnabled && container.requestFullscreen) {
    await container.requestFullscreen().catch(() => undefined);
    return;
  }
  const v = video as IOSVideoElement | null;
  v?.webkitEnterFullscreen?.();
}
