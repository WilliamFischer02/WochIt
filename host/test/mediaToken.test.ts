import { describe, expect, it } from 'vitest';
import type { MediaInfo, S2C } from '@wochit/shared';
import { decorateS2C, withMediaToken, withTokenQuery } from '../src/server/mediaToken.js';

const media: MediaInfo = {
  id: 'abc123',
  title: 'T',
  durationSec: 10,
  width: 1280,
  height: 720,
  fps: 24,
  masterUrl: '/media/abc123/master.m3u8',
  renditions: [{ id: '720p', width: 1280, height: 720, bitrateKbps: 2800, playlistUrl: '/media/abc123/720p/index.m3u8' }],
  subtitles: [{ id: '0', label: 'English', lang: 'en', kind: 'embedded', url: '/media/abc123/subs/0.vtt', isDefault: true }],
  audioLabel: null,
  posterUrl: '/media/abc123/poster.jpg',
};

describe('withTokenQuery', () => {
  it('appends ?t= or &t= and never doubles it', () => {
    expect(withTokenQuery('/a', 'tok')).toBe('/a?t=tok');
    expect(withTokenQuery('/a?x=1', 'tok')).toBe('/a?x=1&t=tok');
    expect(withTokenQuery('/a?t=tok', 'tok')).toBe('/a?t=tok');
    expect(withTokenQuery('/a', 'a b')).toBe('/a?t=a%20b');
  });
});

describe('withMediaToken', () => {
  it('decorates every URL field and leaves the input untouched', () => {
    const out = withMediaToken(media, 'tok');
    expect(out.masterUrl).toBe('/media/abc123/master.m3u8?t=tok');
    expect(out.renditions[0]?.playlistUrl).toBe('/media/abc123/720p/index.m3u8?t=tok');
    expect(out.subtitles[0]?.url).toBe('/media/abc123/subs/0.vtt?t=tok');
    expect(out.posterUrl).toBe('/media/abc123/poster.jpg?t=tok');
    expect(media.masterUrl).toBe('/media/abc123/master.m3u8');
  });
  it('keeps a null poster null', () => {
    expect(withMediaToken({ ...media, posterUrl: null }, 'tok').posterUrl).toBeNull();
  });
});

describe('decorateS2C', () => {
  it('decorates welcome.room.media and media.media only', () => {
    const welcome: S2C = {
      type: 'welcome',
      v: 1,
      you: { id: 'm', nick: 'n', isHost: true, typing: false },
      room: { state: { seq: 0, source: 'none', mediaId: null, playing: false, position: 0, rate: 1, updatedAt: 0 }, media, members: [], recentChat: [] },
      serverTime: 0,
      mediaToken: 'tok',
      gifSearchAvailable: false,
      vlc: { connected: false, following: true },
    };
    const w = decorateS2C(welcome, 'tok');
    expect(w.type === 'welcome' && w.room.media?.masterUrl).toBe('/media/abc123/master.m3u8?t=tok');
    const m = decorateS2C({ type: 'media', media }, 'tok');
    expect(m.type === 'media' && m.media?.renditions[0]?.playlistUrl).toContain('?t=tok');
    const nothing: S2C = { type: 'media', media: null };
    expect(decorateS2C(nothing, 'tok')).toBe(nothing);
    const pong: S2C = { type: 'pong', t: 1, serverTime: 2 };
    expect(decorateS2C(pong, 'tok')).toBe(pong);
  });
});
