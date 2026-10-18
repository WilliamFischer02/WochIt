import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeDirId, encodeDirId, isInside, mediaIdFor } from '../../src/media/ids.js';

describe('mediaIdFor', () => {
  it('is sha1(path|size|mtimeMs) truncated to 16 hex chars', () => {
    const id = mediaIdFor('C:\\Movies\\Dune (2021).mkv', 123456789, 1700000000123.456);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const expected = createHash('sha1').update('C:\\Movies\\Dune (2021).mkv|123456789|1700000000123.456').digest('hex').slice(0, 16);
    expect(id).toBe(expected);
  });

  it('is stable across calls and sensitive to every input', () => {
    const a = mediaIdFor('/m/a.mkv', 10, 20);
    expect(mediaIdFor('/m/a.mkv', 10, 20)).toBe(a);
    expect(mediaIdFor('/m/b.mkv', 10, 20)).not.toBe(a);
    expect(mediaIdFor('/m/a.mkv', 11, 20)).not.toBe(a);
    expect(mediaIdFor('/m/a.mkv', 10, 21)).not.toBe(a);
  });
});

describe('directory ids', () => {
  const roots = [path.resolve('C:/Media/Movies'), path.resolve('D:/Shows')];

  it('round-trip a root and a nested relative path', () => {
    const root = decodeDirId(encodeDirId(0, ''), roots);
    expect(root).toMatchObject({ rootIndex: 0, relPath: '', absPath: roots[0] });
    const nested = decodeDirId(encodeDirId(1, 'Severance/Season 1'), roots);
    expect(nested).toMatchObject({ rootIndex: 1, relPath: 'Severance/Season 1' });
    expect(nested?.absPath).toBe(path.resolve(roots[1] as string, 'Severance', 'Season 1'));
  });

  it('are opaque (not the path itself) and URL safe', () => {
    const id = encodeDirId(0, 'Dune (2021)');
    expect(id).not.toContain('Dune');
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('reject traversal, absolute paths, drive letters and unknown roots', () => {
    const raw = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    expect(decodeDirId(encodeDirId(0, '../Shows'), roots)).toBeNull();
    expect(decodeDirId(encodeDirId(0, 'a/../../b'), roots)).toBeNull();
    expect(decodeDirId(raw('0:..'), roots)).toBeNull();
    expect(decodeDirId(raw('0:..\\..\\Windows'), roots)).toBeNull();
    expect(decodeDirId(raw('0:/etc'), roots)).toBeNull();
    expect(decodeDirId(raw('0:\\\\server\\share'), roots)).toBeNull();
    expect(decodeDirId(raw('0:C:/Windows'), roots)).toBeNull();
    expect(decodeDirId(raw('0:C:Windows'), roots)).toBeNull();
    expect(decodeDirId(raw('0:a\0b'), roots)).toBeNull();
    expect(decodeDirId(raw('7:'), roots)).toBeNull();
    expect(decodeDirId(raw('-1:'), roots)).toBeNull();
    expect(decodeDirId(raw('nonsense'), roots)).toBeNull();
    expect(decodeDirId('!!!not base64url!!!', roots)).toBeNull();
    expect(decodeDirId('', roots)).toBeNull();
  });

  it('isInside handles the root itself and siblings', () => {
    const root = path.resolve('C:/Media');
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.resolve('C:/Media/x'))).toBe(true);
    expect(isInside(root, path.resolve('C:/Media2'))).toBe(false);
    expect(isInside(root, path.resolve('C:/'))).toBe(false);
    expect(isInside(root, path.resolve('C:/Media/..foo'))).toBe(true);
  });
});
