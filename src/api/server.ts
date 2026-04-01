import express from 'express';
import { createServer } from 'http';
import { config } from '../utils/config';
import { createLogger } from '../utils/logger';
import { getTopEvents, getStats, keys, getRedis } from '../redis/client';
import { getFollowGraph, getTrustScore } from '../wot/graph';
import { getTimings } from '../utils/metrics';
import { attachWsRelay } from './ws-relay';
import { getCachedProfiles, fetchFromStrfry } from '../redis/profile-cache';

const log = createLogger('api');

export function startApi(): void {
  const app = express();

  // CORS
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // JSON body parser
  app.use(express.json({ limit: '16kb' }));

  // GET /feed/trending — feed algoritmico principal
  app.get('/feed/trending', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const events = await getTopEvents(keys.trending(), offset, limit);
      res.json({
        feed: 'trending',
        count: events.length,
        events: events.map(e => ({ id: e.value, score: Math.round(e.score * 100) / 100 })),
      });
    } catch (err) {
      log.error('Erro no feed trending', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /feed/mostzapped — ordenado por zaps
  app.get('/feed/mostzapped', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const events = await getTopEvents(keys.mostZapped(), offset, limit);
      res.json({
        feed: 'mostzapped',
        count: events.length,
        events: events.map(e => ({ id: e.value, score: Math.round(e.score * 100) / 100 })),
      });
    } catch (err) {
      log.error('Erro no feed mostzapped', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /feed/global — cronologico (ultimos eventos do strfry via Redis)
  app.get('/feed/global', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const events = await getTopEvents(keys.global(), offset, limit);
      res.json({
        feed: 'global',
        count: events.length,
        events: events.map(e => ({ id: e.value, timestamp: e.score })),
      });
    } catch (err) {
      log.error('Erro no feed global', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /stats — metricas do Feed Engine
  app.get('/stats', async (_req, res) => {
    try {
      const stats = await getStats();
      const redis = getRedis();
      const trendingSize = await redis.zCard(keys.trending());
      const mostZappedSize = await redis.zCard(keys.mostZapped());
      const globalSize = await redis.zCard(keys.global());
      const graph = getFollowGraph();

      res.json({
        engine: {
          version: '1.0.0',
          uptime_seconds: Math.floor(process.uptime()),
          memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
        feeds: {
          trending: trendingSize,
          mostzapped: mostZappedSize,
          global: globalSize,
        },
        wot: {
          pubkeys_in_graph: graph.size,
        },
        totals: stats,
        performance: getTimings(),
        config: {
          half_life_hours: config.scoring.halfLifeHours,
          gravity: config.scoring.gravity,
          weights: config.weights,
          recalc_interval_s: config.scoring.recalcIntervalMs / 1000,
          wot_recalc_interval_s: config.wot.recalcIntervalMs / 1000,
        },
      });
    } catch (err) {
      log.error('Erro no stats', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /health
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // POST /profiles — resolver N pubkeys em uma chamada
  app.post('/profiles', async (req, res) => {
    try {
      const { pubkeys } = req.body;
      if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
        res.status(400).json({ error: 'pubkeys array required' });
        return;
      }

      // Validar: apenas hex pubkeys, max 150
      const valid = pubkeys
        .filter((pk: unknown) => typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk as string))
        .slice(0, 150) as string[];

      if (valid.length === 0) {
        res.json({ profiles: {} });
        return;
      }

      // L2: Redis pipeline
      const cached = await getCachedProfiles(valid);

      // Misses: buscar no strfry
      const missing = valid.filter(pk => !cached.has(pk));
      if (missing.length > 0) {
        const fetched = await fetchFromStrfry(missing);
        for (const [pk, profile] of fetched) {
          cached.set(pk, profile);
        }
      }

      // Formatar resposta (sem cached_at/created_at internos)
      const profiles: Record<string, unknown> = {};
      for (const [pk, p] of cached) {
        profiles[pk] = {
          name: p.name,
          display_name: p.display_name,
          picture: p.picture,
          about: p.about,
          nip05: p.nip05,
          lud16: p.lud16
        };
      }

      res.json({ profiles });
    } catch (err) {
      log.error('Erro no /profiles', err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /wot/:pubkey — trust score de uma pubkey
  app.get('/wot/:pubkey', (req, res) => {
    const trust = getTrustScore(req.params.pubkey);
    res.json({ pubkey: req.params.pubkey, trust: Math.round(trust * 1000) / 1000 });
  });

  const httpServer = createServer(app);

  // Attach WebSocket Nostr relay em /relay
  attachWsRelay(httpServer);

  httpServer.listen(config.port, '0.0.0.0', () => {
    log.info(`API rodando em http://0.0.0.0:${config.port}`);
    log.info(`WS Relay em ws://0.0.0.0:${config.port}/relay`);
  });
}
