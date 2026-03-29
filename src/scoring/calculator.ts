import { config } from '../utils/config';
import { createLogger } from '../utils/logger';
import {
  getEngagement,
  getWotTrust,
  setScore,
  keys,
  getRedis,
} from '../redis/client';

const log = createLogger('scoring');

const { weights, scoring } = config;

export function calculateEngagementScore(
  reactions: number,
  reposts: number,
  replies: number,
  mutualReplies: number,
  totalSats: number,
): number {
  const raw =
    (reactions * weights.reaction) +
    (reposts * weights.repost) +
    (replies * weights.reply) +
    (mutualReplies * weights.mutualReply);

  const zapScore = Math.log10(1 + totalSats) * weights.zapMultiplier;

  // Escala logaritmica no total (como Reddit)
  return Math.log10(1 + raw + zapScore) * 10;
}

export function calculateDecay(createdAt: number): number {
  const ageHours = (Date.now() / 1000 - createdAt) / 3600;
  if (ageHours < 0) return 1; // evento do futuro (tolerancia)
  return 1 / Math.pow(1 + ageHours / scoring.halfLifeHours, scoring.gravity);
}

export function calculatePowBonus(eventId: string): number {
  // Contar leading zero bits no event ID (hex)
  let bits = 0;
  for (const char of eventId) {
    const nibble = parseInt(char, 16);
    if (nibble === 0) {
      bits += 4;
    } else {
      bits += Math.clz32(nibble) - 28; // clz32 conta 32 bits, nibble e 4
      break;
    }
  }
  return bits * 0.5;
}

export async function scoreEvent(eventId: string): Promise<number> {
  const eng = await getEngagement(eventId);
  if (!eng.createdAt) return 0;

  const E = calculateEngagementScore(
    eng.reactions,
    eng.reposts,
    eng.replies,
    eng.mutualReplies,
    eng.totalSats,
  );

  const wot = await getWotTrust(eng.authorPubkey);
  const decay = calculateDecay(eng.createdAt);
  const pow = calculatePowBonus(eventId);

  const score = (E * wot * decay) + pow;
  return score;
}

export async function recalculateAllScores(): Promise<number> {
  const redis = getRedis();
  const trendingKey = keys.trending();
  const mostZappedKey = keys.mostZapped();

  let count = 0;
  const now = Date.now() / 1000;
  const maxAge = 48 * 3600; // 48 horas

  for await (const batch of redis.scanIterator({ MATCH: 'feed:engagement:*', COUNT: 200 })) {
    const keyList = Array.isArray(batch) ? batch : [batch];
    for (const key of keyList) {
      const eventId = (key as string).replace('feed:engagement:', '');
      const eng = await getEngagement(eventId);

      // Ignorar eventos muito antigos
      if (eng.createdAt && (now - eng.createdAt) > maxAge) {
        await redis.del(key as string);
        await redis.zRem(trendingKey, eventId);
        await redis.zRem(mostZappedKey, eventId);
        continue;
      }

      const score = await scoreEvent(eventId);
      if (score > 0) {
        await setScore(trendingKey, eventId, score);
        count++;
      }

      // Feed "mais zapados" usa so o zap score
      if (eng.totalSats > 0) {
        const zapScore = Math.log10(1 + eng.totalSats) * weights.zapMultiplier;
        const decay = calculateDecay(eng.createdAt);
        await setScore(mostZappedKey, eventId, zapScore * decay);
      }
    }
  }

  log.info(`Recalculados ${count} scores`);
  return count;
}

let recalcInterval: NodeJS.Timeout | null = null;

export function startScoring(): void {
  recalcInterval = setInterval(async () => {
    try {
      await recalculateAllScores();
    } catch (err) {
      log.error('Erro no recalculo de scores', err);
    }
  }, scoring.recalcIntervalMs);

  log.info(`Scoring ativo (recalculo a cada ${scoring.recalcIntervalMs / 1000}s)`);
}

export function stopScoring(): void {
  if (recalcInterval) clearInterval(recalcInterval);
}
