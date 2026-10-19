// Line-preserving `.env` editor. The host console writes API keys here so they survive a restart;
// everything else in the file (comments, blank lines, other keys, indentation, CRLF vs LF) stays
// byte-for-byte as it was. Writes are atomic: temp file in the same directory, then rename.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The right-hand side of `KEY=…` so that dotenv (v16+) parses back exactly `value`.
 * Plain when safe. Otherwise double quotes (dotenv expands `\n` / `\r` there, nothing else), or
 * single quotes when the value itself contains `"` or a backslash (dotenv reads those verbatim).
 * A value with both quote kinds and a newline cannot be represented losslessly; it is written
 * best-effort with `\"`, which dotenv keeps as typed.
 */
export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (!/[\s#"'\\]/.test(value)) return value;
  const hasDq = value.includes('"');
  const hasSq = value.includes("'");
  const hasBs = value.includes('\\');
  const hasNl = /[\r\n]/.test(value);
  if (!hasDq && !hasBs) return `"${escapeNewlines(value)}"`;
  if (!hasSq && !hasNl) return `'${value}'`;
  return `"${escapeNewlines(value.replace(/"/g, '\\"'))}"`;
}

function escapeNewlines(s: string): string {
  return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export interface UpsertEnvResult {
  path: string;
  /** True when the file did not exist before. */
  created: boolean;
  replaced: string[];
  appended: string[];
}

/**
 * Set `KEY=value` for every entry of `values` in the dotenv file at `filePath`, creating it when
 * missing. The first live `KEY=` line is replaced in place (an indented or `export KEY=` line
 * keeps its prefix); a commented-out `# KEY=` line is not the key and is left alone. Keys that
 * have no live line are appended at the end. An empty string writes `KEY=` (present but empty).
 */
export async function upsertEnvValues(filePath: string, values: Readonly<Record<string, string>>): Promise<UpsertEnvResult> {
  for (const key of Object.keys(values)) {
    if (!KEY_RE.test(key)) throw new Error(`invalid .env key "${key}"`);
  }

  let original: string | null = null;
  try {
    original = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const eol = original !== null && original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original === null || original === '' ? [] : original.split(/\r\n|\n/);
  // A trailing newline shows up as a final empty element; the join below puts the newline back.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const replaced: string[] = [];
  const appended: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`);
    const assignment = `${key}=${formatEnvValue(value)}`;
    let done = false;
    for (let i = 0; i < lines.length && !done; i++) {
      const m = re.exec(lines[i] ?? '');
      if (!m) continue;
      lines[i] = `${m[1] ?? ''}${assignment}`;
      replaced.push(key);
      done = true;
    }
    if (!done) {
      lines.push(assignment);
      appended.push(key);
    }
  }

  const text = lines.length ? lines.join(eol) + eol : '';
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return { path: filePath, created: original === null, replaced, appended };
}
