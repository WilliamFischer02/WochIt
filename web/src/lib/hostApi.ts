// Thin REST client for the host agent (docs/PROTOCOL.md § REST). Everything validates with the
// shared zod schemas so a wrong server (Vercel's SPA fallback returning index.html) is detected.
import { HealthResponse, HostSettingsResponse, LibraryResponse, ShutdownResponse, type HostSettingsPatch } from '@wochit/shared';

async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 4000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `null` when `origin` does not answer like a WochIt host (so: show the Host URL field). */
export async function fetchHealth(origin: string): Promise<HealthResponse | null> {
  try {
    const data = await fetchJson(new URL('/api/health', origin).toString(), { timeoutMs: 2500 });
    const parsed = HealthResponse.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function fetchLibrary(origin: string, pin: string, parent: string | null): Promise<LibraryResponse> {
  const u = new URL('/api/library', origin);
  if (parent) u.searchParams.set('parent', parent);
  const data = await fetchJson(u.toString(), { headers: { 'x-wochit-pin': pin } });
  const parsed = LibraryResponse.safeParse(data);
  if (!parsed.success) throw new ApiError(500, 'Unexpected library response');
  return parsed.data;
}

// ---- host-only console endpoints (loopback + PIN header, like the library)

function hostHeaders(pin: string, json = false): Record<string, string> {
  return json ? { 'x-wochit-pin': pin, 'content-type': 'application/json' } : { 'x-wochit-pin': pin };
}

export async function fetchHostSettings(origin: string, pin: string): Promise<HostSettingsResponse> {
  const data = await fetchJson(new URL('/api/host/settings', origin).toString(), { headers: hostHeaders(pin) });
  const parsed = HostSettingsResponse.safeParse(data);
  if (!parsed.success) throw new ApiError(500, 'Unexpected settings response');
  return parsed.data;
}

/** Writes the given keys into the host's .env; an empty string removes a key. Keys never come back. */
export async function patchHostSettings(origin: string, pin: string, patch: HostSettingsPatch): Promise<HostSettingsResponse> {
  const data = await fetchJson(new URL('/api/host/settings', origin).toString(), {
    method: 'PATCH',
    headers: hostHeaders(pin, true),
    body: JSON.stringify(patch),
  });
  const parsed = HostSettingsResponse.safeParse(data);
  if (!parsed.success) throw new ApiError(500, 'Unexpected settings response');
  return parsed.data;
}

/** Asks the host agent to exit (VLC stays running). The socket closes right after. */
export async function postShutdown(origin: string, pin: string): Promise<ShutdownResponse> {
  const data = await fetchJson(new URL('/api/host/shutdown', origin).toString(), { method: 'POST', headers: hostHeaders(pin) });
  const parsed = ShutdownResponse.safeParse(data);
  if (!parsed.success) throw new ApiError(500, 'Unexpected shutdown response');
  return parsed.data;
}
