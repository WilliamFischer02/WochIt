import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaCache, dirSize, type IndexEntry } from '../../src/media/cache.js';
import { mediaIdFor } from '../../src/media/ids.js';
import type { Logger } from '../../src/media/index.js';

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

let tmp: string;
let cacheDir: string;
let mediaDir: string;

async function makeMedia(name: string, lastAccess: number): Promise<{ id: string; entry: IndexEntry }> {
  const file = path.join(mediaDir, name);
  await fs.writeFile(file, `media ${name}`);
  const st = await fs.stat(file);
  const id = mediaIdFor(file, st.size, st.mtimeMs);
  return { id, entry: { path: file, size: st.size, mtimeMs: st.mtimeMs, probe: null, lastAccess } };
}

async function fill(id: string, bytes: number, rendition = '720p'): Promise<void> {
  const dir = path.join(cacheDir, id, rendition);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'seg00000.ts'), Buffer.alloc(bytes, 1));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wochit-cache-'));
  cacheDir = path.join(tmp, 'cache');
  mediaDir = path.join(tmp, 'media');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('MediaCache', () => {
  it('loads a valid index, drops stale entries and recomputes folder sizes', async () => {
    const a = await makeMedia('a.mkv', 100);
    const b = await makeMedia('b.mkv', 200);
    const gone = await makeMedia('gone.mkv', 300);
    await fs.rm(gone.entry.path);
    const changed = await makeMedia('changed.mkv', 400);
    await fs.writeFile(changed.entry.path, 'different size now');
    await fs.writeFile(
      path.join(cacheDir, 'index.json'),
      JSON.stringify({ version: 1, media: { [a.id]: a.entry, [b.id]: b.entry, [gone.id]: gone.entry, [changed.id]: changed.entry, zzz: a.entry } }),
    );
    await fill(a.id, 1000);
    await fill(b.id, 2000);
    await fill(b.id, 500, '360p');
    await fill('ffffffffffffffff', 300); // orphan folder, not in the index

    const cache = new MediaCache(cacheDir, quiet);
    await cache.load();
    expect(cache.ids().sort()).toEqual([a.id, b.id].sort());
    expect(cache.bytesOf(a.id)).toBe(1000);
    expect(cache.bytesOf(b.id)).toBe(2500);
    expect(cache.bytesOf('ffffffffffffffff')).toBe(300);
    expect(cache.totalBytes()).toBe(3800);
  });

  it('starts empty on a corrupt index without touching the folders', async () => {
    await fs.writeFile(path.join(cacheDir, 'index.json'), '{not json');
    await fill('abcdefabcdefabcd', 42);
    const cache = new MediaCache(cacheDir, quiet);
    await cache.load();
    expect(cache.ids()).toEqual([]);
    expect(cache.totalBytes()).toBe(42);
    expect(await dirSize(path.join(cacheDir, 'abcdefabcdefabcd'))).toBe(42);
  });

  it('evicts orphans first, then the least recently accessed media, never protected ones', async () => {
    const old = await makeMedia('old.mkv', 100);
    const mid = await makeMedia('mid.mkv', 200);
    const fresh = await makeMedia('fresh.mkv', 300);
    const cache = new MediaCache(cacheDir, quiet, { saveDelayMs: 10 });
    await cache.load();
    cache.set(old.id, old.entry);
    cache.set(mid.id, mid.entry);
    cache.set(fresh.id, fresh.entry);
    await fill(old.id, 1000);
    await fill(mid.id, 1000);
    await fill(fresh.id, 1000);
    await fill('0000000000000000', 500);
    for (const id of [old.id, mid.id, fresh.id, '0000000000000000']) await cache.recomputeBytes(id);
    expect(cache.totalBytes()).toBe(3500);

    // Nothing to do while under the cap.
    expect(await cache.evict(10_000)).toEqual([]);

    // 3500 → orphan (500) goes first → 3000 → still > 2500 → oldest (old) → 2000.
    expect(await cache.evict(2500)).toEqual(['0000000000000000', old.id]);
    expect(cache.totalBytes()).toBe(2000);
    await expect(fs.stat(path.join(cacheDir, old.id))).rejects.toBeDefined();
    await expect(fs.stat(path.join(cacheDir, mid.id))).resolves.toBeDefined();

    // mid is protected (running job): fresh is evicted instead, even though it is newer.
    expect(await cache.evict(1500, (id) => id === mid.id)).toEqual([fresh.id]);
    expect(cache.totalBytes()).toBe(1000);

    // Only protected media left: eviction gives up rather than deleting it.
    expect(await cache.evict(10, (id) => id === mid.id)).toEqual([]);
    expect(cache.totalBytes()).toBe(1000);
    expect(cache.get(mid.id)).toBeDefined();
  });

  it('touch bumps lastAccess and flush persists the index atomically', async () => {
    const a = await makeMedia('a.mkv', 1);
    const now = 1_700_000_000_000;
    const cache = new MediaCache(cacheDir, quiet, { saveDelayMs: 5, now: () => now });
    await cache.load();
    cache.set(a.id, a.entry);
    cache.touch(a.id);
    await cache.flush();
    const json = JSON.parse(await fs.readFile(path.join(cacheDir, 'index.json'), 'utf8')) as { version: number; media: Record<string, IndexEntry> };
    expect(json.version).toBe(1);
    expect(json.media[a.id]?.lastAccess).toBe(now);
    await expect(fs.stat(path.join(cacheDir, 'index.json.tmp'))).rejects.toBeDefined();

    const again = new MediaCache(cacheDir, quiet);
    await again.load();
    expect(again.get(a.id)?.lastAccess).toBe(now);
  });
});
