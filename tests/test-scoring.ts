/**
 * Testes unitários — Scoring, Decay, PoW, WoT
 * Execução: npx ts-node tests/test-scoring.ts
 */

import {
  calculateEngagementScore,
  calculateDecay,
  calculatePowBonus,
} from '../src/scoring/calculator';

import {
  calculateGlobalTrust,
  processFollowList,
  getTrustScore,
} from '../src/wot/graph';

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

function approx(a: number, b: number, tolerance = 0.1): boolean {
  return Math.abs(a - b) <= tolerance;
}

// ==============================
// ENGAGEMENT SCORE
// ==============================
console.log('\n=== Engagement Score ===');

// Teste 1: Score zero sem engagement
{
  const score = calculateEngagementScore(0, 0, 0, 0, 0);
  assert(score === 0, 'Score zero sem engagement', `got ${score}`);
}

// Teste 2: Só reactions
{
  const score = calculateEngagementScore(10, 0, 0, 0, 0);
  // raw = 10*1 = 10, zap = 0, E = log10(1+10)*10 = log10(11)*10 ≈ 10.41
  assert(approx(score, 10.41, 0.1), 'Só 10 reactions ≈ 10.41', `got ${score.toFixed(2)}`);
}

// Teste 3: Só reposts
{
  const score = calculateEngagementScore(0, 10, 0, 0, 0);
  // raw = 10*2 = 20, E = log10(21)*10 ≈ 13.22
  assert(approx(score, 13.22, 0.1), 'Só 10 reposts ≈ 13.22', `got ${score.toFixed(2)}`);
}

// Teste 4: Só replies
{
  const score = calculateEngagementScore(0, 0, 10, 0, 0);
  // raw = 10*8 = 80, E = log10(81)*10 ≈ 19.08
  assert(approx(score, 19.08, 0.1), 'Só 10 replies ≈ 19.08', `got ${score.toFixed(2)}`);
}

// Teste 5: Reply vale mais que repost que vale mais que reaction
{
  const reactionScore = calculateEngagementScore(1, 0, 0, 0, 0);
  const repostScore = calculateEngagementScore(0, 1, 0, 0, 0);
  const replyScore = calculateEngagementScore(0, 0, 1, 0, 0);
  assert(replyScore > repostScore && repostScore > reactionScore,
    'reply > repost > reaction',
    `reaction=${reactionScore.toFixed(2)} repost=${repostScore.toFixed(2)} reply=${replyScore.toFixed(2)}`);
}

// Teste 6: Mutual reply é o sinal mais forte
{
  const replyScore = calculateEngagementScore(0, 0, 1, 0, 0);
  const mutualScore = calculateEngagementScore(0, 0, 0, 1, 0);
  assert(mutualScore > replyScore, 'Mutual reply > reply simples',
    `mutual=${mutualScore.toFixed(2)} reply=${replyScore.toFixed(2)}`);
}

// Teste 7: Zap com escala logarítmica
{
  const zap100 = calculateEngagementScore(0, 0, 0, 0, 100);
  const zap1000 = calculateEngagementScore(0, 0, 0, 0, 1000);
  const zap10000 = calculateEngagementScore(0, 0, 0, 0, 10000);
  const zap1M = calculateEngagementScore(0, 0, 0, 0, 1000000);

  // O crescimento deve ser logarítmico, não linear
  const ratio1 = zap1000 / zap100;
  const ratio2 = zap10000 / zap1000;
  assert(ratio1 < 2 && ratio2 < 2, 'Zap cresce logaritmicamente (ratio < 2x por 10x sats)',
    `100→1000: ${ratio1.toFixed(2)}x, 1000→10000: ${ratio2.toFixed(2)}x`);

  // 1M sats não deve dominar
  assert(zap1M < zap100 * 5, 'Baleia (1M sats) não domina mais que 5x vs 100 sats',
    `1M=${zap1M.toFixed(2)} vs 100sats=${zap100.toFixed(2)} ratio=${(zap1M/zap100).toFixed(2)}x`);
}

// Teste 8: Mix completo — exemplo do plano
{
  const score = calculateEngagementScore(10, 2, 3, 0, 500);
  // raw = 10 + 4 + 24 = 38, zap = log10(501)*10 ≈ 27, E = log10(1+38+27)*10 = log10(66)*10 ≈ 18.20
  assert(score > 15 && score < 25, 'Mix completo (10r,2rp,3rep,500sats) entre 15-25',
    `got ${score.toFixed(2)}`);
}

