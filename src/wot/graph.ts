import WebSocket from 'ws';
import { config } from '../utils/config';
import { createLogger } from '../utils/logger';
import { setWotTrust, getRedis } from '../redis/client';

const log = createLogger('wot');

// Grafo social: pubkey -> Set<pubkeys que segue>
const followGraph = new Map<string, Set<string>>();

// Trust scores calculados
const trustScores = new Map<string, number>();

export function processFollowList(pubkey: string, tags: string[][]): void {
  const follows = new Set<string>();
  for (const tag of tags) {
    if (tag[0] === 'p' && tag[1]) {
      follows.add(tag[1]);
    }
  }
  followGraph.set(pubkey, follows);
}

export function calculateGlobalTrust(): Map<string, number> {
  // PageRank simplificado:
  // Trust de um autor = quantas pessoas o seguem, ponderado pelo trust de quem segue
  // Iteracao simples (3 passes) em vez de convergencia completa

  const followerCount = new Map<string, number>();
  const weightedScore = new Map<string, number>();

  // Passo 1: contar seguidores diretos
  for (const [, follows] of followGraph) {
    for (const followed of follows) {
      followerCount.set(followed, (followerCount.get(followed) || 0) + 1);
    }
  }

  // Passo 2: score base = log10(1 + seguidores)
  for (const [pubkey, count] of followerCount) {
    weightedScore.set(pubkey, Math.log10(1 + count));
  }

  // Passo 3: boost por seguidores bem conectados (1 iteracao de PageRank)
  for (const [follower, follows] of followGraph) {
    const followerScore = weightedScore.get(follower) || 0;
    if (followerScore < 0.5) continue; // ignorar contas com poucos seguidores

    const boost = followerScore / follows.size; // distribuir score entre follows
    for (const followed of follows) {
      const current = weightedScore.get(followed) || 0;
      weightedScore.set(followed, current + boost * 0.15); // damping factor
    }
  }

  // Normalizar para escala 0.1 - 1.0
  let maxScore = 0;
  for (const score of weightedScore.values()) {
    if (score > maxScore) maxScore = score;
  }

  trustScores.clear();
  if (maxScore > 0) {
    for (const [pubkey, score] of weightedScore) {
      // Minimo 0.1 (desconhecido), maximo 1.0
      const normalized = 0.1 + (score / maxScore) * 0.9;
      trustScores.set(pubkey, normalized);
    }
  }

  return trustScores;
}

export async function persistTrustScores(): Promise<void> {
  let count = 0;
  for (const [pubkey, trust] of trustScores) {
    await setWotTrust(pubkey, trust);
    count++;
  }
  log.info(`${count} trust scores persistidos no Redis`);
}

export async function loadExistingFollowLists(): Promise<void> {
  log.info('Carregando follow lists existentes do strfry...');

  return new Promise((resolve) => {
    const ws = new WebSocket(config.strfryUrl);
    const subId = 'wot-bootstrap';
    let count = 0;

    ws.on('open', () => {
      // Buscar todas as follow lists (kind 3) mais recentes
      ws.send(JSON.stringify(['REQ', subId, { kinds: [3], limit: 10000 }]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const event = msg[2];
          processFollowList(event.pubkey, event.tags);
          count++;
        }
        if (msg[0] === 'EOSE' && msg[1] === subId) {
          ws.close();
          log.info(`${count} follow lists carregadas, ${followGraph.size} pubkeys no grafo`);
          resolve();
        }
      } catch (err) {
        log.error('Erro ao parsear follow list', err);
      }
    });

    ws.on('error', (err) => {
      log.error('Erro ao carregar follow lists', err);
      resolve();
    });

    // Timeout de seguranca
    setTimeout(() => {
      ws.close();
      log.warn(`Timeout ao carregar follow lists (${count} carregadas)`);
      resolve();
    }, 30000);
  });
}

let wotInterval: NodeJS.Timeout | null = null;

export async function startWotEngine(): Promise<void> {
  // Bootstrap: carregar follow lists existentes
  await loadExistingFollowLists();

  // Calcular trust inicial
  const scores = calculateGlobalTrust();
  await persistTrustScores();
  log.info(`WoT Engine ativo: ${scores.size} pubkeys com trust score`);

  // Recalcular periodicamente
  wotInterval = setInterval(async () => {
    try {
      calculateGlobalTrust();
      await persistTrustScores();
    } catch (err) {
      log.error('Erro no recalculo WoT', err);
    }
  }, config.wot.recalcIntervalMs);
}

export function stopWotEngine(): void {
  if (wotInterval) clearInterval(wotInterval);
}

export function getFollowGraph(): Map<string, Set<string>> {
  return followGraph;
}

export function getTrustScore(pubkey: string): number {
  return trustScores.get(pubkey) || 0.1;
}
