import WebSocket, { WebSocketServer } from 'ws';
import { Server } from 'http';
import { config } from '../utils/config';
import { createLogger } from '../utils/logger';
import { getTopEvents, keys } from '../redis/client';

const log = createLogger('ws-relay');

type FeedType = 'trending' | 'mostzapped' | 'global';

/**
 * WebSocket Nostr relay que serve feeds algoritmicos.
 * Clientes conectam e enviam REQ com tag #feed.
 * Para REQs normais (sem #feed), proxia para strfry.
 */
export function attachWsRelay(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/relay' });

  wss.on('connection', (clientWs: WebSocket) => {
    let strfryWs: WebSocket | null = null;

    clientWs.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg[0] === 'REQ') {
          const subId = msg[1] as string;
          const filters = msg.slice(2) as Record<string, unknown>[];
          const feedType = detectFeed(filters);

          if (feedType) {
            await serveFeedWs(clientWs, subId, feedType, filters[0]);
            return;
          }
        }

        // Proxy para strfry
        if (!strfryWs || strfryWs.readyState !== WebSocket.OPEN) {
          strfryWs = createStrfryProxy(clientWs);
          strfryWs.on('open', () => strfryWs!.send(raw.toString()));
        } else {
          strfryWs.send(raw.toString());
        }
      } catch (err) {
        log.error('Erro ao processar mensagem', (err as Error).message);
      }
    });

    clientWs.on('close', () => {
      if (strfryWs) strfryWs.close();
    });
  });

  log.info('WebSocket relay ativo em /relay');
}

function detectFeed(filters: Record<string, unknown>[]): FeedType | null {
  for (const filter of filters) {
    const feedTag = filter['#feed'] as string[] | undefined;
    if (feedTag && Array.isArray(feedTag) && feedTag.length > 0) {
      const feed = feedTag[0];
      if (feed === 'trending' || feed === 'mostzapped' || feed === 'global') {
        return feed;
      }
    }
  }
  return null;
}

async function serveFeedWs(clientWs: WebSocket, subId: string, feed: FeedType, filter: Record<string, unknown>): Promise<void> {
  const limit = (filter?.limit as number) || 50;
  const offset = (filter?.offset as number) || 0;

  const feedKey = feed === 'trending' ? keys.trending()
    : feed === 'mostzapped' ? keys.mostZapped()
    : keys.global();

  const eventIds = await getTopEvents(feedKey, offset, limit);

  if (eventIds.length === 0) {
    send(clientWs, ['EOSE', subId]);
    return;
  }

  // Buscar eventos completos do strfry
  const ids = eventIds.map(e => e.value);
  const ws = new WebSocket(config.strfryUrl);
  const internalSub = `feed-${Date.now()}`;

  const eventMap = new Map<string, unknown>();
  const orderMap = new Map<string, number>();
  ids.forEach((id, idx) => orderMap.set(id, idx));

  ws.on('open', () => {
    ws.send(JSON.stringify(['REQ', internalSub, { ids }]));
  });

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());

    if (msg[0] === 'EVENT' && msg[1] === internalSub) {
      eventMap.set(msg[2].id, msg[2]);
    }

    if (msg[0] === 'EOSE' && msg[1] === internalSub) {
      // Enviar na ordem do ranking
      const sorted = [...eventMap.entries()]
        .sort((a, b) => (orderMap.get(a[0]) || 0) - (orderMap.get(b[0]) || 0));

      for (const [, event] of sorted) {
        send(clientWs, ['EVENT', subId, event]);
      }
      send(clientWs, ['EOSE', subId]);
      ws.close();
    }
  });

  ws.on('error', () => {
    send(clientWs, ['EOSE', subId]);
  });

  setTimeout(() => { ws.close(); }, 10000);
}

function createStrfryProxy(clientWs: WebSocket): WebSocket {
  const ws = new WebSocket(config.strfryUrl);

  ws.on('message', (data: Buffer) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  ws.on('error', (err) => {
    log.error('Erro proxy strfry', (err as Error).message);
  });

  return ws;
}

function send(ws: WebSocket, msg: unknown[]): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
