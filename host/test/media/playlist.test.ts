import { describe, expect, it } from 'vitest';
import { selectLadder } from '../../src/media/ladder.js';
import { masterPlaylist, mediaPlaylist, parseSegmentFileName, segmentCount, segmentFileName } from '../../src/media/playlist.js';

describe('segmentCount', () => {
  it('ceil(duration / 4), folding a trailing sliver < 0.1 s into the previous segment', () => {
    expect(segmentCount(10)).toBe(3);
    expect(segmentCount(90)).toBe(23);
    expect(segmentCount(88)).toBe(22);
    expect(segmentCount(88.05)).toBe(22);
    expect(segmentCount(88.6)).toBe(23);
    expect(segmentCount(0)).toBe(1);
  });

  it('uses the video span when it is shorter than the container', () => {
    expect(segmentCount(90.021, 90)).toBe(23);
    expect(segmentCount(88.3, 88.0)).toBe(22);
  });
});

describe('segment file names', () => {
  it('are zero-padded to five digits and parse back', () => {
    expect(segmentFileName(0)).toBe('seg00000.ts');
    expect(segmentFileName(42)).toBe('seg00042.ts');
    expect(parseSegmentFileName('seg00042.ts')).toBe(42);
    expect(parseSegmentFileName('seg00042.ts.tmp')).toBeNull();
    expect(parseSegmentFileName('_ffmpeg.m3u8')).toBeNull();
  });
});

describe('mediaPlaylist', () => {
  it('10 s → three segments, last one 2.000, token on every URI', () => {
    expect(mediaPlaylist(10, '?t=abc')).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXTINF:4.000,',
        'seg00000.ts?t=abc',
        '#EXTINF:4.000,',
        'seg00001.ts?t=abc',
        '#EXTINF:2.000,',
        'seg00002.ts?t=abc',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
  });

  it('90 s → 23 segments ending with a 2.000 s one (snapshot)', () => {
    const text = mediaPlaylist(90, '?t=tok');
    const uris = text.split('\n').filter((l) => l.startsWith('seg'));
    expect(uris).toHaveLength(23);
    expect(uris[0]).toBe('seg00000.ts?t=tok');
    expect(uris[22]).toBe('seg00022.ts?t=tok');
    expect(text).toContain('#EXTINF:2.000,\nseg00022.ts?t=tok\n#EXT-X-ENDLIST\n');
    expect(text.match(/#EXTINF:4\.000,/g)).toHaveLength(22);
    expect(text).toMatchSnapshot();
  });

  it('carries the container remainder when the video span is shorter', () => {
    const text = mediaPlaylist(90.021, '', 90);
    expect(text).toContain('#EXTINF:2.021,\nseg00022.ts\n');
  });

  it('works with an empty token query', () => {
    expect(mediaPlaylist(4, '')).toContain('\nseg00000.ts\n');
  });
});

describe('masterPlaylist', () => {
  it('lists one variant per rung with bandwidth, resolution, codecs and frame rate', () => {
    const rungs = selectLadder(1920, 1080);
    const text = masterPlaylist(rungs, { fps: 23.976, hasAudio: true }, '?t=abc');
    const lines = text.split('\n');
    expect(lines[0]).toBe('#EXTM3U');
    expect(lines).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect(lines).toContain('#EXT-X-STREAM-INF:BANDWIDTH=6368000,AVERAGE-BANDWIDTH=5328000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=23.976');
    expect(lines).toContain('1080p/index.m3u8?t=abc');
    expect(lines).toContain('#EXT-X-STREAM-INF:BANDWIDTH=3488000,AVERAGE-BANDWIDTH=2928000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=23.976');
    expect(lines).toContain('720p/index.m3u8?t=abc');
    expect(lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF'))).toHaveLength(4);
    expect(text.endsWith('360p/index.m3u8?t=abc\n')).toBe(true);
  });

  it('omits FRAME-RATE when unknown and the audio codec when there is no audio', () => {
    const text = masterPlaylist(selectLadder(1280, 720), { fps: null, hasAudio: false }, '');
    expect(text).not.toContain('FRAME-RATE');
    expect(text).toContain('CODECS="avc1.640028"');
    expect(text).toContain('BANDWIDTH=3360000,AVERAGE-BANDWIDTH=2800000');
  });

  it('prints integer frame rates without decimals', () => {
    expect(masterPlaylist(selectLadder(640, 360), { fps: 30, hasAudio: true }, '')).toContain('FRAME-RATE=30\n');
  });
});
