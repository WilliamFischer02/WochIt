// Shared bits for the GIF providers. The host proxies exactly one provider at a time behind
// /api/gif/search and /api/gif/featured; the browser never sees a key. docs/ARCHITECTURE.md § GIFs.
import type { GifSearchResponse } from '@wochit/shared';

export type GifProviderName = 'klipy' | 'giphy';

export interface GifPage {
  /** Opaque cursor from a previous `next`: Klipy page number or GIPHY offset, as a string. */
  pos?: string | undefined;
  limit?: number | undefined;
}

export interface GifProvider {
  readonly name: GifProviderName;
  search(q: string, page: GifPage): Promise<GifSearchResponse>;
  featured(page: GifPage): Promise<GifSearchResponse>;
}

export class GifError extends Error {
  constructor(
    message: string,
    /** Upstream HTTP status when the provider answered; null for network/timeout/parse failures. */
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GifError';
  }
}

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
  /** Default 10 000. */
  timeoutMs?: number;
}

export const GIF_DEFAULT_LIMIT = 24;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Integer in [min, max], `dflt` when missing or not a number. */
export function clampInt(v: number | string | undefined, min: number, max: number, dflt: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === undefined || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function numberish(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function stringish(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** GET a JSON document with a timeout; HTTP errors and bad JSON become GifError. */
export async function fetchJson(url: string, deps: ProviderDeps, label: string): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
  } catch (err) {
    throw new GifError(`${label} request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new GifError(`${label} responded ${res.status}`, res.status);
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new GifError(`${label} returned invalid JSON`, res.status);
  }
}
