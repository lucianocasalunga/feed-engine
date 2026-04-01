import WebSocket from 'ws';
import { config } from '../utils/config';
import { createLogger } from '../utils/logger';
import { EventEmitter } from 'events';
import { cacheProfile } from '../redis/profile-cache';

const log = createLogger('subscriber');

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class StrfrySubscriber extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private subId = 'feed-engine-collector';

  connect(): void {
    log.info(`Conectando a ${config.strfryUrl}`);
    this.ws = new WebSocket(config.strfryUrl);

    this.ws.on('open', () => {
      log.info('Conectado ao strfry');
      this.subscribe();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === this.subId) {
          this.handleEvent(msg[2] as NostrEvent);
        }
      } catch (err) {
        log.error('Erro ao parsear mensagem', err);
      }
    });

    this.ws.on('close', () => {
      log.warn('Desconectado do strfry, reconectando em 5s...');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      log.error('Erro WebSocket', err);
    });
  }

  private subscribe(): void {
    if (!this.ws) return;

    // Kinds que nos interessam:
    // 0  = profile (cache Redis)
    // 1  = text note (posts + replies)
    // 6  = repost
    // 7  = reaction
    // 3  = follow list (para WoT)
    // 9735 = zap receipt
    const filter = {
      kinds: [0, 1, 3, 6, 7, 9735],
      since: Math.floor(Date.now() / 1000) - 3600, // ultima hora
    };

    this.ws.send(JSON.stringify(['REQ', this.subId, filter]));
    log.info('Subscricao ativa: kinds [0, 1, 3, 6, 7, 9735]');
  }

  private handleEvent(event: NostrEvent): void {
    switch (event.kind) {
      case 0:
        cacheProfile(event).catch(() => {});
        break;
      case 1:
        this.classifyTextNote(event);
        break;
      case 3:
        this.emit('follow_list', event);
        break;
      case 6:
        this.emit('repost', event);
        break;
      case 7:
        this.emit('reaction', event);
        break;
      case 9735:
        this.emit('zap', event);
        break;
    }
  }

  private classifyTextNote(event: NostrEvent): void {
    // Verificar se e reply (tem tag "e" com marker "reply" ou sem marker)
    const eTags = event.tags.filter(t => t[0] === 'e');
    if (eTags.length > 0) {
      this.emit('reply', event);
    } else {
      this.emit('post', event);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}
