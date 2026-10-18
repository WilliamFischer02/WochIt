// Attaches the room's media to a <video>: hls.js where MSE exists, native HLS otherwise (iOS
// Safari). Publishes quality levels and a `setLevel` API into the player store. hls.js is loaded
// on demand so the connect screen does not pay for it.
import type Hls from 'hls.js';
import { useEffect, type RefObject } from 'react';
import type { MediaInfo, RenditionId } from '@wochit/shared';
import { useApp } from '../../app/store';
import { canPlayNativeHls } from '../../lib/device';
import { resolveMediaUrl } from '../../lib/media';
import { roomPositionNow } from '../controls/intents';
import { defaultSubtitleId } from '../subtitles/subtitleUtils';
import { usePlayer, type QualityLevel } from './playerStore';

function levelLabel(height: number, kbps: number): string {
  return `${height}p · ${kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`}`;
}

function renditionIdFor(media: MediaInfo, height: number): RenditionId | null {
  return media.renditions.find((r) => r.height === height)?.id ?? null;
}

let hlsModule: Promise<typeof Hls> | null = null;
function loadHls(): Promise<typeof Hls> {
  hlsModule ??= import('hls.js').then((m) => m.default);
  return hlsModule;
}

export function useHlsPlayer(videoRef: RefObject<HTMLVideoElement | null>, media: MediaInfo | null): void {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const mediaToken = useApp((s) => s.mediaToken);

  useEffect(() => {
    const video = videoRef.current;
    const store = usePlayer.getState();
    store.resetForMedia(media?.id ?? null, media ? defaultSubtitleId(media.subtitles) : null);
    const patch = store.patch;
    if (!video || !media) {
      patch({ hasVideo: false, api: null, engine: null });
      return;
    }
    const master = resolveMediaUrl(media.masterUrl, hostOrigin, mediaToken);
    let cancelled = false;
    let hls: Hls | null = null;
    let pendingMeta: (() => void) | null = null;

    const attachNative = () => {
      if (!canPlayNativeHls(video)) console.error('Neither MSE nor native HLS is available in this browser');
      // Native HLS (Safari): quality is chosen by swapping the source and seeking back to the room.
      video.src = master;
      const levels: QualityLevel[] = media.renditions.map((r, index) => ({
        index,
        height: r.height,
        bitrateKbps: r.bitrateKbps,
        renditionId: r.id,
        label: levelLabel(r.height, r.bitrateKbps),
      }));
      patch({
        levels,
        engine: 'native',
        hasVideo: true,
        api: {
          setLevel: (index) => {
            const rendition = index === -1 ? null : media.renditions[index];
            const wasPlaying = !video.paused;
            if (pendingMeta) video.removeEventListener('loadedmetadata', pendingMeta);
            patch({ switching: true, currentLevel: index });
            video.src = rendition ? resolveMediaUrl(rendition.playlistUrl, hostOrigin, mediaToken) : master;
            pendingMeta = () => {
              pendingMeta = null;
              video.currentTime = roomPositionNow();
              if (wasPlaying) void video.play().catch(() => undefined);
              patch({ switching: false, activeHeight: rendition?.height ?? null });
            };
            video.addEventListener('loadedmetadata', pendingMeta, { once: true });
            video.load();
          },
        },
      });
    };

    const attachHls = (HlsCtor: typeof Hls) => {
      const startPos = roomPositionNow();
      const instance = new HlsCtor({
        startPosition: startPos > 0.5 ? startPos : -1,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 90,
      });
      hls = instance;
      instance.on(HlsCtor.Events.MANIFEST_PARSED, (_e, data) => {
        const levels: QualityLevel[] = data.levels.map((l, index) => {
          const kbps = Math.round(l.bitrate / 1000);
          return { index, height: l.height, bitrateKbps: kbps, renditionId: renditionIdFor(media, l.height), label: levelLabel(l.height, kbps) };
        });
        patch({ levels, engine: 'hls', hasVideo: true });
      });
      instance.on(HlsCtor.Events.LEVEL_SWITCHED, (_e, data) => {
        patch({ activeHeight: instance.levels[data.level]?.height ?? null });
      });
      instance.on(HlsCtor.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
          setTimeout(() => instance.startLoad(), 1000);
        } else if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
          instance.recoverMediaError();
        } else {
          console.error('hls fatal', data);
        }
      });
      instance.loadSource(master);
      instance.attachMedia(video);
      patch({
        engine: 'hls',
        hasVideo: true,
        api: {
          setLevel: (index) => {
            instance.currentLevel = index;
            patch({ currentLevel: index });
          },
        },
      });
    };

    // Safari has native HLS and no (usable) MSE for this: prefer native there without loading hls.js.
    const nativeFirst = canPlayNativeHls(video) && typeof MediaSource === 'undefined';
    if (nativeFirst) {
      attachNative();
    } else {
      void loadHls().then((HlsCtor) => {
        if (cancelled) return;
        if (HlsCtor.isSupported()) attachHls(HlsCtor);
        else attachNative();
      });
    }

    return () => {
      cancelled = true;
      if (hls) {
        hls.destroy();
        hls = null;
      } else {
        if (pendingMeta) video.removeEventListener('loadedmetadata', pendingMeta);
        video.removeAttribute('src');
        video.load();
      }
      usePlayer.getState().patch({ hasVideo: false, api: null, engine: null, levels: [] });
    };
  }, [videoRef, media, hostOrigin, mediaToken]);
}
