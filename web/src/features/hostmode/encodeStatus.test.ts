import { describe, expect, it } from 'vitest';
import { encodeStatus } from './encodeStatus';

const FILM = 6800; // 1:53:20

describe('encodeStatus', () => {
  it('says nothing before any transcode message', () => {
    expect(encodeStatus({}, FILM)).toBeNull();
  });
  it('reports the running rendition with ready-of-total times', () => {
    expect(encodeStatus({ '720p': { status: 'running', readyToSec: 1930 } }, FILM)).toEqual({ tone: 'warn', text: 'Encoding 720p · 32:10 ready of 1:53:20' });
    expect(encodeStatus({ '720p': { status: 'starting' } }, FILM)).toEqual({ tone: 'warn', text: 'Encoding 720p · starting…' });
  });
  it('picks the rendition furthest behind while several run', () => {
    expect(encodeStatus({ '720p': { status: 'done', readyToSec: FILM }, '360p': { status: 'running', readyToSec: 600 } }, FILM)?.text).toBe('Encoding 360p · 10:00 ready of 1:53:20');
    expect(encodeStatus({ '720p': { status: 'running', readyToSec: 900 }, '360p': { status: 'running', readyToSec: 600 } }, FILM)?.text).toMatch(/^Encoding 360p/);
  });
  it('is Encoded once every rendition is done', () => {
    expect(encodeStatus({ '720p': { status: 'done', readyToSec: FILM }, '360p': { status: 'done', readyToSec: FILM } }, FILM)).toEqual({ tone: 'ok', text: 'Encoded' });
  });
  it('an error wins over progress and carries the message', () => {
    expect(encodeStatus({ '720p': { status: 'running', readyToSec: 10 }, '360p': { status: 'error', message: 'nvenc busy' } }, FILM)).toEqual({ tone: 'bad', text: 'Encoding 360p failed: nvenc busy' });
    expect(encodeStatus({ '360p': { status: 'error' } }, FILM)?.text).toBe('Encoding 360p failed');
  });
});
