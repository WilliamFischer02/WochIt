// Tiny leveled logger with timestamps. Implements the `Logger` contract from media/index.ts so the
// same instance can be handed to the media pipeline, the VLC bridge and the room.
import { formatWithOptions } from 'node:util';
import type { Logger } from './media/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LABEL: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

export interface LogSink {
  write(line: string): void;
}

export interface ScopedLogger extends Logger {
  readonly level: LogLevel;
  /** Same sink and level, with `[scope]` prepended to every line. */
  child(scope: string): ScopedLogger;
}

const stdoutSink: LogSink = {
  write(line) {
    process.stdout.write(line + '\n');
  },
};

export function isLogLevel(v: unknown): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

export function createLogger(level: LogLevel = 'info', scope = '', sink: LogSink = stdoutSink): ScopedLogger {
  const min = ORDER[level];
  const prefix = scope ? `[${scope}] ` : '';

  const emit = (lvl: LogLevel, msg: string, rest: unknown[]): void => {
    if (ORDER[lvl] < min) return;
    const body = rest.length ? formatWithOptions({ depth: 4, breakLength: 200 }, msg, ...rest) : msg;
    sink.write(`${new Date().toISOString()} ${LABEL[lvl]} ${prefix}${body}`);
  };

  return {
    level,
    debug: (msg, ...rest) => emit('debug', msg, rest),
    info: (msg, ...rest) => emit('info', msg, rest),
    warn: (msg, ...rest) => emit('warn', msg, rest),
    error: (msg, ...rest) => emit('error', msg, rest),
    child: (s) => createLogger(level, scope ? `${scope}:${s}` : s, sink),
  };
}

/** A logger that drops everything. Handy default for pure modules under test. */
export const silentLogger: ScopedLogger = {
  level: 'error',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
