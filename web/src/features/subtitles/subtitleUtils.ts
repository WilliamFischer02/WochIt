import type { SubtitleTrack } from '@wochit/shared';

/** Bitmap tracks are listed by the host with the reason in the label ("PGS — not supported yet"). */
export function isSupportedSubtitle(t: SubtitleTrack): boolean {
  return !/not supported/i.test(t.label) && t.url.length > 0;
}

export function subtitleLabel(t: SubtitleTrack): string {
  return t.label || t.lang || `Track ${t.id}`;
}

/** The track to show when the user has not chosen one yet for this media. */
export function defaultSubtitleId(tracks: SubtitleTrack[]): string | null {
  return tracks.find((t) => t.isDefault && isSupportedSubtitle(t))?.id ?? null;
}
