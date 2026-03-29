import { connectRedis } from './redis/client';
import { StrfrySubscriber } from './collectors/strfry-subscriber';
import { setupEngagementCollector } from './collectors/engagement-collector';
import { startScoring, stopScoring, recalculateAllScores } from './scoring/calculator';
import { startWotEngine, stopWotEngine, processFollowList } from './wot/graph';
import { startApi } from './api/server';
import { keys, setScore, getRedis } from './redis/client';
import { createLogger } from './utils/logger';

const log = createLogger('main');

async function main(): Promise<void> {
  log.info('=== Feed Engine v1.0.0 - LiberNet ===');

  // 1. Conectar ao Redis
  await connectRedis();
  log.info('Redis conectado');

  // 2. Iniciar WoT Engine (carrega follow lists do strfry)
  await startWotEngine();

  // 3. Conectar ao strfry e coletar engagement
  const subscriber = new StrfrySubscriber();

  // WoT: processar follow lists em tempo real
  subscriber.on('follow_list', (event) => {
    processFollowList(event.pubkey, event.tags);
  });

  // Feed global: registrar posts por timestamp (cronologico)
  subscriber.on('post', async (event) => {
    await setScore(keys.global(), event.id, event.created_at);
    // Manter so ultimos 5000 no global
    const redis = getRedis();
    const size = await redis.zCard(keys.global());
    if (size > 5000) {
      await redis.zRemRangeByRank(keys.global(), 0, size - 5001);
    }
  });

  setupEngagementCollector(subscriber);
  subscriber.connect();

  // 4. Iniciar scoring periodico
  startScoring();

  // 5. Primeiro calculo de scores
  await recalculateAllScores();

  // 6. Iniciar API REST
  startApi();

  log.info('Feed Engine totalmente operacional!');

  // Graceful shutdown
  const shutdown = () => {
    log.info('Encerrando...');
    subscriber.close();
    stopScoring();
    stopWotEngine();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('Erro fatal', err);
  process.exit(1);
});
