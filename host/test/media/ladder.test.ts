import { describe, expect, it } from 'vitest';
import { RENDITION_LADDER } from '@wochit/shared';
import { findRung, selectLadder } from '../../src/media/ladder.js';

describe('selectLadder', () => {
  it('keeps every rung for a 1080p 16:9 source', () => {
    const rungs = selectLadder(1920, 1080);
    expect(rungs.map((r) => r.id)).toEqual(['1080p', '720p', '480p', '360p']);
    expect(rungs.map((r) => `${r.width}x${r.height}`)).toEqual(['1920x1080', '1280x720', '854x480', '640x360']);
    expect(rungs.map((r) => r.bitrateKbps)).toEqual(RENDITION_LADDER.map((r) => r.bitrateKbps));
  });

  it('drops rungs taller than the source', () => {
    expect(selectLadder(1280, 720).map((r) => r.id)).toEqual(['720p', '480p', '360p']);
    expect(selectLadder(854, 480).map((r) => r.id)).toEqual(['480p', '360p']);
    expect(selectLadder(1920, 800).map((r) => r.id)).toEqual(['720p', '480p', '360p']);
  });

  it('caps at 1080p for 4K sources', () => {
    const rungs = selectLadder(3840, 2160);
    expect(rungs[0]).toMatchObject({ id: '1080p', width: 1920, height: 1080 });
    expect(rungs).toHaveLength(4);
  });

  it('always keeps one rung and never upscales', () => {
    expect(selectLadder(640, 360)).toEqual([{ id: '360p', width: 640, height: 360, bitrateKbps: 800 }]);
    expect(selectLadder(400, 300)).toEqual([{ id: '360p', width: 400, height: 300, bitrateKbps: 800 }]);
    expect(selectLadder(320, 240)).toEqual([{ id: '360p', width: 320, height: 240, bitrateKbps: 800 }]);
  });

  it('preserves the display aspect with even widths', () => {
    // 2.40:1 scope
    const scope = selectLadder(1920, 800);
    expect(scope.map((r) => `${r.width}x${r.height}`)).toEqual(['1728x720', '1152x480', '864x360']);
    for (const r of scope) {
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
    // anamorphic DVD: 720x480 storage, SAR 32:27 → 853 display width
    const dvd = selectLadder(853, 480);
    expect(dvd.map((r) => `${r.width}x${r.height}`)).toEqual(['854x480', '640x360']);
  });

  it('findRung looks up by id', () => {
    const rungs = selectLadder(1280, 720);
    expect(findRung(rungs, '720p')?.height).toBe(720);
    expect(findRung(rungs, '1080p')).toBeUndefined();
  });
});
