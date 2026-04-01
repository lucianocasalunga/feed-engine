/**
 * profile-cache.ts — Cache Redis de perfis Nostr (kind:0) no Feed Engine
 *
 * Compartilha chaves Redis com o Nexus (nexus:profile:{pubkey}).
 * Endpoint POST /profiles resolve N pubkeys em uma chamada HTTP.
 */

import { getRedis } from './client';
import { createLogger } from '../utils/logger';
import { config } from '../utils/config';
import WebSocket from 'ws';

const log = createLogger('profile-cache');

const PREFIX = 'nexus:profile:';
const PROFILE_TTL = 21600; // 6 horas
const MAX_BATCH = 150;

export interface CachedProfile {
  pubkey: string;
  name: string;
  display_name: string;
  picture: string;
  about: string;
  nip05: string;
  lud16: string;
  created_at: number;
  cached_at: number;
}

/**
 * Cachear um perfil (kind:0) no Redis.
 * Só atualiza se o evento é mais recente que o cacheado.
 */
export async function cacheProfile(event: { pubkey: string; content: string; created_at: number }): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;

    const key = `${PREFIX}${event.pubkey}`;

    const existing = await redis.hGet(key, 'created_at');
    if (existing && parseInt(existing) >= event.created_at) {
      return;
    }

    const profile = JSON.parse(event.content);

    const data: Record<string, string> = {
      pubkey: event.pubkey,
      name: profile.name || profile.display_name || '',
      display_name: profile.display_name || profile.name || '',
      picture: profile.picture || '',
      about: profile.about || '',
      nip05: profile.nip05 || '',
      lud16: profile.lud16 || '',
      created_at: String(event.created_at),
      cached_at: String(Math.floor(Date.now() / 1000))
    };

    await redis.hSet(key, data);
    await redis.expire(key, PROFILE_TTL);

    log.debug(`cached: ${data.name || data.display_name || event.pubkey.substring(0, 12)}`);
  } catch (err) {
    log.debug(`cache error: ${(err as Error).message}`);
  }
}

/**
 * Buscar múltiplos perfis do Redis (pipeline).
 * Retorna Map<pubkey, profile> com os encontrados.
 */
export async function getCachedProfiles(pubkeys: string[]): Promise<Map<string, CachedProfile>> {
  const result = new Map<string, CachedProfile>();

  try {
    const redis = getRedis();
    if (!redis) return result;

    const batch = pubkeys.slice(0, MAX_BATCH);

    const pipeline = redis.multi();
    for (const pubkey of batch) {
      pipeline.hGetAll(`${PREFIX}${pubkey}`);
    }
    const responses = await pipeline.exec();

    for (let i = 0; i < batch.length; i++) {
      const data = responses[i] as unknown as Record<string, string> | null;
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        result.set(batch[i], {
          pubkey: data.pubkey || batch[i],
          name: data.name || '',
          display_name: data.display_name || '',
          picture: data.picture || '',
          about: data.about || '',
          nip05: data.nip05 || '',
          lud16: data.lud16 || '',
          created_at: parseInt(data.created_at) || 0,
          cached_at: parseInt(data.cached_at) || 0
        });
      }
    }
  } catch {
    // Retorna o que conseguiu
  }

  return result;
}

/**
 * Buscar perfis que faltam no Redis direto do strfry (WebSocket local).
 * Retorna os perfis encontrados e já cacheia no Redis.
 */
export async function fetchFromStrfry(pubkeys: string[]): Promise<Map<string, CachedProfile>> {
  const result = new Map<string, CachedProfile>();
  if (pubkeys.length === 0) return result;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve(result);
    }, 3000);

    const ws = new WebSocket(config.strfryUrl);
    const subId = 'profile-fetch-' + Date.now();

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: pubkeys }]));
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const event = msg[2];
          const profile = JSON.parse(event.content);
          const cached: CachedProfile = {
            pubkey: event.pubkey,
            name: profile.name || profile.display_name || '',
            display_name: profile.display_name || profile.name || '',
            picture: profile.picture || '',
            about: profile.about || '',
            nip05: profile.nip05 || '',
            lud16: profile.lud16 || '',
            created_at: event.created_at,
            cached_at: Math.floor(Date.now() / 1000)
          };
          result.set(event.pubkey, cached);
          // Cache no Redis em background
          cacheProfile(event).catch(() => {});
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeout);
          ws.close();
          resolve(result);
        }
      } catch {
        // Ignora mensagens malformadas
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}
