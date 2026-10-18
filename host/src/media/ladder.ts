// Rendition ladder: drop rungs taller than the source, keep at least one, derive even widths that
// preserve the display aspect ratio.
import { RENDITION_LADDER, type RenditionId } from '@wochit/shared';

export interface Rung {
  id: RenditionId;
  width: number;
  height: number;
  bitrateKbps: number;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * @param displayWidth source width after the sample aspect ratio is applied
 * @param height source height in pixels
 */
export function selectLadder(displayWidth: number, height: number): Rung[] {
  const aspect = displayWidth > 0 && height > 0 ? displayWidth / height : 16 / 9;
  let rungs = RENDITION_LADDER.filter((r) => r.height <= height);
  if (rungs.length === 0) {
    const smallest = RENDITION_LADDER[RENDITION_LADDER.length - 1];
    if (!smallest) throw new Error('RENDITION_LADDER is empty');
    rungs = [smallest];
  }
  return rungs.map((r) => {
    // Never upscale: a 300 px source gets the 360p rung encoded at its own (even) height.
    const h = even(Math.min(r.height, height));
    return { id: r.id, height: h, width: even(h * aspect), bitrateKbps: r.bitrateKbps };
  });
}

export function findRung(rungs: Rung[], id: string): Rung | undefined {
  return rungs.find((r) => r.id === id);
}
