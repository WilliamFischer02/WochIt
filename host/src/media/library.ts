// Host-only library browsing and sidecar discovery. Never returns absolute paths: directories are
// addressed by opaque ids (root index + relative path), files by their media id.
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LibraryEntry, LibraryResponse } from '@wochit/shared';
import { decodeDirId, encodeDirId } from './ids.js';
import { MediaError } from './index.js';

export const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.avi', '.webm', '.ts', '.m2ts', '.wmv', '.flv']);
export const SUBTITLE_EXTS: ReadonlySet<string> = new Set(['.srt', '.vtt', '.ass', '.ssa']);

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules']);

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function rootDisplayName(root: string): string {
  const base = path.basename(root);
  return base.length > 0 ? base : root.replace(/[\\/]+$/, '') || root;
}

export interface RegisteredFile {
  id: string;
  durationSec?: number;
}

/** Called for every listed video file so the service can hand out a stable id for it. */
export type FileRegistrar = (absPath: string, st: Stats) => Promise<RegisteredFile> | RegisteredFile;

export async function browseLibrary(roots: string[], parentId: string | null, register: FileRegistrar): Promise<LibraryResponse> {
  if (parentId === null) {
    const entries: LibraryEntry[] = [];
    roots.forEach((root, i) => {
      const name = rootDisplayName(root);
      entries.push({ kind: 'dir', id: encodeDirId(i, ''), name, displayPath: name });
    });
    return { parentId: null, entries };
  }

  const dec = decodeDirId(parentId, roots);
  if (!dec) throw new MediaError('not_found', 'unknown folder');

  let dirents;
  try {
    dirents = await fs.readdir(dec.absPath, { withFileTypes: true });
  } catch {
    throw new MediaError('not_found', 'folder is not readable');
  }

  const rootName = rootDisplayName(dec.root);
  const displayBase = dec.relPath === '' ? rootName : `${rootName} / ${dec.relPath.split('/').join(' / ')}`;
  const dirs: LibraryEntry[] = [];
  const files: LibraryEntry[] = [];

  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const rel = dec.relPath === '' ? d.name : `${dec.relPath}/${d.name}`;
    const abs = path.join(dec.absPath, d.name);
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name.toLowerCase())) continue;
      dirs.push({ kind: 'dir', id: encodeDirId(dec.rootIndex, rel), name: d.name, displayPath: `${displayBase} / ${d.name}` });
    } else if ((d.isFile() || d.isSymbolicLink()) && isVideoFile(d.name)) {
      let st: Stats;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const reg = await register(abs, st);
      const entry: LibraryEntry = {
        kind: 'file',
        id: reg.id,
        name: d.name,
        displayPath: `${displayBase} / ${d.name}`,
        sizeBytes: st.size,
      };
      if (reg.durationSec !== undefined) entry.durationSec = reg.durationSec;
      files.push(entry);
    }
  }

  dirs.sort((a, b) => compareNames(a.name, b.name));
  files.sort((a, b) => compareNames(a.name, b.name));
  return { parentId, entries: [...dirs, ...files] };
}

// ------------------------------------------------------------------ sidecar subtitles

export interface Sidecar {
  /** Stable id derived from the file name: `sc-<8 hex>`. */
  id: string;
  path: string;
  fileName: string;
  ext: string;
  /** Language tag from the file name (`Movie.en.srt` → "en"), null when absent. */
  lang: string | null;
  forced: boolean;
  sdh: boolean;
}

export function sidecarId(fileName: string): string {
  return `sc-${createHash('sha1').update(fileName.toLowerCase()).digest('hex').slice(0, 8)}`;
}

const FLAG_WORDS = new Set(['forced', 'sdh', 'hi', 'cc']);

/**
 * Parse the part of a sidecar name between the video basename and the extension, e.g. ".en",
 * ".eng.forced", "" or ".en-US.sdh". Returns null when it is not a recognised tag sequence.
 */
export function parseSidecarTags(middle: string): { lang: string | null; forced: boolean; sdh: boolean } | null {
  if (middle === '') return { lang: null, forced: false, sdh: false };
  if (!middle.startsWith('.')) return null;
  const parts = middle.slice(1).split('.');
  let lang: string | null = null;
  let forced = false;
  let sdh = false;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (FLAG_WORDS.has(lower)) {
      if (lower === 'forced') forced = true;
      else sdh = true;
    } else if (lang === null && /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(p)) {
      lang = p;
    } else {
      return null;
    }
  }
  return { lang, forced, sdh };
}

export async function findSidecars(videoPath: string): Promise<Sidecar[]> {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Sidecar[] = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!SUBTITLE_EXTS.has(ext)) continue;
    const stem = name.slice(0, name.length - ext.length);
    if (stem.length < base.length || stem.slice(0, base.length).toLowerCase() !== base.toLowerCase()) continue;
    const tags = parseSidecarTags(stem.slice(base.length));
    if (!tags) continue;
    out.push({ id: sidecarId(name), path: path.join(dir, name), fileName: name, ext, lang: tags.lang, forced: tags.forced, sdh: tags.sdh });
  }
  out.sort((a, b) => compareNames(a.fileName, b.fileName));
  return out;
}
