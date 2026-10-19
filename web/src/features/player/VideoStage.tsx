// The picture: <video playsinline> + hls.js/native source, subtitle <track>s, the sync controller,
// and the overlays (waiting / gesture gate / buffering) with the controls on top.
import { useCallback, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { LoaderCircle, Play } from 'lucide-react';
import { useApp } from '../../app/store';
import { resolveMediaUrl } from '../../lib/media';
import Controls from '../controls/Controls';
import { useSyncController } from '../sync/useSyncController';
import { isSupportedSubtitle } from '../subtitles/subtitleUtils';
import { usePlayer } from './playerStore';
import { useHlsPlayer } from './useHlsPlayer';

export interface VideoStageProps {
  className?: string;
  /** Hide the overlay controls (e.g. a bare preview). */
  noControls?: boolean;
}

export default function VideoStage({ className, noControls }: VideoStageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const media = useApp((s) => s.media);
  const playback = useApp((s) => s.playback);
  const hostOrigin = useApp((s) => s.hostOrigin);
  const mediaToken = useApp((s) => s.mediaToken);
  const members = useApp((s) => s.members);
  const transcode = useApp((s) => s.transcode);
  const gateOpen = usePlayer((s) => s.gateOpen);
  const subtitleId = usePlayer((s) => s.subtitleId);
  const subSize = usePlayer((s) => s.subSize);
  const buffering = usePlayer((s) => s.buffering);
  const switching = usePlayer((s) => s.switching);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const activeHeight = usePlayer((s) => s.activeHeight);
  const patch = usePlayer((s) => s.patch);

  useSyncController(videoRef);
  useHlsPlayer(videoRef, media);

  // A fresh <video> needs a fresh gesture (iOS unlocks per element).
  useEffect(() => {
    patch({ gateOpen: false });
    return () => patch({ gateOpen: false, hasVideo: false });
  }, [patch]);

  // Time, duration, buffered ranges, stall detection.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    const updateBuffered = () => {
      const ranges: Array<[number, number]> = [];
      for (let i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i), v.buffered.end(i)]);
      const t = v.currentTime;
      let ahead = 0;
      for (const [s, e] of ranges) if (t >= s - 0.25 && t <= e) ahead = Math.max(ahead, e - t);
      usePlayer.getState().patch({ buffered: ranges, bufferedAheadSec: ahead });
    };
    const onTime = () => {
      usePlayer.getState().patch({ currentTime: v.currentTime });
      updateBuffered();
    };
    const onDuration = () => {
      const d = Number.isFinite(v.duration) ? v.duration : useApp.getState().media?.durationSec ?? 0;
      usePlayer.getState().patch({ duration: d });
    };
    // Safari (native HLS) fires `waiting` and `stalled` during perfectly smooth playback whenever a
    // segment fetch pauses for a moment, so an event alone is not a stall. Only a picture that has
    // actually stopped moving for a while earns the spinner; `timeupdate` advancing clears it.
    const onWaiting = () => {
      if (waitTimer) return;
      const at = v.currentTime;
      waitTimer = setTimeout(() => {
        waitTimer = null;
        if (!v.paused && !v.seeking && Math.abs(v.currentTime - at) < 0.05) usePlayer.getState().patch({ buffering: true });
      }, 700);
    };
    let lastTime = v.currentTime;
    const onAdvance = () => {
      const moved = v.currentTime !== lastTime;
      lastTime = v.currentTime;
      if (moved && usePlayer.getState().buffering) usePlayer.getState().patch({ buffering: false });
    };
    const onOk = () => {
      if (waitTimer) {
        clearTimeout(waitTimer);
        waitTimer = null;
      }
      if (usePlayer.getState().buffering) usePlayer.getState().patch({ buffering: false });
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('timeupdate', onAdvance);
    v.addEventListener('seeked', onTime);
    v.addEventListener('progress', updateBuffered);
    v.addEventListener('durationchange', onDuration);
    v.addEventListener('loadedmetadata', onDuration);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onOk);
    v.addEventListener('canplay', onOk);
    v.addEventListener('pause', onOk);
    return () => {
      if (waitTimer) clearTimeout(waitTimer);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('timeupdate', onAdvance);
      v.removeEventListener('seeked', onTime);
      v.removeEventListener('progress', updateBuffered);
      v.removeEventListener('durationchange', onDuration);
      v.removeEventListener('loadedmetadata', onDuration);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onOk);
      v.removeEventListener('canplay', onOk);
      v.removeEventListener('pause', onOk);
    };
  }, []);

  // Subtitle track modes.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      for (const el of Array.from(v.querySelectorAll('track'))) {
        const want = el.dataset.id === subtitleId ? 'showing' : 'disabled';
        if (el.track.mode !== want) el.track.mode = want;
      }
    };
    apply();
    v.textTracks.addEventListener('addtrack', apply);
    const t = setTimeout(apply, 50);
    return () => {
      clearTimeout(t);
      v.textTracks.removeEventListener('addtrack', apply);
    };
  }, [subtitleId, media]);

  // Volume.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  // Fullscreen state.
  useEffect(() => {
    const onFs = () => usePlayer.getState().patch({ fullscreen: !!document.fullscreenElement });
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const openGate = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.muted = true;
      await v.play();
    } catch {
      // Autoplay refused even muted; the controller will try again on the next tick.
    }
    v.muted = usePlayer.getState().muted;
    if (!useApp.getState().playback?.playing) v.pause();
    usePlayer.getState().patch({ gateOpen: true });
  }, []);

  const hostNick = members.find((m) => m.isHost)?.nick ?? 'the host';
  const poster = media?.posterUrl ? resolveMediaUrl(media.posterUrl, hostOrigin, mediaToken) : undefined;
  const preparing = Object.entries(transcode).find(([, t]) => t && t.status !== 'done');
  const hintRendition = preparing?.[0] ?? (activeHeight ? `${activeHeight}p` : null);
  const showSpinner = media && gateOpen && (buffering || switching);

  return (
    <div ref={stageRef} className={clsx('relative h-full w-full overflow-hidden bg-black select-none', className)} data-testid="stage">
      <video
        ref={videoRef}
        playsInline
        preload="auto"
        poster={poster}
        // Cross-origin host (Vercel-served app): CORS mode lets <track> cues load; same-origin needs nothing.
        crossOrigin={hostOrigin && hostOrigin !== window.location.origin ? 'anonymous' : undefined}
        className={clsx('absolute inset-0 h-full w-full object-contain', `cue-${subSize.toLowerCase()}`)}
        data-testid="video"
      >
        {media?.subtitles.filter(isSupportedSubtitle).map((t) => (
          <track key={t.id} kind="subtitles" data-id={t.id} src={resolveMediaUrl(t.url, hostOrigin, mediaToken)} srcLang={t.lang ?? undefined} label={t.label} />
        ))}
      </video>

      {!media && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center" data-testid="waiting">
          <div className="animate-fade-in">
            <div className="mx-auto mb-4 size-12 rounded-full border border-line bg-surface-2/60" aria-hidden="true" />
            <p className="text-base text-muted">
              Waiting for <span className="text-text">{hostNick}</span> to pick something
            </p>
          </div>
        </div>
      )}

      {media && !gateOpen && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-black/55">
          <button
            type="button"
            onClick={() => void openGate()}
            data-testid="gate"
            className="glass flex items-center gap-3 rounded-pill px-6 py-4 text-lg font-semibold motion hover:bg-white/10 active:scale-95"
          >
            <Play size={24} fill="currentColor" aria-hidden="true" />
            Tap to join playback
          </button>
        </div>
      )}

      {showSpinner && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center" data-testid="buffering">
          <div className="glass flex flex-col items-center gap-2 rounded-xl px-5 py-4 text-sm">
            <LoaderCircle className="animate-spin" size={28} aria-hidden="true" />
            <span aria-live="polite">{switching ? 'Switching…' : preparing ? `Preparing ${hintRendition}…` : 'Buffering…'}</span>
          </div>
        </div>
      )}

      {media && !noControls && <Controls stageRef={stageRef} videoRef={videoRef} playing={!!playback?.playing} />}
    </div>
  );
}
