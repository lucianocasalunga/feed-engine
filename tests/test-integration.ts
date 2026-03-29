/**
 * Testes de integração — Fluxo completo: strfry → Feed Engine → API
 * Requer: Feed Engine rodando em localhost:8890 + strfry em localhost:7777
 * Execução: npx ts-node tests/test-integration.ts
 */

import http from 'http';
import WebSocket from 'ws';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function httpGet(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, body: data });
        }
      });
    }).on('error', reject);
  });
}

function wsRequest(url: string, msg: unknown[]): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const responses: unknown[][] = [];

    ws.on('open', () => {
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      responses.push(parsed);

      if (parsed[0] === 'EOSE') {
        ws.close();
        resolve(responses);
      }
    });

    ws.on('error', reject);
    setTimeout(() => { ws.close(); resolve(responses); }, 10000);
  });
}

async function run(): Promise<void> {
  const BASE = 'http://localhost:8890';
  const WS_RELAY = 'ws://localhost:8890/relay';

  // ==============================
  // API REST
  // ==============================
  console.log('\n=== API REST ===');

  // Teste 1: Health check
  {
    const { status, body } = await httpGet(`${BASE}/health`);
    assert(status === 200, 'GET /health retorna 200');
    assert(body.status === 'ok', 'Health status = ok');
  }

  // Teste 2: Stats
  {
    const { status, body } = await httpGet(`${BASE}/stats`);
    assert(status === 200, 'GET /stats retorna 200');
    assert(body.engine?.version === '1.0.0', 'Engine version = 1.0.0');
    assert(typeof body.feeds?.trending === 'number', 'Stats tem feeds.trending');
    assert(typeof body.wot?.pubkeys_in_graph === 'number', 'Stats tem wot.pubkeys_in_graph');
    assert(body.config?.weights !== undefined, 'Stats tem config.weights');
    assert(body.performance !== undefined, 'Stats tem performance metrics');
  }

  // Teste 3: Feed trending
  {
    const { status, body } = await httpGet(`${BASE}/feed/trending?limit=10`);
    assert(status === 200, 'GET /feed/trending retorna 200');
    assert(body.feed === 'trending', 'Feed name = trending');
    assert(Array.isArray(body.events), 'Events é array');
    if (body.events.length > 0) {
      assert(typeof body.events[0].id === 'string', 'Event tem id (string)');
      assert(typeof body.events[0].score === 'number', 'Event tem score (number)');

      // Verificar que está ordenado por score decrescente
      if (body.events.length > 1) {
        const sorted = body.events.every((e: any, i: number) =>
          i === 0 || e.score <= body.events[i - 1].score);
        assert(sorted, 'Trending está ordenado por score decrescente');
      }
    }
  }

  // Teste 4: Feed mostzapped
  {
    const { status, body } = await httpGet(`${BASE}/feed/mostzapped?limit=10`);
    assert(status === 200, 'GET /feed/mostzapped retorna 200');
    assert(body.feed === 'mostzapped', 'Feed name = mostzapped');
  }

  // Teste 5: Feed global
  {
    const { status, body } = await httpGet(`${BASE}/feed/global?limit=10`);
    assert(status === 200, 'GET /feed/global retorna 200');
    assert(body.feed === 'global', 'Feed name = global');
    if (body.events.length > 0) {
      assert(typeof body.events[0].timestamp === 'number', 'Global event tem timestamp');
    }
  }

  // Teste 6: Limit e offset
  {
    const { body: full } = await httpGet(`${BASE}/feed/trending?limit=100`);
    const { body: page } = await httpGet(`${BASE}/feed/trending?limit=2&offset=0`);
    assert(page.events.length <= 2, 'Limit respeita max 2 eventos');

    if (full.events.length > 2) {
      const { body: page2 } = await httpGet(`${BASE}/feed/trending?limit=2&offset=2`);
      assert(page2.events[0]?.id !== page.events[0]?.id, 'Offset retorna eventos diferentes');
    }
  }

  // Teste 7: WoT trust de pubkey
  {
    const { status, body } = await httpGet(`${BASE}/wot/9b31915dd140b34774cb60c42fc0e015d800cde7f5e4f82a5f2d4e21d72803e4`);
    assert(status === 200, 'GET /wot/:pubkey retorna 200');
    assert(typeof body.trust === 'number', 'WoT retorna trust numérico');
    assert(body.trust >= 0.1 && body.trust <= 1.0, 'Trust entre 0.1 e 1.0',
      `got ${body.trust}`);
  }

  // Teste 8: Limit máximo respeitado
  {
    const { body } = await httpGet(`${BASE}/feed/trending?limit=999`);
    assert(body.events.length <= 200, 'Limit cap de 200 respeitado',
      `got ${body.events.length}`);
  }

  // ==============================
  // WS RELAY (protocolo Nostr)
  // ==============================
  console.log('\n=== WebSocket Relay ===');

  // Teste 9: REQ com #feed trending
  {
    const responses = await wsRequest(WS_RELAY, ['REQ', 'test-trending', { '#feed': ['trending'], limit: 5 }]);
    const events = responses.filter(r => r[0] === 'EVENT');
    const eose = responses.find(r => r[0] === 'EOSE');

    assert(eose !== undefined, 'WS: Recebe EOSE');
    assert(eose?.[1] === 'test-trending', 'WS: EOSE tem subId correto');

    if (events.length > 0) {
      assert(events[0][1] === 'test-trending', 'WS: EVENT tem subId correto');
      assert(typeof (events[0][2] as any)?.id === 'string', 'WS: EVENT tem evento completo com id');
      assert(typeof (events[0][2] as any)?.pubkey === 'string', 'WS: EVENT tem pubkey');
      assert(typeof (events[0][2] as any)?.content === 'string', 'WS: EVENT tem content');
      assert(typeof (events[0][2] as any)?.sig === 'string', 'WS: EVENT tem sig');
    }
    assert(events.length <= 5, `WS: Respeita limit=5 (got ${events.length})`);
  }

  // Teste 10: REQ normal (sem #feed) — proxy para strfry
  {
    const responses = await wsRequest(WS_RELAY, ['REQ', 'test-proxy', { kinds: [1], limit: 2 }]);
    const events = responses.filter(r => r[0] === 'EVENT');
    const eose = responses.find(r => r[0] === 'EOSE');

    assert(eose !== undefined, 'WS Proxy: Recebe EOSE do strfry');
    if (events.length > 0) {
      assert((events[0][2] as any)?.kind === 1, 'WS Proxy: Evento kind=1 do strfry');
    }
  }

  // Teste 11: REQ com #feed global
  {
    const responses = await wsRequest(WS_RELAY, ['REQ', 'test-global', { '#feed': ['global'], limit: 3 }]);
    const eose = responses.find(r => r[0] === 'EOSE');
    assert(eose?.[1] === 'test-global', 'WS Global: EOSE com subId correto');
  }

  // ==============================
  // NEXUS PROXY
  // ==============================
  console.log('\n=== Nexus HTTP Proxy ===');

  // Teste 12: Feed via Nexus
  {
    try {
      const { status, body } = await httpGet('http://localhost:8889/feed/trending?limit=5');
      assert(status === 200, 'Nexus /feed/trending retorna 200');
      assert(body.feed === 'trending', 'Nexus proxy retorna feed trending');
    } catch (err) {
      assert(false, 'Nexus /feed/trending acessível', (err as Error).message);
    }
  }

  // ==============================
  // RAMDISK CACHE
  // ==============================
  console.log('\n=== Ramdisk Cache ===');

  // Teste 13: Arquivos de cache existem
  {
    const fs = require('fs');
    const cacheDir = '/mnt/projetos/feed-engine/ramdisk';
    assert(fs.existsSync(`${cacheDir}/trending.json`), 'Cache trending.json existe');
    assert(fs.existsSync(`${cacheDir}/global.json`), 'Cache global.json existe');
    assert(fs.existsSync(`${cacheDir}/stats.json`), 'Cache stats.json existe');
    assert(fs.existsSync(`${cacheDir}/wot-graph.json`), 'Cache wot-graph.json existe');

    const trending = JSON.parse(fs.readFileSync(`${cacheDir}/trending.json`, 'utf-8'));
    assert(trending.feed === 'trending', 'Cache trending tem feed correto');
    assert(trending.updated_at !== undefined, 'Cache trending tem updated_at');
  }

  // ==============================
  // RESULTADO
  // ==============================
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Resultado: ${passed} passaram, ${failed} falharam de ${passed + failed} testes`);
  if (failed > 0) process.exit(1);
  console.log('Todos os testes passaram!\n');
}

run().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
