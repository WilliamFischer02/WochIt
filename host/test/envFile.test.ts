import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { formatEnvValue, upsertEnvValues } from '../src/settings/envFile.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'wochit-envfile-'));
const read = (p: string): string => readFileSync(p, 'utf8');

describe('formatEnvValue', () => {
  it('writes plain values raw and quotes the ones dotenv would mangle, round-tripping through dotenv', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['abc123-_', 'abc123-_'],
      ['x#y', '"x#y"'],
      ['a b', '"a b"'],
      [' padded ', '" padded "'],
      ["it's", '"it\'s"'],
      ['two\nlines', '"two\\nlines"'],
      ['say "hi"', "'say \"hi\"'"],
      ['back\\slash', "'back\\slash'"],
    ];
    for (const [value, expected] of cases) {
      expect(formatEnvValue(value)).toBe(expected);
      expect(parseDotenv(`K=${formatEnvValue(value)}`).K).toBe(value);
    }
  });
});

describe('upsertEnvValues', () => {
  it('creates the file (and its directory) when missing, one KEY=value per line, LF', async () => {
    const file = path.join(tmp(), 'nested', '.env');
    const r = await upsertEnvValues(file, { KLIPY_API_KEY: 'abc', GIPHY_API_KEY: '' });
    expect(r).toEqual({ path: file, created: true, replaced: [], appended: ['KLIPY_API_KEY', 'GIPHY_API_KEY'] });
    expect(read(file)).toBe('KLIPY_API_KEY=abc\nGIPHY_API_KEY=\n');
    expect(parseDotenv(read(file))).toEqual({ KLIPY_API_KEY: 'abc', GIPHY_API_KEY: '' });
  });

  it('replaces the first live KEY= line in place and leaves every other line alone', async () => {
    const file = path.join(tmp(), '.env');
    writeFileSync(file, '# GIF search\nWOCHIT_GIF_PROVIDER=auto\nKLIPY_API_KEY=old\n\nGIPHY_API_KEY=g1\nKLIPY_API_KEY=second\n', 'utf8');
    const r = await upsertEnvValues(file, { KLIPY_API_KEY: 'new' });
    expect(r.replaced).toEqual(['KLIPY_API_KEY']);
    expect(r.appended).toEqual([]);
    expect(r.created).toBe(false);
    expect(read(file)).toBe('# GIF search\nWOCHIT_GIF_PROVIDER=auto\nKLIPY_API_KEY=new\n\nGIPHY_API_KEY=g1\nKLIPY_API_KEY=second\n');
  });

  it('does not treat a commented-out "# KEY=" line as the key; appends instead', async () => {
    const file = path.join(tmp(), '.env');
    writeFileSync(file, '# KLIPY_API_KEY=disabled\n#KLIPY_API_KEY=also\nKLIPY_API_KEY_OLD=x\nOTHER=1\n', 'utf8');
    const r = await upsertEnvValues(file, { KLIPY_API_KEY: 'live' });
    expect(r.appended).toEqual(['KLIPY_API_KEY']);
    expect(read(file)).toBe('# KLIPY_API_KEY=disabled\n#KLIPY_API_KEY=also\nKLIPY_API_KEY_OLD=x\nOTHER=1\nKLIPY_API_KEY=live\n');
    expect(parseDotenv(read(file))).toEqual({ KLIPY_API_KEY_OLD: 'x', OTHER: '1', KLIPY_API_KEY: 'live' });
  });

  it('preserves CRLF line endings, indentation and an `export` prefix', async () => {
    const file = path.join(tmp(), '.env');
    writeFileSync(file, 'A=1\r\n  export KLIPY_API_KEY = old\r\nB=2\r\n', 'utf8');
    await upsertEnvValues(file, { KLIPY_API_KEY: 'new', C: '3' });
    expect(read(file)).toBe('A=1\r\n  export KLIPY_API_KEY=new\r\nB=2\r\nC=3\r\n');
    expect(parseDotenv(read(file))).toEqual({ A: '1', KLIPY_API_KEY: 'new', B: '2', C: '3' });
  });

  it('appends when absent, adding the missing final newline first', async () => {
    const file = path.join(tmp(), '.env');
    writeFileSync(file, 'A=1\nB=2', 'utf8'); // no trailing newline
    await upsertEnvValues(file, { GIPHY_API_KEY: 'g' });
    expect(read(file)).toBe('A=1\nB=2\nGIPHY_API_KEY=g\n');
  });

  it('an empty string clears the value but keeps the key present', async () => {
    const file = path.join(tmp(), '.env');
    writeFileSync(file, 'KLIPY_API_KEY=secret\nX=y\n', 'utf8');
    await upsertEnvValues(file, { KLIPY_API_KEY: '' });
    expect(read(file)).toBe('KLIPY_API_KEY=\nX=y\n');
    expect(parseDotenv(read(file))).toEqual({ KLIPY_API_KEY: '', X: 'y' });
  });

  it('quotes values that need it and leaves no temp file behind; rejects bad key names', async () => {
    const dir = tmp();
    const file = path.join(dir, '.env');
    await upsertEnvValues(file, { K: 'with space #hash' });
    expect(read(file)).toBe('K="with space #hash"\n');
    expect(parseDotenv(read(file)).K).toBe('with space #hash');
    expect(readdirSync(dir)).toEqual(['.env']);
    await expect(upsertEnvValues(file, { 'BAD-KEY': 'x' })).rejects.toThrow(/invalid .env key/);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(['.env']);
  });
});
