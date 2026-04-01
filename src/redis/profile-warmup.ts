/**
 * profile-warmup.ts — Aquecimento do cache de perfis no startup
 *
 * Busca os 5000 perfis mais recentes do strfry e popula Redis.
 * Refresh periódico a cada 4h dos pubkeys WoT.
 */

import WebSocket from 'ws';
import { config } from '../utils/config';
import { createLogger } from '../utils/logger';
import { cacheProfile } from './profile-cache';
import { getFollowGraph } from '../wot/graph';

const log = createLogger('warmup');

const WARMUP_LIMIT = 5000;
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 horas

/**
 * Busca kind:0 em batch do strfry e cacheia no Redis.
 */
async function fetchAndCacheProfiles(filter: Record<string, unknown>, label: string): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const timeout = setTimeout(() => {
      ws.close();
      resolve(count);
    }, 30000); // 30s max

    const ws = new WebSocket(config.strfryUrl);
    const subId = `warmup-${label}-${Date.now()}`;

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          cacheProfile(msg[2]).catch(() => {});
          count++;
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeout);
          ws.close();
          resolve(count);
        }
      } catch {
        // Ignora mensagens malformadas
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve(count);
    });
  });
}

/**
 * Warmup inicial: busca os perfis mais recentes do strfry.
 */
async function initialWarmup(): Promise<void> {
  log.info('Iniciando warmup de perfis...');
  const count = await fetchAndCacheProfiles(
    { kinds: [0], limit: WARMUP_LIMIT },
    'initial'
  );
  log.info(`Warmup completo: ${count} perfis cacheados no Redis`);
}

/**
 * Refresh periódico: re-busca perfis dos pubkeys no grafo WoT.
 */
async function refreshWotProfiles(): Promise<void> {
  const graph = getFollowGraph();
  const pubkeys = [...graph.keys()];

  if (pubkeys.length === 0) {
    log.debug('WoT vazio, pulando refresh');
    return;
  }

  log.info(`Refresh WoT: ${pubkeys.length} pubkeys`);

  // Busca em batches de 100
  for (let i = 0; i < pubkeys.length; i += 100) {
    const batch = pubkeys.slice(i, i + 100);
    await fetchAndCacheProfiles(
      { kinds: [0], authors: batch },
      `wot-${i}`
    );
  }

  log.info('Refresh WoT completo');
}

/**
 * Inicia warmup + agenda refresh periódico.
 */
export function warmupProfileCache(): void {
  // Warmup inicial após 5s (não bloqueia startup)
  setTimeout(async () => {
    await initialWarmup();

    // Refresh periódico a cada 4h
    setInterval(() => {
      refreshWotProfiles().catch(err => {
        log.error('Erro no refresh WoT', err);
      });
    }, REFRESH_INTERVAL_MS);
  }, 5000);
}
