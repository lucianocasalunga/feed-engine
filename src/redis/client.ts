import { createClient } from 'redis';
import { config } from '../utils/config';
import { createLogger } from '../utils/logger';

const log = createLogger('redis');

export type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient;

export async function connectRedis(): Promise<RedisClient> {
  client = createClient({ url: config.redisUrl });
  client.on('error', (err) => log.error('Erro de conexao', err));
  client.on('connect', () => log.info('Conectado ao Redis'));
  await client.connect();
  return client;
}

export function getRedis(): RedisClient {
  return client;
}

// === Keys ===

const PREFIX = 'feed:';

export const keys = {
  engagement: (eventId: string) => `${PREFIX}engagement:${eventId}`,
  score: (eventId: string) => `${PREFIX}score:${eventId}`,
  trending: () => `${PREFIX}trending`,
  mostZapped: () => `${PREFIX}mostzapped`,
  global: () => `${PREFIX}global`,
  wotTrust: (pubkey: string) => `${PREFIX}wot:${pubkey}`,
  wotGraph: () => `${PREFIX}wot:graph`,
  authorReplies: (eventId: string) => `${PREFIX}authorreply:${eventId}`,
  stats: () => `${PREFIX}stats`,
};

// === Engagement ===

export async function getEngagement(eventId: string) {
  const data = await client.hGetAll(keys.engagement(eventId));
  return {
    reactions: parseInt(data.reactions || '0'),
    reposts: parseInt(data.reposts || '0'),
    replies: parseInt(data.replies || '0'),
    mutualReplies: parseInt(data.mutualReplies || '0'),
    totalSats: parseInt(data.totalSats || '0'),
    authorPubkey: data.authorPubkey || '',
    createdAt: parseInt(data.createdAt || '0'),
  };
}

export async function incrEngagement(eventId: string, field: string, amount: number = 1) {
  await client.hIncrBy(keys.engagement(eventId), field, amount);
}

export async function setEngagementField(eventId: string, field: string, value: string) {
  await client.hSet(keys.engagement(eventId), field, value);
}

// === Scores (Sorted Sets) ===

export async function setScore(feed: string, eventId: string, score: number) {
  await client.zAdd(feed, { score, value: eventId });
}

export async function getTopEvents(feed: string, offset: number, limit: number): Promise<Array<{ value: string; score: number }>> {
  return client.zRangeWithScores(feed, '+inf', '-inf', { BY: 'SCORE', REV: true, LIMIT: { offset, count: limit } });
}

export async function pruneOldEvents(feed: string, maxAge: number) {
  const cutoff = Date.now() / 1000 - maxAge;
  await client.zRemRangeByScore(feed, '-inf', cutoff);
}

// === WoT ===

export async function setWotTrust(pubkey: string, trust: number) {
  await client.set(keys.wotTrust(pubkey), trust.toString(), { EX: 1200 }); // 20min TTL
}

export async function getWotTrust(pubkey: string): Promise<number> {
  const val = await client.get(keys.wotTrust(pubkey));
  return val ? parseFloat(val) : 0.1; // desconhecido = 0.1
}

// === Stats ===

export async function incrStat(field: string, amount: number = 1) {
  await client.hIncrBy(keys.stats(), field, amount);
}

export async function getStats() {
  return client.hGetAll(keys.stats());
}
