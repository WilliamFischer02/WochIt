// Player-local UI state (nothing here crosses the wire). VideoStage writes, controls read.
import { create } from 'zustand';
import type { RenditionId } from '@wochit/shared';
import type { SyncController, SyncSnapshot } from '../sync/syncController';
import { loadPref, savePref } from '../../lib/storage';

export interface QualityLevel {
  /** hls.js level index, or index into media.renditions on native HLS. */
  index: number;
  height: number;
  bitrateKbps: number;
  renditionId: RenditionId | null;
  label: string;
}

export type SubSize = 'S' | 'M' | 'L';
export type PlayerMenu = 'subs' | 'quality' | null;

export interface PlayerApi {
  setLevel(index: number): void;
}

export interface PlayerState {
  controller: SyncController | null;
  api: PlayerApi | null;
  engine: 'hls' | 'native' | null;
  levels: QualityLevel[];
  /** -1 = auto. */
  currentLevel: number;
  /** Height actually being rendered right now (auto may differ from the choice). */
  activeHeight: number | null;
  /** Native HLS: a source swap is in flight. */
  switching: boolean;
  buffered: Array<[number, number]>;
  bufferedAheadSec: number;
  buffering: boolean;
  currentTime: number;
  duration: number;
  sync: SyncSnapshot;
  /** iOS gesture gate: false until the user tapped "Tap to join playback". */
  gateOpen: boolean;
  subtitleId: string | null;
  subSize: SubSize;
  volume: number;
  muted: boolean;
  menu: PlayerMenu;
  fullscreen: boolean;
  /** Host view: mount the video stage too ("Show video here too"). */
  showVideoOnHost: boolean;
  /** True while a <video> is mounted and has a source. */
  hasVideo: boolean;

  patch(p: Partial<PlayerState>): void;
  setController(c: SyncController | null): void;
  setMenu(m: PlayerMenu): void;
  toggleMenu(m: Exclude<PlayerMenu, null>): void;
  setSubtitle(mediaId: string | null, id: string | null): void;
  setSubSize(s: SubSize): void;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  resetForMedia(mediaId: string | null, defaultSubtitleId: string | null): void;
}

const initialSync: SyncSnapshot = { syncStatus: 'waiting', driftSec: 0, target: null };

function initialSubSize(): SubSize {
  const s = loadPref('subsSize');
  return s === 'S' || s === 'L' ? s : 'M';
}

function initialVolume(): number {
  const v = Number(loadPref('volume'));
  return Number.isFinite(v) && v >= 0 && v <= 1 && loadPref('volume') !== null ? v : 1;
}

export function loadSubtitleChoice(mediaId: string, fallback: string | null): string | null {
  const saved = loadPref(`subs.${mediaId}`);
  if (saved === null) return fallback;
  return saved === 'off' ? null : saved;
}

export const usePlayer = create<PlayerState>((set, get) => ({
  controller: null,
  api: null,
  engine: null,
  levels: [],
  currentLevel: -1,
  activeHeight: null,
  switching: false,
  buffered: [],
  bufferedAheadSec: 0,
  buffering: false,
  currentTime: 0,
  duration: 0,
  sync: initialSync,
  gateOpen: false,
  subtitleId: null,
  subSize: initialSubSize(),
  volume: initialVolume(),
  muted: false,
  menu: null,
  fullscreen: false,
  showVideoOnHost: false,
  hasVideo: false,

  patch: (p) => set(p),
  setController: (controller) => set({ controller }),
  setMenu: (menu) => set({ menu }),
  toggleMenu: (m) => set({ menu: get().menu === m ? null : m }),
  setSubtitle: (mediaId, id) => {
    if (mediaId) savePref(`subs.${mediaId}`, id ?? 'off');
    set({ subtitleId: id });
  },
  setSubSize: (subSize) => {
    savePref('subsSize', subSize);
    set({ subSize });
  },
  setVolume: (volume) => {
    savePref('volume', String(volume));
    set({ volume, muted: volume === 0 ? get().muted : false });
  },
  setMuted: (muted) => set({ muted }),
  resetForMedia: (mediaId, defaultSubtitleId) =>
    set({
      engine: null,
      levels: [],
      currentLevel: -1,
      activeHeight: null,
      switching: false,
      buffered: [],
      bufferedAheadSec: 0,
      buffering: false,
      currentTime: 0,
      duration: 0,
      subtitleId: mediaId ? loadSubtitleChoice(mediaId, defaultSubtitleId) : null,
      menu: null,
    }),
}));
