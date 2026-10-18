// ffmpeg/ffprobe discovery, encoder detection and a small process runner.
//
// Resolution order (per binary): explicit option path → WOCHIT_FFMPEG / WOCHIT_FFPROBE env →
// (ffprobe only: beside the resolved ffmpeg) → PATH → winget package folder glob → winget Links.
// Encoder detection lists `ffmpeg -encoders` and then really encodes one second of testsrc2 with
// each candidate, because an encoder can be compiled in yet fail at runtime (no GPU, no driver).
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { EncoderChoice, Logger } from './index.js';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Cap on captured stdout/stderr, bytes. */
  maxOutput?: number;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run a process to completion, capturing output. Never rejects. */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxOutput = opts.maxOutput ?? 1 << 20;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void killTree(child);
        }, opts.timeoutMs)
      : null;
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < maxOutput) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = tail(stderr + d.toString('utf8'), maxOutput);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null, extra?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr: extra ? stderr + extra : stderr, timedOut });
    };
    child.on('error', (err) => finish(null, null, String(err)));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

export function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Terminate a child and its descendants. `kill()` is TerminateProcess on Windows; if the process
 * is still around after `graceMs` fall back to `taskkill /pid /t /f` (or SIGKILL elsewhere).
 */
export async function killTree(child: ChildProcess, graceMs = 500): Promise<void> {
  if (!isAlive(child)) return;
  const exited = new Promise<void>((res) => {
    if (!isAlive(child)) res();
    else child.once('exit', () => res());
  });
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  const gone = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)]);
  if (gone) return;
  if (process.platform === 'win32' && child.pid) {
    await run('taskkill', ['/pid', String(child.pid), '/t', '/f'], { timeoutMs: 5000 });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  await Promise.race([exited, delay(3000)]);
}

// ------------------------------------------------------------------ resolution

export interface ResolvedFfmpeg {
  ffmpeg: string;
  ffprobe: string;
  ffmpegSource: string;
  ffprobeSource: string;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

function exeName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function pathCandidates(name: string): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const out: string[] = [];
  if (process.platform === 'win32') {
    const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
    for (const d of dirs) {
      for (const e of exts) out.push(path.join(d, name + e.toLowerCase()));
    }
  } else {
    for (const d of dirs) out.push(path.join(d, name));
  }
  return out;
}

async function findBelow(dir: string, fileName: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) found.push(full);
    else if (e.isDirectory()) found.push(...(await findBelow(full, fileName, depth - 1)));
  }
  return found;
}

/** `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin\<exe>`, newest version first. */
async function wingetCandidates(exe: string): Promise<string[]> {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local) return [];
  const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  let names: string[];
  try {
    names = await fs.readdir(packages);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (!n.toLowerCase().startsWith('gyan.ffmpeg')) continue;
    const hits = await findBelow(path.join(packages, n), exe, 4);
    out.push(...hits.filter((h) => path.basename(path.dirname(h)).toLowerCase() === 'bin'));
  }
  return out.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function wingetLinks(exe: string): string[] {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local) return [];
  return [path.join(local, 'Microsoft', 'WinGet', 'Links', exe)];
}

async function resolveBinary(
  name: 'ffmpeg' | 'ffprobe',
  explicit: string,
  envValue: string | undefined,
  besideDir: string | null,
): Promise<{ path: string; source: string } | null> {
  const exe = exeName(name);
  const steps: Array<{ source: string; get: () => Promise<string[]> }> = [
    { source: 'option', get: async () => (explicit ? [explicit] : []) },
    { source: `env ${name === 'ffmpeg' ? 'WOCHIT_FFMPEG' : 'WOCHIT_FFPROBE'}`, get: async () => (envValue ? [envValue] : []) },
    { source: 'beside ffmpeg', get: async () => (besideDir ? [path.join(besideDir, exe)] : []) },
    { source: 'PATH', get: async () => pathCandidates(name) },
    { source: 'winget package', get: () => wingetCandidates(exe) },
    { source: 'winget links', get: async () => wingetLinks(exe) },
  ];
  for (const step of steps) {
    for (const candidate of await step.get()) {
      if (await isFile(candidate)) return { path: path.resolve(candidate), source: step.source };
    }
  }
  return null;
}

