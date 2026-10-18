// Thin REST client for the host agent (docs/PROTOCOL.md § REST). Everything validates with the
// shared zod schemas so a wrong server (Vercel's SPA fallback returning index.html) is detected.
import { HealthResponse, LibraryResponse } from '@wochit/shared';

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
