// Local intents go through the sync controller when a <video> is mounted (optimistic apply +
// reconcile), else straight to the socket (host view without video = pure remote).
import { expectedPosition } from '@wochit/shared';
import { useEffect, useState } from 'react';
import { useApp } from '../../app/store';
import { usePlayer } from '../player/playerStore';
import type { ControlAction } from '../sync/syncController';

export function control(action: ControlAction, position?: number): void {
  const ctl = usePlayer.getState().controller;
  if (ctl) {
    ctl.intent(action, position);
    return;
  }
  const msg = action === 'seek' ? { type: 'control' as const, action, position: Math.max(0, position ?? 0) } : { type: 'control' as const, action };
  useApp.getState().send(msg);
}

/** Where the room clock says the media is right now (projected with the measured offset). */
export function roomPositionNow(): number {
  const { playback, serverOffset, media } = useApp.getState();
  if (!playback || !playback.mediaId) return 0;
  const pos = expectedPosition(playback, Date.now() + serverOffset);
  const dur = media?.durationSec ?? Infinity;
  return Math.min(Math.max(0, pos), dur);
}

/** The best known "now" position: the local video when there is one, else the projected clock. */
export function currentPosition(): number {
  const p = usePlayer.getState();
  if (p.hasVideo && p.controller) return p.currentTime;
  return roomPositionNow();
}

/** Projected room position, re-evaluated every `everyMs` while playing (for views without video). */
export function useRoomPosition(everyMs = 250): number {
  const playback = useApp((s) => s.playback);
  const serverOffset = useApp((s) => s.serverOffset);
  const [pos, setPos] = useState(() => roomPositionNow());
  useEffect(() => {
    setPos(roomPositionNow());
    if (!playback?.playing) return;
    const id = setInterval(() => setPos(roomPositionNow()), everyMs);
    return () => clearInterval(id);
  }, [playback, serverOffset, everyMs]);
  return pos;
}

export function seekRelative(deltaSec: number): void {
  const dur = useApp.getState().media?.durationSec;
  let to = currentPosition() + deltaSec;
  if (to < 0) to = 0;
  if (dur !== undefined && to > dur) to = dur;
  control('seek', to);
}
