import { describe, expect, it } from 'vitest';
import type { SubtitleStreamInfo } from '../../src/media/probe.js';
import { parseProbe } from '../../src/media/probe.js';
import { buildSubtitleTracks, embeddedLabel, languageName, sidecarLabel } from '../../src/media/subtitles.js';

function stream(over: Partial<SubtitleStreamInfo>): SubtitleStreamInfo {
  return { index: 2, rel: 0, codec: 'subrip', lang: null, title: null, isDefault: false, forced: false, hearingImpaired: false, text: true, ...over };
}

describe('languageName', () => {
  it('maps ISO 639-1/2 codes and tolerates region tags', () => {
    expect(languageName('eng')).toBe('English');
    expect(languageName('en')).toBe('English');
    expect(languageName('fr-CA')).toBe('French');
    expect(languageName('und')).toBeNull();
    expect(languageName(null)).toBeNull();
    expect(languageName('xx')).toBe('XX');
  });
});

describe('embeddedLabel', () => {
  it('uses the title when it names the language', () => {
    expect(embeddedLabel(stream({ lang: 'eng', title: 'English (SDH)' }))).toBe('English (SDH)');
  });
  it('prefixes the language when the title does not include it', () => {
    expect(embeddedLabel(stream({ lang: 'eng', title: 'SDH' }))).toBe('English (SDH)');
    expect(embeddedLabel(stream({ lang: 'spa', title: 'Latin America' }))).toBe('Spanish (Latin America)');
  });
  it('derives SDH/forced from dispositions', () => {
    expect(embeddedLabel(stream({ lang: 'eng', hearingImpaired: true }))).toBe('English (SDH)');
    expect(embeddedLabel(stream({ lang: 'eng', forced: true }))).toBe('English (forced)');
    expect(embeddedLabel(stream({}))).toBe('Subtitles');
  });
  it('flags bitmap tracks as not supported yet', () => {
    expect(embeddedLabel(stream({ lang: 'eng', codec: 'hdmv_pgs_subtitle', text: false }))).toBe('English (PGS) — not supported yet');
    expect(embeddedLabel(stream({ lang: 'deu', codec: 'dvd_subtitle', text: false }))).toBe('German (VobSub) — not supported yet');
  });
});

describe('sidecarLabel / buildSubtitleTracks', () => {
  it('labels sidecars with language, flags and the file type', () => {
    expect(sidecarLabel({ id: 'sc-1', path: 'x', fileName: 'x.en.srt', ext: '.srt', lang: 'en', forced: false, sdh: false })).toBe('English · srt');
    expect(sidecarLabel({ id: 'sc-2', path: 'x', fileName: 'x.srt', ext: '.srt', lang: null, forced: true, sdh: true })).toBe('Subtitles (SDH) (forced) · srt');
  });

  it('builds tracks with token-less urls and a single default', () => {
    const probe = parseProbe({
      format: { duration: '10', format_name: 'matroska' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1' },
        { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, disposition: { default: 1 } },
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' }, disposition: { default: 1 } },
        { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' }, disposition: { default: 1 } },
        { index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'jpn', title: 'Signs' } },
      ],
    });
    expect(probe).not.toBeNull();
    const tracks = buildSubtitleTracks('abcdefabcdefabcd', probe!, [
      { id: 'sc-deadbeef', path: 'x', fileName: 'x.de.srt', ext: '.srt', lang: 'de', forced: false, sdh: false },
    ]);
    expect(tracks).toEqual([
      { id: '0', label: 'English', lang: 'eng', kind: 'embedded', url: '/media/abcdefabcdefabcd/subs/0.vtt', isDefault: true },
      { id: '1', label: 'English (PGS) — not supported yet', lang: 'eng', kind: 'embedded', url: '/media/abcdefabcdefabcd/subs/1.vtt', isDefault: false },
      { id: '2', label: 'Japanese (Signs)', lang: 'jpn', kind: 'embedded', url: '/media/abcdefabcdefabcd/subs/2.vtt', isDefault: false },
      { id: 'sc-deadbeef', label: 'German · srt', lang: 'de', kind: 'sidecar', url: '/media/abcdefabcdefabcd/subs/sc-deadbeef.vtt', isDefault: false },
    ]);
  });
});

describe('parseProbe', () => {
  it('picks the real video stream over cover art, computes display width from SAR, parses rates and durations', () => {
    const probe = parseProbe({
      format: { duration: '5400.5', start_time: '0.000000', format_name: 'matroska,webm' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 900, disposition: { attached_pic: 1 } },
        { index: 1, codec_type: 'video', codec_name: 'h264', width: 720, height: 480, sample_aspect_ratio: '32:27', avg_frame_rate: '24000/1001', r_frame_rate: '24000/1001', pix_fmt: 'yuv420p', tags: { DURATION: '01:30:00.000000000' } },
        { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)', sample_rate: '48000', bit_rate: '384000', tags: { language: 'eng', title: 'Surround' } },
        { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', tags: { language: 'fra' }, disposition: { default: 1 } },
      ],
    });
    expect(probe).not.toBeNull();
    expect(probe!.durationSec).toBe(5400.5);
    expect(probe!.video).toMatchObject({ index: 1, codec: 'h264', width: 720, height: 480, displayWidth: 853, fps: 23.976, durationSec: 5400 });
    expect(probe!.audio.map((a) => [a.rel, a.index, a.codec, a.channels, a.bitrateKbps, a.lang, a.isDefault])).toEqual([
      [0, 2, 'ac3', 6, 384, 'eng', false],
      [1, 3, 'aac', 2, null, 'fra', true],
    ]);
  });

  it('returns null without a video stream', () => {
    expect(parseProbe({ format: { duration: '3' }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }] })).toBeNull();
    expect(parseProbe({})).toBeNull();
    expect(parseProbe('garbage')).toBeNull();
  });
});
