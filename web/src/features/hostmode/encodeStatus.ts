// The one-line encode progress under the now-playing title, from the store's `transcode` slice.
import type { RenditionId } from '@wochit/shared';
import type { TranscodeInfo } from '../../app/store';
import { formatTime } from '../../lib/format';

export interface EncodeStatus {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

/**
 * "Ready" when no transcode has been seen for this media: segments come from the cache or are
 * encoded on demand, and the first `transcode` message replaces the line. An error wins; otherwise
 * the rendition furthest behind is reported while anything still runs; "Encoded" once all are done.
 */
export function encodeStatus(transcode: Partial<Record<RenditionId, TranscodeInfo>>, durationSec: number): EncodeStatus {
  const entries = Object.entries(transcode).filter((e): e is [RenditionId, TranscodeInfo] => e[1] !== undefined);
  if (entries.length === 0) return { tone: 'ok', text: 'Ready' };
  const failed = entries.find(([, t]) => t.status === 'error');
  if (failed) {
    const [rid, t] = failed;
    return { tone: 'bad', text: `Encoding ${rid} failed${t.message ? `: ${t.message}` : ''}` };
  }
  const running = entries.filter(([, t]) => t.status !== 'done').sort((a, b) => (a[1].readyToSec ?? -1) - (b[1].readyToSec ?? -1));
  const behind = running[0];
  if (!behind) return { tone: 'ok', text: 'Encoded' };
  const [rid, t] = behind;
  if (t.readyToSec === undefined) return { tone: 'warn', text: `Encoding ${rid} · starting…` };
  return { tone: 'warn', text: `Encoding ${rid} · ${formatTime(t.readyToSec)} ready of ${formatTime(durationSec)}` };
}