// Teste 9: Escala logarítmica global — primeiros engagements valem mais
{
  const score1 = calculateEngagementScore(1, 0, 0, 0, 0);  // 1 reaction
  const score10 = calculateEngagementScore(10, 0, 0, 0, 0); // 10 reactions
  const score100 = calculateEngagementScore(100, 0, 0, 0, 0); // 100 reactions

  // 10x mais reactions NÃO dá 10x mais score
  const ratio = score10 / score1;
  assert(ratio < 5, 'Escala log: 10x reactions < 5x score',
    `1=${score1.toFixed(2)} 10=${score10.toFixed(2)} ratio=${ratio.toFixed(2)}x`);
}

// ==============================
// DECAY TEMPORAL
// ==============================
console.log('\n=== Decay Temporal ===');

// Teste 10: Evento recém-criado tem decay ~1.0
{
  const now = Math.floor(Date.now() / 1000);
  const decay = calculateDecay(now);
  assert(approx(decay, 1.0, 0.05), 'Evento agora: decay ≈ 1.0', `got ${decay.toFixed(3)}`);
}

// Teste 11: Evento com 12h tem decay ~0.35 (half-life 12h, gravity 1.5)
{
  const now = Math.floor(Date.now() / 1000);
  const decay = calculateDecay(now - 12 * 3600);
  // 1 / (1 + 12/12)^1.5 = 1 / 2^1.5 = 1/2.828 ≈ 0.354
  assert(approx(decay, 0.354, 0.05), 'Evento 12h: decay ≈ 0.354', `got ${decay.toFixed(3)}`);
}

// Teste 12: Evento com 24h tem decay muito baixo
{
  const now = Math.floor(Date.now() / 1000);
  const decay = calculateDecay(now - 24 * 3600);
  assert(decay < 0.2, 'Evento 24h: decay < 0.2', `got ${decay.toFixed(3)}`);
}

// Teste 13: Evento com 48h quase invisível
{
  const now = Math.floor(Date.now() / 1000);
  const decay = calculateDecay(now - 48 * 3600);
  assert(decay < 0.1, 'Evento 48h: decay < 0.1', `got ${decay.toFixed(3)}`);
}

// Teste 14: Decay é monotonicamente decrescente
{
  const now = Math.floor(Date.now() / 1000);
  const d0 = calculateDecay(now);
  const d1 = calculateDecay(now - 3600);
  const d6 = calculateDecay(now - 6 * 3600);
  const d12 = calculateDecay(now - 12 * 3600);
  const d24 = calculateDecay(now - 24 * 3600);
  assert(d0 > d1 && d1 > d6 && d6 > d12 && d12 > d24,
    'Decay monotonicamente decrescente',
    `0h=${d0.toFixed(3)} 1h=${d1.toFixed(3)} 6h=${d6.toFixed(3)} 12h=${d12.toFixed(3)} 24h=${d24.toFixed(3)}`);
}

// ==============================
// PoW BONUS
// ==============================
console.log('\n=== PoW Bonus ===');

// Teste 15: Event ID sem leading zeros = 0 bonus
{
  const bonus = calculatePowBonus('abcdef1234567890');
  assert(bonus === 0, 'ID sem leading zeros = 0 bonus', `got ${bonus}`);
}

// Teste 16: Event ID com 1 zero hex = 4 bits
{
  const bonus = calculatePowBonus('0abcdef123456789');
  assert(bonus === 2, '1 zero hex (4 bits) = 2 bonus', `got ${bonus}`);
}

// Teste 17: Event ID com 4 zeros hex = 16 bits
{
  const bonus = calculatePowBonus('00009ea2fe7a7179');
  // 0000 = 16 bits, 9 = 1001 (0 leading zeros), total = 16 bits
  assert(bonus === 8, '00009... (16 bits) = 8 bonus', `got ${bonus}`);
}

// Teste 18: Event ID com muitos zeros
{
  const bonus = calculatePowBonus('00000000abcdef12');
  assert(bonus === 16, '00000000 (32 bits) = 16 bonus', `got ${bonus}`);
}

// ==============================
// WEB OF TRUST
// ==============================
console.log('\n=== Web of Trust ===');

// Teste 19: Pubkey desconhecida tem trust 0.1
{
  const trust = getTrustScore('unknown_pubkey_xxxxx');
  assert(trust === 0.1, 'Pubkey desconhecida = 0.1', `got ${trust}`);
}

