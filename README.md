# Feed Engine

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Redis](https://img.shields.io/badge/Redis-7+-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Nostr](https://img.shields.io/badge/Nostr-NIP--01-8B5CF6)](https://nostr.com/)

**Algorithmic feed ranking engine for Nostr relays.** Provides trending, most-zapped, and global chronological feeds through both a REST API and a NIP-01 compatible WebSocket relay.

Built for [strfry](https://github.com/hoytech/strfry) relays, with native integration for the [Nexus Relay](https://github.com/nicholasglazer/nexus-relay) proxy layer.

---

## Architecture

```
                    Nostr Clients
                    |           |
              REST API      WS Relay (/relay)
                    \         /
                  Feed Engine (port 8890)
                   /    |     \
           Scoring   WoT     Engagement
           Engine   Graph    Collector
              \      |       /
               Redis (6381)       strfry (7777)
                                     |
                              Nostr Events DB
```

**Data flow:**

1. **Collector** subscribes to strfry via WebSocket, capturing reactions, reposts, replies, zaps, and follow lists in real time.
2. **WoT Engine** builds a social graph from follow lists (kind 3) and computes global trust scores using simplified PageRank.
3. **Scoring Engine** periodically recalculates ranking scores for all tracked events, applying engagement, trust, time decay, and PoW bonuses.
4. **Ramdisk Cache** writes pre-computed feed snapshots to a tmpfs mount for instant reads.
5. **API + WS Relay** serves the feeds to clients via HTTP or native Nostr WebSocket protocol.

---

## Scoring Formula

```
SCORE = Engagement x WoT x Decay + PoW_bonus
```

### Engagement

Weighted sum of interactions, scaled logarithmically (inspired by Reddit's algorithm):

```
raw = (reactions x 1) + (reposts x 2) + (replies x 8) + (mutual_replies x 25)
zap = log10(1 + total_sats) x 10

E = log10(1 + raw + zap) x 10
```

Zap scoring uses a logarithmic scale to prevent whale dominance -- 1,000 sats and 10,000 sats produce meaningfully different scores, but 100,000 and 1,000,000 do not diverge as drastically.

### Web of Trust (WoT)

Global (non-personalized) trust score per author, range `[0.1, 1.0]`:

- Base score = `log10(1 + follower_count)`
- One iteration of PageRank boost from well-connected followers (damping = 0.15)
- Normalized to `[0.1, 1.0]` -- unknown authors still get a baseline

### Time Decay

Hacker News-style gravity decay with a 12-hour half-life:

```
Decay = 1 / (1 + age_hours / 12) ^ 1.5
```

### PoW Bonus

Leading zero bits in the event ID contribute a small additive bonus:

```
PoW_bonus = leading_zero_bits x 0.5
```

---

## Feeds

| Feed | Endpoint | Description |
|------|----------|-------------|
| **Trending** | `GET /feed/trending` | Algorithmic ranking (score = engagement x trust x decay) |
| **Most Zapped** | `GET /feed/mostzapped` | Ranked by zap volume with time decay |
| **Global** | `GET /feed/global` | Reverse-chronological (latest 5,000 events) |

All endpoints accept `?limit=N&offset=M` query parameters (max limit: 200).

### Additional Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/stats` | GET | Engine metrics, feed sizes, WoT stats, performance timings |
| `/health` | GET | Health check |
| `/wot/:pubkey` | GET | Trust score for a specific pubkey |
| `/profiles` | POST | Batch profile resolution (up to 150 pubkeys) |

---

## WebSocket Relay

Feed Engine exposes a NIP-01 compatible WebSocket endpoint at `/relay`. Clients can request algorithmic feeds using a custom `#feed` tag in their subscription filters:

```json
["REQ", "sub1", {"#feed": ["trending"], "limit": 50}]
["REQ", "sub2", {"#feed": ["mostzapped"], "limit": 20}]
["REQ", "sub3", {"#feed": ["global"], "limit": 100}]
```

Requests without `#feed` are transparently proxied to the upstream strfry relay.

---

## Performance

Benchmarked with 87 tests, 0 failures:

| Operation | Concurrency | Avg Latency |
|-----------|-------------|-------------|
| API `/feed/trending` | 50 req | 39 ms |
| API `/feed/global` | 50 req | 6 ms |
| API `/stats` | 100 req | 27 ms |
| WS Relay (trending) | 50 connections | 61 ms |
| Score recalculation | periodic | 83 ms |

Memory footprint: ~25 MB RAM.

---

## Installation

### Prerequisites

- Node.js >= 22
- Redis instance (dedicated, port 6381 recommended)
- strfry relay running on `ws://127.0.0.1:7777`
- (Optional) tmpfs ramdisk for cache

### Setup

```bash
git clone https://github.com/libernet/feed-engine.git
cd feed-engine
npm install
```

### Configuration

Create a `.env` file in the project root:

```env
PORT=8890
STRFRY_URL=ws://127.0.0.1:7777
REDIS_URL=redis://127.0.0.1:6381
RAMDISK_PATH=./ramdisk
LOG_LEVEL=info

# Scoring
HALF_LIFE_HOURS=12
GRAVITY=1.5
RECALC_INTERVAL_MS=120000

# Engagement weights
WEIGHT_REACTION=1
WEIGHT_REPOST=2
WEIGHT_REPLY=8
WEIGHT_MUTUAL_REPLY=25
WEIGHT_ZAP_MULTIPLIER=10

# WoT
WOT_RECALC_INTERVAL_MS=600000
```

### Ramdisk (optional, recommended)

```bash
mkdir -p ramdisk
sudo mount -t tmpfs -o size=4G tmpfs ./ramdisk
```

### Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

### Systemd Service

```ini
[Unit]
Description=Feed Engine - Nostr Feed Ranking
After=network.target redis.service

[Service]
Type=simple
WorkingDirectory=/path/to/feed-engine
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Integration with Nexus Relay

Feed Engine is designed to sit behind the [Nexus Relay](https://github.com/nicholasglazer/nexus-relay) proxy:

- **HTTP proxy:** Nexus forwards `/feed/*` requests to Feed Engine's REST API.
- **WebSocket router:** Nexus detects `#feed` tags in client subscriptions and routes them to Feed Engine's WS relay.
- **Transparent fallback:** Non-feed requests pass through to strfry unchanged.

---

## Project Structure

```
src/
  index.ts                          # Entry point, orchestrates all subsystems
  api/
    server.ts                       # Express REST API
    ws-relay.ts                     # NIP-01 WebSocket relay with feed support
  collectors/
    engagement-collector.ts         # Real-time reaction/repost/reply/zap collector
    strfry-subscriber.ts            # WebSocket subscriber to strfry
  scoring/
    calculator.ts                   # Scoring formula implementation
    ramdisk-cache.ts                # Pre-computed feed snapshots on tmpfs
  wot/
    graph.ts                        # Web of Trust (PageRank) engine
  redis/
    client.ts                       # Redis keys and operations
    profile-cache.ts                # Profile resolution cache
    profile-warmup.ts               # Cache warmup on startup
  utils/
    config.ts                       # Environment configuration
    logger.ts                       # Structured logging
    metrics.ts                      # Performance timing metrics
```

---

## License

ISC
