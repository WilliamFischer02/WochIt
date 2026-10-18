import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryResponse } from '@wochit/shared';
import { encodeDirId, mediaIdFor } from '../../src/media/ids.js';
import { MediaError } from '../../src/media/index.js';
import { browseLibrary, findSidecars, isVideoFile, parseSidecarTags } from '../../src/media/library.js';

let tmp: string;
let rootA: string;
let rootB: string;
let roots: string[];

const register = async (abs: string, st: { size: number; mtimeMs: number }) => ({ id: mediaIdFor(abs, st.size, st.mtimeMs) });

async function browse(parentId: string | null): Promise<LibraryResponse> {
  return browseLibrary(roots, parentId, register);
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wochit-lib-'));
  rootA = path.join(tmp, 'Plex Movies');
  rootB = path.join(tmp, 'Shows');
  roots = [rootA, rootB];
  await fs.mkdir(path.join(rootA, 'Dune (2021)'), { recursive: true });
  await fs.mkdir(path.join(rootA, '.hidden'), { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'Dune.mkv'), 'not really a video');
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'Dune.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nhi\n');
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'Dune.eng.forced.srt'), '');
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'Dune.srt'), '');
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'Dune.fr-CA.sdh.ass'), '');
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'Dune Part Two.srt'), '');
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'Dune.commentary.srt'), '');
  await fs.writeFile(path.join(rootA, 'Dune (2021)', 'notes.txt'), 'x');
  await fs.writeFile(path.join(rootA, '.hidden', 'secret.mkv'), 'x');
  await fs.writeFile(path.join(rootA, 'Trailer.MP4'), 'x');
  await fs.writeFile(path.join(rootB, 'clip.webm'), 'x');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('browseLibrary', () => {
  it('lists the configured roots as directories for parentId null', async () => {
    const res = await browse(null);
    expect(res.parentId).toBeNull();
    expect(res.entries.map((e) => [e.kind, e.name, e.displayPath])).toEqual([
      ['dir', 'Plex Movies', 'Plex Movies'],
      ['dir', 'Shows', 'Shows'],
    ]);
    expect(JSON.stringify(res)).not.toContain(tmp.replace(/\\/g, '\\\\'));
  });

  it('lists folders first, then video files, skipping hidden folders and non-video files', async () => {
    const rootsRes = await browse(null);
    const a = rootsRes.entries[0];
    expect(a).toBeDefined();
    const res = await browse((a as { id: string }).id);
    expect(res.parentId).toBe((a as { id: string }).id);
    expect(res.entries.map((e) => [e.kind, e.name])).toEqual([
      ['dir', 'Dune (2021)'],
      ['file', 'Trailer.MP4'],
    ]);
    const trailer = res.entries[1];
    expect(trailer?.displayPath).toBe('Plex Movies / Trailer.MP4');
    expect(trailer?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(trailer?.sizeBytes).toBe(1);

    const dune = await browse((res.entries[0] as { id: string }).id);
    expect(dune.entries.map((e) => [e.kind, e.name, e.displayPath])).toEqual([['file', 'Dune.mkv', 'Plex Movies / Dune (2021) / Dune.mkv']]);
    const file = dune.entries[0] as { id: string };
    const st = await fs.stat(path.join(rootA, 'Dune (2021)', 'Dune.mkv'));
    expect(file.id).toBe(mediaIdFor(path.join(rootA, 'Dune (2021)', 'Dune.mkv'), st.size, st.mtimeMs));
    expect(JSON.stringify(dune)).not.toContain(tmp.replace(/\\/g, '\\\\'));
    expect(JSON.stringify(dune)).not.toContain(tmp.replace(/\\/g, '/'));
  });

  it('rejects traversal and malformed ids with MediaError not_found', async () => {
    const bad = [
      encodeDirId(0, '..'),
      encodeDirId(0, '../Shows'),
      encodeDirId(0, 'Dune (2021)/../../Shows'),
      Buffer.from('0:C:/Windows', 'utf8').toString('base64url'),
      Buffer.from('0:/', 'utf8').toString('base64url'),
      Buffer.from('2:', 'utf8').toString('base64url'),
      'definitely not an id',
      encodeDirId(0, 'does-not-exist'),
    ];
    for (const id of bad) {
      await expect(browse(id)).rejects.toSatisfy((e: unknown) => e instanceof MediaError && e.code === 'not_found');
    }
  });

  it('never exposes a path outside a root even for a sibling with a shared prefix', async () => {
    // "Plex Movies" vs a hypothetical "Plex Movies2" sibling: the id must stay within root 0.
    await fs.mkdir(path.join(tmp, 'Plex Movies2'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'Plex Movies2', 'leak.mkv'), 'x');
    const id = Buffer.from('0:../Plex Movies2', 'utf8').toString('base64url');
    await expect(browse(id)).rejects.toBeInstanceOf(MediaError);
  });
});

describe('video and sidecar detection', () => {
  it('isVideoFile is case-insensitive over the supported extensions', () => {
    for (const n of ['a.mkv', 'b.MP4', 'c.m4v', 'd.mov', 'e.avi', 'f.webm', 'g.ts', 'h.m2ts', 'i.wmv', 'j.flv']) expect(isVideoFile(n)).toBe(true);
    for (const n of ['a.srt', 'b.txt', 'c.jpg', 'd.mp3', 'mkv']) expect(isVideoFile(n)).toBe(false);
  });

  it('parseSidecarTags understands language and flag tags only', () => {
    expect(parseSidecarTags('')).toEqual({ lang: null, forced: false, sdh: false });
    expect(parseSidecarTags('.en')).toEqual({ lang: 'en', forced: false, sdh: false });
    expect(parseSidecarTags('.eng.forced')).toEqual({ lang: 'eng', forced: true, sdh: false });
    expect(parseSidecarTags('.fr-CA.sdh')).toEqual({ lang: 'fr-CA', forced: false, sdh: true });
    expect(parseSidecarTags('.commentary')).toBeNull();
    expect(parseSidecarTags(' Part Two')).toBeNull();
  });

  it('findSidecars matches same-basename subtitle files with optional tags', async () => {
    const list = await findSidecars(path.join(rootA, 'Dune (2021)', 'Dune.mkv'));
    expect(list.map((s) => [s.fileName, s.lang, s.forced, s.sdh])).toEqual([
      ['Dune.en.srt', 'en', false, false],
      ['Dune.eng.forced.srt', 'eng', true, false],
      ['Dune.fr-CA.sdh.ass', 'fr-CA', false, true],
      ['Dune.srt', null, false, false],
    ]);
    for (const s of list) expect(s.id).toMatch(/^sc-[0-9a-f]{8}$/);
    expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
  });
});
