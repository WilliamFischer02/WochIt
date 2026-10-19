// Binds a SyncController to a mounted <video>, the app store and the socket. Re-created when the
// socket changes (reconnect gives a new WochitSocket only if the user re-joins; the same instance
// reconnects by itself and keeps its handlers).
import { useEffect, useRef, type RefObject } from 'react';
import { useApp } from '../../app/store';
import { isTouchDevice } from '../../lib/device';
import { usePlayer } from '../player/playerStore';
import { SyncController, type SyncSnapshot } from './syncController';
import { buildTelemetry } from './telemetry';

export type { SyncSnapshot, SyncStatus } from './syncController';

export function useSyncController(videoRef: RefObject<HTMLVideoElement | null>): SyncSnapshot {
  const socket = useApp((s) => s.socket);
  const socketStatus = useApp((s) => s.socketStatus);
  const sync = usePlayer((s) => s.sync);
  const ctlRef = useRef<SyncController | null>(null);
  // Stall tracking for telemetry: a `waiting` since the last `playing` / advancing `timeupdate`.
  const stalledRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let lastTime = video.currentTime;
    const onWaiting = () => {
      stalledRef.current = true;
    };
    const onPlaying = () => {
      stalledRef.current = false;
    };
    const onTime = () => {
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        stalledRef.current = false;
      }
    };
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onTime);
    return () => {
      stalledRef.current = false;
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTime);
    };
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !socket) return;
    const ctl = new SyncController({
      video,
      getState: () => useApp.getState().playback,
      send: (m) => useApp.getState().send(m),
      onPong: (h) => socket.on('pong', h),
      onOffset: (ms) => useApp.getState().setServerOffset(ms),
      onSnapshot: (snap) => usePlayer.getState().patch({ sync: snap }),
      canPlay: () => usePlayer.getState().gateOpen,
      seekLeadSec: isTouchDevice() ? 0.3 : 0,
      // Only guests report; the host PC's own preview ("Show video here too") stays silent.
      telemetry: (rttMs) => {
        const app = useApp.getState();
        if (app.view === 'host' || app.you?.isHost) return null;
        const p = usePlayer.getState();
        return buildTelemetry(video, {
          engine: p.engine,
          hasVideo: p.hasVideo,
          activeHeight: p.activeHeight,
          currentLevel: p.currentLevel,
          levels: p.levels,
          stalled: stalledRef.current,
          rttMs,
        });
      },
    });
    ctlRef.current = ctl;
    usePlayer.getState().setController(ctl);
    ctl.start();
    // React to room changes and the gesture gate at once instead of waiting for the next tick.
    const unsubApp = useApp.subscribe((s, prev) => {
      if (s.playback !== prev.playback || s.media !== prev.media) ctl.tick();
    });
    const unsubPlayer = usePlayer.subscribe((s, prev) => {
      if (s.gateOpen !== prev.gateOpen) ctl.tick();
    });
    return () => {
      unsubApp();
      unsubPlayer();
      ctl.stop();
      if (usePlayer.getState().controller === ctl) usePlayer.getState().setController(null);
      ctlRef.current = null;
    };
  }, [socket, videoRef]);

  // After a reconnect the clock may have drifted: burst-ping again.
  useEffect(() => {
    if (socketStatus === 'open') ctlRef.current?.resyncClock();
  }, [socketStatus]);

  return sync;
}
