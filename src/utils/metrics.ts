import { createLogger } from './logger';

const log = createLogger('metrics');

interface TimingEntry {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

const timings = new Map<string, TimingEntry>();
let startedAt = Date.now();

export function recordTiming(operation: string, durationMs: number): void {
  const existing = timings.get(operation);
  if (existing) {
    existing.count++;
    existing.totalMs += durationMs;
    existing.minMs = Math.min(existing.minMs, durationMs);
    existing.maxMs = Math.max(existing.maxMs, durationMs);
  } else {
    timings.set(operation, { count: 1, totalMs: durationMs, minMs: durationMs, maxMs: durationMs });
  }
}

export function getTimings(): Record<string, { count: number; avg_ms: number; min_ms: number; max_ms: number }> {
  const result: Record<string, { count: number; avg_ms: number; min_ms: number; max_ms: number }> = {};
  for (const [op, entry] of timings) {
    result[op] = {
      count: entry.count,
      avg_ms: Math.round(entry.totalMs / entry.count * 100) / 100,
      min_ms: Math.round(entry.minMs * 100) / 100,
      max_ms: Math.round(entry.maxMs * 100) / 100,
    };
  }
  return result;
}

export function resetTimings(): void {
  timings.clear();
  startedAt = Date.now();
}

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

export function timeAsync<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  return fn().then((result) => {
    recordTiming(operation, performance.now() - start);
    return result;
  }).catch((err) => {
    recordTiming(`${operation}_error`, performance.now() - start);
    throw err;
  });
}
