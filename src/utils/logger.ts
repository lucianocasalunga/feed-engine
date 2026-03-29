import { config } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.logLevel as Level] ?? 1;

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(level: Level, module: string, msg: string, data?: unknown): void {
  if (LEVELS[level] < currentLevel) return;
  const prefix = `[${timestamp()}] [${level.toUpperCase()}] [${module}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${msg}`, data);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: unknown) => log('debug', module, msg, data),
    info: (msg: string, data?: unknown) => log('info', module, msg, data),
    warn: (msg: string, data?: unknown) => log('warn', module, msg, data),
    error: (msg: string, data?: unknown) => log('error', module, msg, data),
  };
}
