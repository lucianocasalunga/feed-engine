# Feed Engine — MEMORIA.md

> Algoritmo de ranking para relays Nostr da LiberNet
> Serve: relay.libernet.app (strfry) + nexus.libernet.app (Nexus)

---

## Info

- **Porta:** 8890
- **Systemd:** feed-engine.service
- **GitHub:** https://github.com/lucianocasalunga/feed-engine
- **Ramdisk:** /mnt/projetos/feed-engine/ramdisk (4GB tmpfs)
- **Redis:** Compartilhado com Nexus (172.29.0.2:6379), prefix `feed:`

---

## Sessao 2026-03-29 — Criacao do projeto (CLAUDE CODE)

### Decisoes de design

**Formula:** `SCORE = Engagement x WoT x Decay + PoW_bonus`

**Pesos (pesquisados do Twitter open-source + Reddit):**
- reaction=1, repost=2, reply=8, mutual_reply=25
- zap = log10(1+sats) x 10 (escala logaritmica anti-baleia)
- Escala logaritmica global: log10(1+raw+zap) x 10

**WoT:** Global (nao personalizado), PageRank simplificado, escala 0.1-1.0
**Half-life:** 12h (rede pequena), gravity 1.5
**Feeds:** Trending (algoritmico), MostZapped, Global (cronologico)

### Integracao

- **Nexus:** HTTP proxy /feed/*, WS router detecta tag `#feed` nos filtros
- **strfry:** WS Relay em :8890/relay (proxy transparente + intercepta #feed)
- **Clientes:** `["REQ","sub1",{"#feed":["trending"],"limit":50}]`

### Performance (87 testes, 0 falhas)

| Operacao | Concorrencia | Tempo |
|---|---|---|
| API /feed/trending | 50 req | 39ms avg |
| API /feed/global | 50 req | 6ms avg |
| API /stats | 100 req | 27ms avg |
| WS Relay trending | 50 conexoes | 61ms avg |
| Recalculo scores | periodico | 83ms avg |
| RAM | - | 25MB |

### Arquivos-chave

| Arquivo | Funcao |
|---|---|
| src/index.ts | Entry point, orquestra tudo |
| src/scoring/calculator.ts | Formula de scoring |
| src/wot/graph.ts | Web of Trust (PageRank) |
| src/collectors/engagement-collector.ts | Coleta reactions/reposts/replies/zaps |
| src/collectors/strfry-subscriber.ts | WebSocket subscriber no strfry |
| src/api/server.ts | API REST (Express) |
| src/api/ws-relay.ts | WS Relay Nostr |
| src/scoring/ramdisk-cache.ts | Cache pre-computado no ramdisk |
| src/redis/client.ts | Keys Redis |

### Commits

- `cbe3e8c` — v1.0.0 inicial (fases 1-3)
- `c5e5744` — Fases 4-5 (integracao + cache + metricas)
- `94b0edf` — Fase 6 (87 testes)
- Tag: `time-machine-v1.0.0`
