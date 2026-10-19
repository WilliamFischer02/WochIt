// Console-wide state the host screen needs beyond the room: the one /api/health poller (shared by
// the readiness panel, the share card and the footer, so there is a single 10 s interval however
// many of them are mounted) and the "host stopped" flag after POST /api/host/shutdown.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { HealthResponse } from '@wochit/shared';
import { useApp } from '../../app/store';
import { fetchHealth } from '../../lib/hostApi';

export const HEALTH_POLL_MS = 10_000;

export interface HostConsoleState {
  /** Last good /api/health answer; kept across a failed poll so the rows do not blank out. */
  health: HealthResponse | null;
  /** Date.now() of the last good answer, null before the first. */
  healthAt: number | null;
  /** Polls failed in a row since the last good answer. */
  healthFailures: number;
  /** The host agent confirmed it is shutting down; the console shows the "Host stopped" card. */
  stopped: boolean;
  receiveHealth(h: HealthResponse | null): void;
  setStopped(): void;
  resetConsole(): void;
}

export const useHostConsole = create<HostConsoleState>((set, get) => ({
  health: null,
  healthAt: null,
  healthFailures: 0,
  stopped: false,
  receiveHealth: (h) => (h ? set({ health: h, healthAt: Date.now(), healthFailures: 0 }) : set({ healthFailures: get().healthFailures + 1 })),
  setStopped: () => set({ stopped: true }),
  resetConsole: () => set({ health: null, healthAt: null, healthFailures: 0, stopped: false }),
}));

// ---- the poller (module state: one per page, ref-counted by useHostHealth subscribers)
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let origin: string | null = null;
let inflight: Promise<void> | null = null;

/** Re-read /api/health now (after a settings change, say). Coalesces concurrent calls. */
export function refreshHealth(): Promise<void> {
  const target = origin ?? useApp.getState().hostOrigin ?? window.location.origin;
  if (inflight) return inflight;
  inflight = fetchHealth(target)
    .then((h) => useHostConsole.getState().receiveHealth(h))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function startPolling(at: string): void {
  stopPolling();
  origin = at;
  void refreshHealth();
  timer = setInterval(() => void refreshHealth(), HEALTH_POLL_MS);
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export interface HostHealth {
  health: HealthResponse | null;
  healthAt: number | null;
  /** True once a poll has failed after the host had answered (or never answered at all). */
  unreachable: boolean;
  refresh(): Promise<void>;
}

/** Subscribe to the shared health poller for as long as the component is mounted. */
export function useHostHealth(): HostHealth {
  const hostOrigin = useApp((s) => s.hostOrigin);
  const health = useHostConsole((s) => s.health);
  const healthAt = useHostConsole((s) => s.healthAt);
  const failures = useHostConsole((s) => s.healthFailures);

  useEffect(() => {
    const at = hostOrigin ?? window.location.origin;
    subscribers++;
    if (subscribers === 1 || origin !== at) startPolling(at);
    return () => {
      subscribers--;
      if (subscribers === 0) {
        stopPolling();
        origin = null;
      }
    };
  }, [hostOrigin]);

  return { health, healthAt, unreachable: failures > 0, refresh: refreshHealth };
}
