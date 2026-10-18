// Opaque identifiers. Media ids hash the file identity; directory ids wrap a root index plus a
// relative path and are validated against traversal on the way back in.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MEDIA_ID_RE = /^[0-9a-f]{16}$/;

/** sha1(absPath + '|' + size + '|' + mtimeMs).slice(0, 16) */
export function mediaIdFor(absPath: string, size: number, mtimeMs: number): string {
  return createHash('sha1').update(`${absPath}|${size}|${mtimeMs}`).digest('hex').slice(0, 16);
}

export function encodeDirId(rootIndex: number, relPath: string): string {
  const rel = relPath.split(/[\\/]+/).filter(Boolean).join('/');
  return Buffer.from(`${rootIndex}:${rel}`, 'utf8').toString('base64url');
}

export interface DecodedDirId {
  rootIndex: number;
  root: string;
  /** Forward-slash separated, '' for the root itself. */
  relPath: string;
  absPath: string;
}

/** Inside check that tolerates case-insensitive filesystems (path.relative handles that on win32). */
export function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return first !== '..';
}

/** Null for anything malformed or escaping its root. */
export function decodeDirId(id: string, roots: string[]): DecodedDirId | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = /^(\d{1,4}):([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const rootIndex = Number(m[1]);
  const relRaw = m[2] ?? '';
  const root = roots[rootIndex];
  if (!root) return null;
  if (relRaw.includes('\0') || relRaw.includes(':')) return null;
  if (relRaw.startsWith('/') || relRaw.startsWith('\\')) return null;
  const segments = relRaw === '' ? [] : relRaw.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (/^\.+$/.test(seg)) return null;
  }
  const absPath = segments.length ? path.resolve(root, ...segments) : path.resolve(root);
  if (!isInside(path.resolve(root), absPath)) return null;
  return { rootIndex, root, relPath: segments.join('/'), absPath };
}
