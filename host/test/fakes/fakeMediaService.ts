// Test fake for the MediaService seam. The implementation lives in src/dev (so `--fake-media`
// can use it from the built CLI); tests import it from here.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaInfo } from '@wochit/shared';
import { createFakeMediaService, DEFAULT_FAKE_ITEMS, type FakeMediaItem, type FakeMediaService } from '../../src/dev/fakeMediaService.js';

export { createFakeMediaService, DEFAULT_FAKE_ITEMS };
export type { FakeMediaItem, FakeMediaService };

export const FILM: FakeMediaItem = DEFAULT_FAKE_ITEMS[0]!;
export const CLIP: FakeMediaItem = DEFAULT_FAKE_ITEMS[1]!;

/** A fresh fake with its own temp dir so parallel test files never share segment files. */
export function newFakeMedia(items: FakeMediaItem[] = DEFAULT_FAKE_ITEMS, autoRegister = true): FakeMediaService {
  return createFakeMediaService({ items, dir: mkdtempSync(path.join(os.tmpdir(), 'wochit-test-')), autoRegister });
}

export async function infoOf(media: FakeMediaService, id: string): Promise<MediaInfo> {
  const m = await media.getMedia(id);
  if (!m) throw new Error(`fake media has no ${id}`);
  return m;
}
