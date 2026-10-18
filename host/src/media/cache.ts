// Cache index (`<cacheDir>/index.json`) and LRU accounting.
//
// Layout on disk:
//   <cacheDir>/index.json                 id → { path, size, mtimeMs, probe, lastAccess }
//   <cacheDir>/<id>/<rendition>/segNNNNN.ts
//   <cacheDir>/<id>/subs/<subtitleId>.vtt
//   <cacheDir>/<id>/poster.jpg
// Eviction removes whole `<cacheDir>/<id>` folders, oldest lastAccess first, never one with a
// running job. Sizes are recomputed from disk on load.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MEDIA_ID_RE, mediaIdFor } from './ids.js';
import type { Logger } from './index.js';
import { ProbeInfo } from './probe.js';

export const IndexEntry = z.object({
  path: z.string(),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  probe: ProbeInfo.nullable(),
  lastAccess: z.number().nonnegative(),
});
export type IndexEntry = z.infer<typeof IndexEntry>;

const IndexFile = z.object({
  version: z.literal(1),
  media: z.record(z.string(), IndexEntry),
});

export const INDEX_FILE = 'index.json';

export interface CacheOptions {
  /** Debounce for index writes, ms. */
  saveDelayMs?: number;
  now?: () => number;
}

export class MediaCache {
  readonly dir: string;
  private readonly log: Logger;
  private readonly entries = new Map<string, IndexEntry>();
  /** Bytes on disk per media id folder (also for folders no longer in the index). */
  private readonly bytes = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private readonly saveDelayMs: number;
  private readonly now: () => number;

  constructor(dir: string, log: Logger, opts: CacheOptions = {}) {
    this.dir = path.resolve(dir);
    this.log = log;
    this.saveDelayMs = opts.saveDelayMs ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  get indexPath(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  mediaDir(id: string): string {
    return path.join(this.dir, id);
  }

  /** Create the folder, load + validate the index, recompute folder sizes. */
  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.entries.clear();
    this.bytes.clear();

    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.indexPath, 'utf8');
    } catch {
      raw = null;
    }
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.log.warn(`cache index ${this.indexPath} is not valid JSON; starting empty`);
      }
      const res = IndexFile.safeParse(parsed);
      if (!res.success) {
        if (parsed !== undefined) this.log.warn(`cache index ${this.indexPath} has an unexpected shape; starting empty`);
      } else {
        let dropped = 0;
        for (const [id, entry] of Object.entries(res.data.media)) {
          if (!MEDIA_ID_RE.test(id)) {
            dropped++;
            continue;
          }
          let st;
          try {
            st = await fs.stat(entry.path);
          } catch {
            dropped++;
            continue;
          }
          if (!st.isFile() || st.size !== entry.size || st.mtimeMs !== entry.mtimeMs || mediaIdFor(entry.path, st.size, st.mtimeMs) !== id) {
            dropped++;
            continue;
          }
          this.entries.set(id, entry);
        }
        if (dropped) this.log.info(`cache index: dropped ${dropped} stale entr${dropped === 1 ? 'y' : 'ies'}`);
      }
    }

    // Folder sizes, including orphans (folders whose id is no longer in the index).
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!MEDIA_ID_RE.test(name)) continue;
      const full = path.join(this.dir, name);
      try {
        if (!(await fs.stat(full)).isDirectory()) continue;
      } catch {
        continue;
      }
      this.bytes.set(name, await dirSize(full));
    }
    this.dirty = false;
  }

  get(id: string): IndexEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  set(id: string, entry: IndexEntry): void {
    this.entries.set(id, entry);
    this.scheduleSave();
  }

  touch(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.lastAccess = this.now();
    this.scheduleSave();
  }

  delete(id: string): void {
    if (this.entries.delete(id)) this.scheduleSave();
  }

  // ---------------------------------------------------------------- sizes

  addBytes(id: string, n: number): void {
    this.bytes.set(id, Math.max(0, (this.bytes.get(id) ?? 0) + n));
  }

  bytesOf(id: string): number {
    return this.bytes.get(id) ?? 0;
  }

  totalBytes(): number {
    let t = 0;
    for (const n of this.bytes.values()) t += n;
    return t;
  }

  async recomputeBytes(id: string): Promise<number> {
    const n = await dirSize(this.mediaDir(id));
    if (n > 0) this.bytes.set(id, n);
    else this.bytes.delete(id);
    return n;
  }

  // ---------------------------------------------------------------- eviction

  /**
   * Remove whole media folders, oldest `lastAccess` first (orphan folders first of all), until
   * the total is within `maxBytes`. Ids for which `isProtected` returns true are skipped.
   * Returns the evicted ids.
   */
  async evict(maxBytes: number, isProtected: (id: string) => boolean = () => false): Promise<string[]> {
    const evicted: string[] = [];
    if (maxBytes <= 0) return evicted;
    const skipped = new Set<string>();
    while (this.totalBytes() > maxBytes) {
      let victim: string | null = null;
      let victimAccess = Number.POSITIVE_INFINITY;
      for (const [id, n] of this.bytes) {
        if (n <= 0 || skipped.has(id) || isProtected(id)) continue;
        const access = this.entries.get(id)?.lastAccess ?? -1;
        if (access < victimAccess) {
          victimAccess = access;
          victim = id;
        }
      }
      if (victim === null) break;
      const freed = this.bytes.get(victim) ?? 0;
      try {
        await fs.rm(this.mediaDir(victim), { recursive: true, force: true });
        this.bytes.delete(victim);
        evicted.push(victim);
        this.log.info(`cache: evicted ${victim} (${(freed / 1e6).toFixed(1)} MB, last used ${victimAccess > 0 ? new Date(victimAccess).toISOString() : 'never'})`);
      } catch (err) {
        this.log.warn(`cache: could not remove ${victim}: ${String(err)}`);
        skipped.add(victim);
        await this.recomputeBytes(victim);
      }
    }
    return evicted;
  }

  // ---------------------------------------------------------------- persistence

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, this.saveDelayMs);
    this.saveTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    this.saving = (async () => {
      const media: Record<string, IndexEntry> = {};
      for (const [id, e] of this.entries) media[id] = e;
      const body = JSON.stringify({ version: 1, media }, null, 1);
      const tmp = `${this.indexPath}.tmp`;
      try {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.writeFile(tmp, body, 'utf8');
        await fs.rename(tmp, this.indexPath);
      } catch (err) {
        this.dirty = true;
        this.log.warn(`cache: could not write index: ${String(err)}`);
      }
    })();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) total += await dirSize(full);
    else if (d.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

export async function fileSize(file: string): Promise<number> {
  try {
    const st = await fs.stat(file);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
