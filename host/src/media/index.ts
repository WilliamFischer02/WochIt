// Contract between the media pipeline (host/src/media/**, media agent) and the server
// (host/src/server, room, …, server agent). The media agent implements `createMediaService`;
// the server agent only ever talks to this interface. Keep it the single seam.
import type { LibraryResponse, MediaInfo, RenditionId, TranscodeStatus } from '@wochit/shared';

export type EncoderChoice = 'auto' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';

export interface Logger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  debug(msg: string, ...rest: unknown[]): void;
}

export interface MediaServiceOptions {
  /** Absolute paths. Empty string means "search PATH, then the winget install folder". */
  ffmpegPath: string;
  ffprobePath: string;
  encoder: EncoderChoice;
  cacheDir: string;
  cacheMaxBytes: number;
  /** Folders the host may browse. Files outside them are still playable when VLC opens them. */
  roots: string[];
  /** Concurrent ffmpeg jobs. Default 3. */
  maxJobs?: number;
  log?: Logger;
}

export type TranscodeEvent = {
  mediaId: string;
  rendition: RenditionId;
  status: TranscodeStatus;
  readyToSec?: number;
  message?: string;
};

export type MediaErrorCode = 'unknown_media' | 'unknown_rendition' | 'transcode_failed' | 'timeout' | 'unsupported' | 'not_found';

export class MediaError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/**
 * Everything the server needs from the media pipeline.
 *
 * URL fields inside returned `MediaInfo` (`masterUrl`, `renditions[].playlistUrl`,
 * `subtitles[].url`, `posterUrl`) are origin-relative paths WITHOUT the `?t=` media token
 * (e.g. `/media/ab12cd34ef56ab12/master.m3u8`). The server appends the token before sending
 * anything to a client; see `withMediaToken` in the server package.
 */
export interface MediaService {
  /** Detect ffmpeg/ffprobe and the encoder, load the cache index, start the eviction timer. */
  init(): Promise<void>;
  readonly ffmpegFound: boolean;
  /** Encoder actually in use after init(), e.g. 'h264_nvenc'; null when ffmpeg is missing. */
  readonly encoder: string | null;

  /** Host-only browsing. `parentId === null` lists the configured roots as directories. */
  browse(parentId: string | null): Promise<LibraryResponse>;

  /** Register (or look up) a file by absolute path — used when VLC reports what it has open. */
  resolvePath(absolutePath: string): Promise<MediaInfo | null>;

  /** Look up by opaque id. Only ids this service has handed out resolve. */
  getMedia(mediaId: string): Promise<MediaInfo | null>;

  /**
   * Playlists are generated, never read from disk. `tokenQuery` is the exact string to append
   * to every URI inside the playlist (e.g. `?t=abc123`), since hls.js resolves segment URIs
   * relative to the playlist URL and would otherwise lose the token.
   */
  masterPlaylist(mediaId: string, tokenQuery: string): Promise<string>;
  mediaPlaylist(mediaId: string, rendition: RenditionId, tokenQuery: string): Promise<string>;

  /**
   * Absolute path of a complete segment file, transcoding just in time if needed. Resolves only
   * once the file is complete. Rejects with MediaError('timeout') after ~30 s, 'transcode_failed'
   * if ffmpeg died, 'unknown_media' / 'unknown_rendition' / 'not_found' (index past the end).
   */
  getSegment(mediaId: string, rendition: RenditionId, index: number): Promise<string>;

  /** Absolute path of the extracted WebVTT for `SubtitleTrack.id`. Extracts on first request. */
  getSubtitle(mediaId: string, subtitleId: string): Promise<string>;

  /** Absolute path of the poster JPEG, generating it on first request; null if that fails. */
  getPoster(mediaId: string): Promise<string | null>;

  /** Subscribe to transcode progress. Returns an unsubscribe function. */
  onTranscode(cb: (ev: TranscodeEvent) => void): () => void;

  stats(): {
    cacheBytes: number;
    cacheMaxBytes: number;
    jobs: Array<{ mediaId: string; rendition: RenditionId; nextSegment: number; startedAt: number }>;
  };

  /** Kill ffmpeg jobs and flush the cache index. */
  shutdown(): Promise<void>;
}

// Implemented in ./service.ts by the media agent. Re-exported here so the server imports one path.
export { createMediaService } from './service.js';