/** Null when either binary cannot be found. */
export async function resolveFfmpeg(explicitFfmpeg: string, explicitFfprobe: string): Promise<ResolvedFfmpeg | null> {
  const ffmpeg = await resolveBinary('ffmpeg', explicitFfmpeg.trim(), process.env.WOCHIT_FFMPEG?.trim(), null);
  if (!ffmpeg) return null;
  const ffprobe = await resolveBinary('ffprobe', explicitFfprobe.trim(), process.env.WOCHIT_FFPROBE?.trim(), path.dirname(ffmpeg.path));
  if (!ffprobe) return null;
  return { ffmpeg: ffmpeg.path, ffprobe: ffprobe.path, ffmpegSource: ffmpeg.source, ffprobeSource: ffprobe.source };
}

// ------------------------------------------------------------------ encoder detection

export const ENCODER_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as const;
export type EncoderName = (typeof ENCODER_ORDER)[number];

export interface EncoderTest {
  encoder: string;
  listed: boolean;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface EncoderDetection {
  encoder: string | null;
  tests: EncoderTest[];
  /** Name of the hls muxer option that passes options to the segment muxer, if any. */
  hlsSegmentOptionsFlag: string | null;
  error?: string;
}

export function parseEncoderList(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*V[A-Z.]{5}\s+(\S+)/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

export function testEncodeArgs(encoder: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-t', '1', '-c:v', encoder, '-f', 'null', '-',
  ];
}

export async function detectEncoder(ffmpeg: string, choice: EncoderChoice, log: Logger): Promise<EncoderDetection> {
  const list = await run(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 20000 });
  if (list.code !== 0) {
    return { encoder: null, tests: [], hlsSegmentOptionsFlag: null, error: `ffmpeg -encoders failed: ${list.stderr.trim() || list.code}` };
  }
  const listed = parseEncoderList(list.stdout);
  const order: string[] = choice === 'auto' ? [...ENCODER_ORDER] : [choice, 'libx264'].filter((v, i, a) => a.indexOf(v) === i);
  const tests: EncoderTest[] = [];
  let encoder: string | null = null;
  for (const name of order) {
    if (!listed.has(name)) {
      tests.push({ encoder: name, listed: false, ok: false, ms: 0, error: 'not in ffmpeg -encoders' });
      continue;
    }
    const t0 = Date.now();
    const r = await run(ffmpeg, testEncodeArgs(name), { timeoutMs: 30000 });
    const ms = Date.now() - t0;
    const ok = r.code === 0 && !r.timedOut;
    const test: EncoderTest = { encoder: name, listed: true, ok, ms };
    if (!ok) test.error = r.timedOut ? 'timed out' : firstLine(r.stderr) || `exit ${r.code}`;
    tests.push(test);
    log.debug(`encoder test ${name}: ${ok ? 'ok' : 'failed'} in ${ms} ms${test.error ? ` (${test.error})` : ''}`);
    if (ok) {
      encoder = name;
      break;
    }
  }
  if (choice !== 'auto' && encoder && encoder !== choice) {
    log.warn(`requested encoder ${choice} failed its test encode; using ${encoder}`);
  }
  const help = await run(ffmpeg, ['-hide_banner', '-h', 'muxer=hls'], { timeoutMs: 20000 });
  const hlsSegmentOptionsFlag = /-hls_segment_options\b/.test(help.stdout)
    ? 'hls_segment_options'
    : /-hls_ts_options\b/.test(help.stdout)
      ? 'hls_ts_options'
      : null;
  return { encoder, tests, hlsSegmentOptionsFlag };
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}
