import { StrfrySubscriber, NostrEvent } from './strfry-subscriber';
import { incrEngagement, setEngagementField, incrStat } from '../redis/client';
import { createLogger } from '../utils/logger';

const log = createLogger('engagement');

export function setupEngagementCollector(subscriber: StrfrySubscriber): void {

  // Post novo: registrar autor e timestamp
  subscriber.on('post', async (event: NostrEvent) => {
    await setEngagementField(event.id, 'authorPubkey', event.pubkey);
    await setEngagementField(event.id, 'createdAt', event.created_at.toString());
    await incrStat('total_posts');
    log.debug(`Post: ${event.id.slice(0, 8)} de ${event.pubkey.slice(0, 8)}`);
  });

  // Reaction: incrementar contador do evento alvo
  subscriber.on('reaction', async (event: NostrEvent) => {
    const targetId = getTargetEventId(event);
    if (!targetId) return;
    await incrEngagement(targetId, 'reactions');
    await incrStat('total_reactions');
    log.debug(`Reaction em ${targetId.slice(0, 8)}`);
  });

  // Repost: incrementar contador do evento alvo
  subscriber.on('repost', async (event: NostrEvent) => {
    const targetId = getTargetEventId(event);
    if (!targetId) return;
    await incrEngagement(targetId, 'reposts');
    await incrStat('total_reposts');
    log.debug(`Repost de ${targetId.slice(0, 8)}`);
  });

  // Reply: incrementar contador + detectar reply mutua
  subscriber.on('reply', async (event: NostrEvent) => {
    const targetId = getTargetEventId(event);
    if (!targetId) return;

    await incrEngagement(targetId, 'replies');
    await incrStat('total_replies');

    // Registrar este reply como post tambem (pode receber engagement proprio)
    await setEngagementField(event.id, 'authorPubkey', event.pubkey);
    await setEngagementField(event.id, 'createdAt', event.created_at.toString());

    // Detectar reply mutua: o autor do post original respondeu?
    await checkMutualReply(event, targetId);

    log.debug(`Reply em ${targetId.slice(0, 8)} por ${event.pubkey.slice(0, 8)}`);
  });

  // Zap: extrair valor em sats e somar
  subscriber.on('zap', async (event: NostrEvent) => {
    const targetId = getTargetEventId(event);
    if (!targetId) return;

    const sats = extractZapAmount(event);
    if (sats > 0) {
      await incrEngagement(targetId, 'totalSats', sats);
      await incrStat('total_sats', sats);
      log.debug(`Zap de ${sats} sats em ${targetId.slice(0, 8)}`);
    }
  });

  log.info('Coletor de engagement ativo');
}

function getTargetEventId(event: NostrEvent): string | null {
  // Procurar tag "e" - o ultimo com marker "reply" ou o primeiro sem marker
  const eTags = event.tags.filter(t => t[0] === 'e');
  if (eTags.length === 0) return null;

  // NIP-10: procurar marker "reply" primeiro
  const replyTag = eTags.find(t => t[3] === 'reply');
  if (replyTag) return replyTag[1];

  // Fallback: ultimo tag "e" (deprecated positional)
  return eTags[eTags.length - 1][1];
}

async function checkMutualReply(replyEvent: NostrEvent, targetEventId: string): Promise<void> {
  // Importar aqui para evitar circular dependency em runtime
  const { getEngagement } = await import('../redis/client');
  const targetEngagement = await getEngagement(targetEventId);

  // Se o autor do reply e o autor do post original, e reply mutua
  if (targetEngagement.authorPubkey && replyEvent.pubkey === targetEngagement.authorPubkey) {
    // O autor original respondeu ao seu proprio post? Nao, isso e reply de alguem
    // Mutual reply = o AUTOR ORIGINAL respondeu a um reply no seu post
    // Precisamos verificar se este reply e DO autor original respondendo a alguem
    return;
  }

  // Verificar o caso correto: alguem respondeu, e agora o autor original responde de volta
  // O replyEvent.pubkey responde ao targetEventId
  // Se targetEventId tem authorPubkey != replyEvent.pubkey, e o targetEventId e um reply
  // cujo autor e o replyEvent.pubkey... complexo

  // Simplificacao: se o autor do post original (targetEngagement.authorPubkey)
  // e diferente do autor do reply (replyEvent.pubkey), registramos.
  // Depois, se o autor original postar um reply no mesmo thread, detectamos a mutualidade.

  // Marcar que este evento recebeu reply de alguem
  const { setEngagementField: setField } = await import('../redis/client');
  await setField(targetEventId, `replied_by:${replyEvent.pubkey}`, '1');

  // Verificar se o replyEvent.pubkey ja recebeu reply do autor original
  // (ou seja, o autor do targetEvent ja respondeu a este pubkey antes)
  if (targetEngagement.authorPubkey) {
    const authorPubkey = targetEngagement.authorPubkey;
    const { getRedis } = await import('../redis/client');
    const redis = getRedis();
    const hasAuthorReplied = await redis.hGet(
      `feed:engagement:${targetEventId}`,
      `replied_by:${authorPubkey}`
    );
    if (hasAuthorReplied) {
      await incrEngagement(targetEventId, 'mutualReplies');
      await incrStat('total_mutual_replies');
      log.info(`Reply mutua detectada em ${targetEventId.slice(0, 8)}!`);
    }
  }
}

function extractZapAmount(event: NostrEvent): number {
  // NIP-57: zap receipt tem bolt11 na tag "bolt11" ou no content
  // O valor esta encodado no bolt11 invoice
  const bolt11Tag = event.tags.find(t => t[0] === 'bolt11');
  if (!bolt11Tag) return 0;

  const bolt11 = bolt11Tag[1];
  return decodeBolt11Amount(bolt11);
}

function decodeBolt11Amount(bolt11: string): number {
  // Formato Lightning BOLT11: lnbc{amount}{multiplier}...
  // Exemplos: lnbc100n = 100 sats, lnbc1u = 100 sats, lnbc1m = 100000 sats
  const match = bolt11.match(/^lnbc(\d+)([munp]?)/i);
  if (!match) return 0;

  const value = parseInt(match[1]);
  const multiplier = match[2];

  switch (multiplier) {
    case 'm': return value * 100000;  // milli-bitcoin = 100k sats
    case 'u': return value * 100;      // micro-bitcoin = 100 sats
    case 'n': return value;             // nano-bitcoin ~= 1 sat (0.1 sat)
    case 'p': return Math.floor(value / 10); // pico-bitcoin = 0.1 sat
    case '':  return value * 100000000; // bitcoin em sats
    default:  return 0;
  }
}