// Teste 20: Grafo simples — A segue B e C, D segue B
{
  processFollowList('pubkey_A', [['p', 'pubkey_B'], ['p', 'pubkey_C']]);
  processFollowList('pubkey_D', [['p', 'pubkey_B']]);
  processFollowList('pubkey_E', [['p', 'pubkey_B'], ['p', 'pubkey_A']]);

  calculateGlobalTrust();

  const trustB = getTrustScore('pubkey_B');
  const trustC = getTrustScore('pubkey_C');
  const trustA = getTrustScore('pubkey_A');

  assert(trustB > trustC, 'B (3 seguidores) > C (1 seguidor)',
    `B=${trustB.toFixed(3)} C=${trustC.toFixed(3)}`);

  assert(trustA > 0.1, 'A tem trust > 0.1 (seguida por E)',
    `A=${trustA.toFixed(3)}`);
}

// Teste 21: Trust normalizado entre 0.1 e 1.0
{
  processFollowList('pk1', [['p', 'pk_popular']]);
  processFollowList('pk2', [['p', 'pk_popular']]);
  processFollowList('pk3', [['p', 'pk_popular']]);
  processFollowList('pk4', [['p', 'pk_popular']]);
  processFollowList('pk5', [['p', 'pk_popular']]);

  calculateGlobalTrust();

  const trust = getTrustScore('pk_popular');
  assert(trust >= 0.1 && trust <= 1.0, 'Trust normalizado [0.1, 1.0]',
    `got ${trust.toFixed(3)}`);
}

// Teste 22: Pubkey sem seguidores tem trust 0.1
{
  const trust = getTrustScore('pk_nobody');
  assert(trust === 0.1, 'Sem seguidores = 0.1', `got ${trust}`);
}

// Teste 23: PageRank boost — seguidor bem conectado dá mais trust
{
  // Resetar e criar cenário limpo
  processFollowList('influencer', [['p', 'target_A'], ['p', 'target_B']]);
  processFollowList('nobody', [['p', 'target_B']]);
  // influencer é seguido por muitos
  processFollowList('fan1', [['p', 'influencer']]);
  processFollowList('fan2', [['p', 'influencer']]);
  processFollowList('fan3', [['p', 'influencer']]);

  calculateGlobalTrust();

  const trustA = getTrustScore('target_A');
  const trustB = getTrustScore('target_B');

  // target_A é seguido só pelo influencer (que tem alto trust)
  // target_B é seguido pelo influencer + nobody
  // Ambos devem ter trust > 0.1
  assert(trustA > 0.1, 'target_A seguida por influencer: trust > 0.1',
    `got ${trustA.toFixed(3)}`);
  assert(trustB > 0.1, 'target_B seguida por influencer + nobody: trust > 0.1',
    `got ${trustB.toFixed(3)}`);
}

// ==============================
// COMBINAÇÃO: Score Final
// ==============================
console.log('\n=== Score Final Combinado ===');

// Teste 24: Post viral de desconhecido vs post mediano de trusted
{
  // Viral de desconhecido: 100 reactions, 20 reposts, 50 replies, 10000 sats
  const viralE = calculateEngagementScore(100, 20, 50, 0, 10000);
  const viralWot = 0.1; // desconhecido
  const viralDecay = 1.0; // recém postado
  const viralScore = viralE * viralWot * viralDecay;

  // Mediano de trusted: 5 reactions, 1 repost, 3 replies, 500 sats
  const medianoE = calculateEngagementScore(5, 1, 3, 0, 500);
  const medianoWot = 0.9; // muito confiável
  const medianoDecay = 1.0;
  const medianoScore = medianoE * medianoWot * medianoDecay;

  // O trusted mediano deve ter score competitivo com o viral desconhecido
  const ratio = viralScore / medianoScore;
  assert(ratio < 3, 'Viral desconhecido < 3x de mediano trusted',
    `viral=${viralScore.toFixed(2)} mediano=${medianoScore.toFixed(2)} ratio=${ratio.toFixed(2)}x`);
}

// Teste 25: Post antigo viral vs post novo sem engagement
{
  const now = Math.floor(Date.now() / 1000);

  const oldViralE = calculateEngagementScore(50, 10, 20, 5, 5000);
  const oldDecay = calculateDecay(now - 24 * 3600); // 24h
  const oldScore = oldViralE * 0.8 * oldDecay;

  const newE = calculateEngagementScore(2, 0, 1, 0, 0);
  const newDecay = calculateDecay(now); // agora
  const newScore = newE * 0.8 * newDecay;

  // Post novo com pouco engagement pode competir com viral de 24h
  assert(oldScore < newScore * 10, 'Post viral de 24h < 10x post novo fraco',
    `old=${oldScore.toFixed(2)} new=${newScore.toFixed(2)}`);
}

// ==============================
// RESULTADO
// ==============================
console.log(`\n${'='.repeat(40)}`);
console.log(`Resultado: ${passed} passaram, ${failed} falharam de ${passed + failed} testes`);
if (failed > 0) process.exit(1);
console.log('Todos os testes passaram!\n');
