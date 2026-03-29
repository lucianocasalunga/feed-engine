import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from '../utils/config';
import { createLogger } from '../utils/logger';
import { getTopEvents, keys, getRedis } from '../redis/client';
import { getFollowGraph } from '../wot/graph';

const log = createLogger('cache');

const CACHE_DIR = config.ramdiskPath;
const TRENDING_FILE = join(CACHE_DIR, 'trending.json');
const MOSTZAPPED_FILE = join(CACHE_DIR, 'mostzapped.json');
const GLOBAL_FILE = join(CACHE_DIR, 'global.json');
const WOT_FILE = join(CACHE_DIR, 'wot-graph.json');
const STATS_FILE = join(CACHE_DIR, 'stats.json');

async function ensureCacheDir(): Promise<void> {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

export async function dumpFeedsToRamdisk(): Promise<void> {
  await ensureCacheDir();

  try {
    // Top 500 trending
    const trending = await getTopEvents(keys.trending(), 0, 500);
    await writeFile(TRENDING_FILE, JSON.stringify({
      feed: 'trending',
      updated_at: new Date().toISOString(),
      count: trending.length,
      events: trending.map(e => ({ id: e.value, score: Math.round(e.score * 100) / 100 })),
    }));

    // Top 500 most zapped
    const mostzapped = await getTopEvents(keys.mostZapped(), 0, 500);
    await writeFile(MOSTZAPPED_FILE, JSON.stringify({
      feed: 'mostzapped',
      updated_at: new Date().toISOString(),
      count: mostzapped.length,
      events: mostzapped.map(e => ({ id: e.value, score: Math.round(e.score * 100) / 100 })),
    }));

    // Top 500 global (cronologico)
    const global = await getTopEvents(keys.global(), 0, 500);
    await writeFile(GLOBAL_FILE, JSON.stringify({
      feed: 'global',
      updated_at: new Date().toISOString(),
      count: global.length,
      events: global.map(e => ({ id: e.value, timestamp: e.score })),
    }));

    // Stats snapshot
    const redis = getRedis();
    const stats = await redis.hGetAll(keys.stats());
    await writeFile(STATS_FILE, JSON.stringify({
      updated_at: new Date().toISOString(),
      feeds: {
        trending: trending.length,
        mostzapped: mostzapped.length,
        global: global.length,
      },
      totals: stats,
      wot_pubkeys: getFollowGraph().size,
    }));

    log.debug(`Cache ramdisk atualizado: ${trending.length}T/${mostzapped.length}Z/${global.length}G`);
  } catch (err) {
    log.error('Erro ao dump no ramdisk', err);
  }
}

export async function dumpWotToRamdisk(): Promise<void> {
  await ensureCacheDir();

  try {
    const graph = getFollowGraph();
    const serializable: Record<string, string[]> = {};

    for (const [pubkey, follows] of graph) {
      serializable[pubkey] = [...follows];
    }

    await writeFile(WOT_FILE, JSON.stringify({
      updated_at: new Date().toISOString(),
      pubkeys: graph.size,
      graph: serializable,
    }));

    log.debug(`WoT graph salvo no ramdisk: ${graph.size} pubkeys`);
  } catch (err) {
    log.error('Erro ao salvar WoT no ramdisk', err);
  }
}

export async function readCachedFeed(feed: 'trending' | 'mostzapped' | 'global'): Promise<unknown | null> {
  const file = feed === 'trending' ? TRENDING_FILE
    : feed === 'mostzapped' ? MOSTZAPPED_FILE
    : GLOBAL_FILE;

  try {
    const data = await readFile(file, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

let feedCacheInterval: NodeJS.Timeout | null = null;
let wotCacheInterval: NodeJS.Timeout | null = null;

export function startRamdiskCache(): void {
  // Dump feeds a cada 30 segundos
  feedCacheInterval = setInterval(dumpFeedsToRamdisk, 30000);

  // Dump WoT a cada 10 minutos
  wotCacheInterval = setInterval(dumpWotToRamdisk, 600000);

  // Dump inicial
  dumpFeedsToRamdisk();
  dumpWotToRamdisk();

  log.info(`Cache ramdisk ativo em ${CACHE_DIR}`);
}

export function stopRamdiskCache(): void {
  if (feedCacheInterval) clearInterval(feedCacheInterval);
  if (wotCacheInterval) clearInterval(wotCacheInterval);
}
