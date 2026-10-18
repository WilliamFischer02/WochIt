// MediaService hands out token-less origin-relative URLs; every one that leaves the process gets
// `?t=<mediaToken>` appended here, because <video> elements cannot send headers.
import type { MediaInfo, S2C } from '@wochit/shared';

export function withTokenQuery(url: string, token: string): string {
  if (/[?&]t=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

export function withMediaToken(media: MediaInfo, token: string): MediaInfo {
  return {
    ...media,
    masterUrl: withTokenQuery(media.masterUrl, token),
    renditions: media.renditions.map((r) => ({ ...r, playlistUrl: withTokenQuery(r.playlistUrl, token) })),
    subtitles: media.subtitles.map((s) => ({ ...s, url: withTokenQuery(s.url, token) })),
    posterUrl: media.posterUrl ? withTokenQuery(media.posterUrl, token) : media.posterUrl,
  };
}

/** Decorate the MediaInfo inside the frames that carry one; everything else passes through. */
export function decorateS2C(msg: S2C, token: string): S2C {
  switch (msg.type) {
    case 'welcome':
      return msg.room.media ? { ...msg, room: { ...msg.room, media: withMediaToken(msg.room.media, token) } } : msg;
    case 'media':
      return msg.media ? { ...msg, media: withMediaToken(msg.media, token) } : msg;
    default:
      return msg;
  }
}
