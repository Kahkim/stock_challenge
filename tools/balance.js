'use strict';
/**
 * 밸런스 측정 도구.
 *
 *   node tools/balance.js
 *   node tools/balance.js --humans 36 --bots 50 --stocks 6 --min 15 --trials 24
 *   node tools/balance.js --set salaryAmount=200000 --set maxBonusRate=0.15
 *   node tools/balance.js --json          # 마지막 줄에 요약을 JSON 으로 (스크립트용)
 *
 * 설정을 바꿨을 때 게임이 여전히 의도대로 굴러가는지 확인한다.
 *
 * 사람 전략은 전부 **시장가**로 낸다. 화면이 시장가만 내기 때문이다 — 지정가로 재면
 * 화면에서 낼 수 없는 주문으로 밸런스를 재는 셈이 된다.
 *
 * 확인하는 것:
 *   1. 가만히 있는 사람이 확실히 꼴찌인가
 *   2. 아무거나 막 사는 사람이 확실히 하위권인가 — 뉴스대응·추격에 유의하게 지고, 중앙값보다 아래인가
 *   3. 오르는 종목에 먼저 올라탄 사람이 상위인가 / 뒷북이 하위인가
 *   4. 호가창 양쪽이 채워지는가 (매도 호가가 비는 시간 비율)
 *
 * 사람 전략 8가지를 봇 틈에 섞어 돌려 등수를 비교한다.
 *   무행동 · 공모후보유 · 빠른추격(10초창) · 뒷북추격(60초창) · 역추세 · 뉴스대응
 *   · 막사기(무작위 종목을 사기만 함) · 막사고팔기(무작위로 사고 판다)
 */
const { Game, makeRng } = require('../src/game');
const { DEFAULTS } = require('../src/config');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const overrides = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set' && argv[i + 1]) {
    const [k, v] = argv[i + 1].split('=');
    overrides[k] = /^-?[\d.]+$/.test(v) ? Number(v) : (v === 'true' ? true : v === 'false' ? false : v);
  }
}
// 점 표기로 중첩 설정도 덮어쓴다: --set news.impact=0.12
// Game 은 설정을 얕게 합치므로(botMix 만 깊게) news 같은 중첩 객체는 기본값에서 출발해
// 해당 키만 바꿔야 한다 — 아니면 news.enabled 가 사라져 뉴스가 통째로 꺼진다.
function applyOverrides(cfg) {
  for (const k of Object.keys(overrides)) {
    const path = k.split('.');
    if (path.length === 1) { cfg[k] = overrides[k]; continue; }
    const top = path[0];
    if (cfg[top] === undefined) cfg[top] = { ...(DEFAULTS[top] || {}) };
    let o = cfg[top];
    for (let i = 1; i < path.length - 1; i++) {
      o[path[i]] = { ...(o[path[i]] || {}) };
      o = o[path[i]];
    }
    o[path[path.length - 1]] = overrides[k];
  }
  return cfg;
}

const HUMANS = Number(arg('humans', 40));   // 10전략 × 4명
const BOTS = Number(arg('bots', 50));
const NSTOCK = Number(arg('stocks', 6));
const MINUTES = Number(arg('min', 15));
const TRIALS = Number(arg('trials', 16));
// 시드 기준점. 설정을 고를 때 쓴 시드로 검증까지 하면 그 시드에만 맞춘 값이 될 수 있으니,
// 검증은 다른 기준점(--seed 50000 등)으로 돌린다.
const SEED0 = Number(arg('seed', 90000));
const JSON_OUT = argv.includes('--json');
const POOL = ['SNU', 'YON', 'KOR', 'HYU', 'DGU', 'KKU', 'HON', 'KHU', 'KGU', 'SSU'];

// 그룹 번호 → 전략. 사람 HUMANS 명을 8그룹에 고르게 나눈다.
const STRATS = [
  { key: 'idle',   label: '무행동' },
  { key: 'hold',   label: '공모 후 보유' },
  { key: 'fast',   label: '빠른 추격 (10초창)' },
  { key: 'slow',   label: '뒷북 추격 (60초창)' },
  { key: 'contra', label: '역추세' },
  { key: 'news',   label: '뉴스 대응 (발생 2초 뒤)' },
  { key: 'rand',   label: '막 사기 (무작위 종목, 팔지 않음)' },
  { key: 'churn',  label: '막 사고팔기 (무작위)' },
  // 유능한 참가자: 공모로 전 종목을 담고, 뉴스에 반응하고, 남는 현금은 20초마다 최근 1분간
  // 가장 오른 종목에 넣는다. "막 사기" 와 달리 종목을 고르되, 현금을 놀리지도 않는다.
  // 막 사기가 이 전략까지 이기면 게임이 종목 선택이 아니라 투자 속도만 보상하는 것이다.
  { key: 'smart',  label: '상시 투자 + 뉴스 대응' },
  // 가장 문자 그대로의 막 사기: 아무 종목 하나에 몰빵하고 월급도 거기 다 넣는다. 팔지 않는다.
  { key: 'yolo',   label: '한 종목 몰빵 (무작위, 팔지 않음)' },
];
const NGROUP = STRATS.length;
const G = Object.fromEntries(STRATS.map((s, i) => [s.key, i]));

function oneRun(seed) {
  const cfg = applyOverrides({
    stockCodes: POOL.slice(0, NSTOCK), botCount: BOTS,
    ipoSec: 20, durationMin: MINUTES, tickMs: 250,
  });
  const g = new Game(cfg, seed);
  // 사람 전략의 무작위성은 게임 난수와 분리한다 — 게임 전개가 같은 시드에서 그대로 재현되게.
  const hr = makeRng((seed * 2654435761) >>> 0);
  const lot = g.cfg.lotSize;
  const H = [];
  for (let i = 0; i < HUMANS; i++) H.push(g.addPlayer('P' + i).id);
  g.start();

  const group = (k) => Math.min(NGROUP - 1, Math.floor(k / (HUMANS / NGROUP)));
  const pickStock = () => g.stocks[Math.floor(hr() * g.stocks.length)];

  // ── 개장 공모 ──
  for (let k = 0; k < HUMANS; k++) {
    const gp = group(k);
    if (gp === G.idle) continue;                               // 무행동은 청약도 안 한다
    if (gp === G.rand || gp === G.churn) {
      // 막 사는 사람: 아무 종목 둘에 화면 기본값(기준가의 105%)으로 찔러 본다
      const a = pickStock(), b = pickStock();
      for (const s of new Set([a, b])) {
        try { g.submitIpoBid(H[k], s.code, Math.round(s.initialPrice * 1.05), 150); } catch (_) {}
      }
      continue;
    }
    if (gp === G.yolo) {
      // 몰빵: 아무 종목 하나에 현금 60% 를 지른다
      const s = pickStock(), p = g.players.get(H[k]);
      const px = Math.round(s.initialPrice * 1.05);
      const q = Math.floor(p.cash * 0.6 / px / lot) * lot;
      try { g.submitIpoBid(H[k], s.code, px, q); } catch (_) {}
      p._yolo = s;
      continue;
    }
    // 나머지는 전 종목에 화면 기본값(기준가의 105%)으로 청약한다
    for (const s of g.stocks) {
      try { g.submitIpoBid(H[k], s.code, Math.round(s.initialPrice * 1.05), 150); } catch (_) {}
    }
  }
  const ipoTicks = Math.ceil(20 * 1000 / 250) + 5;
  for (let i = 0; i < ipoTicks; i++) g.tick();

  const byWindow = (win) => {
    const a = g.stocks.map(s => {
      const h = s.history;
      const b = Math.min(h.length - 1, win);
      const p = h[h.length - 1 - b];
      return { s, r: p && p.price > 0 ? s.last / p.price - 1 : 0 };
    });
    a.sort((x, y) => y.r - x.r);
    return a;
  };
  // 시장가 매수: 현금의 frac 만큼. 엔진이 현금이 닿는 만큼만 산다(초과분은 알아서 줄인다).
  const buy = (id, s, frac) => {
    const p = g.players.get(id);
    const q = Math.floor(p.cash * frac / (s.last * (1 + g.cfg.feeRate)) / lot) * lot;
    if (q >= lot) { try { g.submitOrder(id, s.code, 'buy', 'market', q); } catch (_) {} }
  };
  // 시장가 매도: 보유의 frac 만큼
  const sell = (id, s, frac) => {
    const p = g.players.get(id), held = p.holdings[s.code] || 0;
    const q = Math.floor(held * frac / lot) * lot;
    if (q >= lot) { try { g.submitOrder(id, s.code, 'sell', 'market', q); } catch (_) {} }
  };

  let noAsk = 0, noBid = 0, n = 0;
  const total = Math.ceil(MINUTES * 60 * 1000 / 250);
  for (let i = 0; i < total; i++) {
    g.tick();
    for (const s of g.stocks) { n++; if (s.book.bestAsk() === null) noAsk++; if (s.book.bestBid() === null) noBid++; }

    // 뉴스 대응: 뉴스가 뜬 2초 뒤 한 번만 움직인다.
    // 악재에 현금으로 도망가면 인플레이션에 그대로 당하므로, 팔고 나서 바로 다른 종목으로 갈아탄다.
    for (const nw of g.news) {
      if (g.tickNo - nw.tick !== 8) continue;
      const st = g.stockByCode.get(nw.code);
      const alt = g.stocks.filter(x => x.code !== nw.code);
      for (let k = 0; k < HUMANS; k++) {
        const gp = group(k);
        if (gp !== G.news && gp !== G.smart) continue;
        if (nw.sign > 0) buy(H[k], st, 0.45);
        else { sell(H[k], st, 0.9); if (alt.length) buy(H[k], alt[k % alt.length], 0.45); }
      }
    }
    // 상시 투자: 남는 현금을 20초마다 최근 1분간 가장 오른 종목에 넣는다
    if (i % 80 === 40) {
      const lead = byWindow(60)[0].s;
      for (let k = 0; k < HUMANS; k++) if (group(k) === G.smart) buy(H[k], lead, 0.6);
    }
    // 추격·역추세: 1분마다 창을 보고 갈아탄다
    if (i % 240 === 0) {
      const fast = byWindow(10), slow = byWindow(60);
      for (let k = 0; k < HUMANS; k++) {
        const gp = group(k);
        if (gp === G.fast)   { buy(H[k], fast[0].s, 0.5); sell(H[k], fast[fast.length - 1].s, 0.6); }
        if (gp === G.slow)   { buy(H[k], slow[0].s, 0.5); sell(H[k], slow[slow.length - 1].s, 0.6); }
        if (gp === G.contra) { buy(H[k], fast[fast.length - 1].s, 0.5); sell(H[k], fast[0].s, 0.6); }
      }
    }
    // 막 사기 / 막 사고팔기: 20초마다 아무 종목이나 누른다
    if (i % 80 === 0) {
      for (let k = 0; k < HUMANS; k++) {
        const gp = group(k);
        if (gp === G.rand) buy(H[k], pickStock(), 0.4);
        else if (gp === G.yolo) { const s = g.players.get(H[k])._yolo; if (s) buy(H[k], s, 0.6); }
        else if (gp === G.churn) {
          const s = pickStock();
          if (hr() < 0.5) buy(H[k], s, 0.4); else sell(H[k], s, 0.5);
        }
      }
    }
  }
  const rk = g.ranking(false);
  const avgOf = (gp) => {
    const ids = H.filter((_, k) => group(k) === gp);
    if (!ids.length) return 0;
    return ids.reduce((a, id) => a + rk.find(r => r.id === id).rank, 0) / ids.length;
  };
  const rel = g.stocks.map(s => s.last / s.open);
  const m = rel.reduce((a, b) => a + b, 0) / rel.length;
  const out = {
    newsCount: g.newsLog.length, newsPos: g.newsLog.filter(x => x.sign > 0).length,
    noAsk: noAsk / n * 100, noBid: noBid / n * 100, px: m,
    disp: Math.sqrt(rel.reduce((a, b) => a + (b - m) ** 2, 0) / rel.length) / m * 100,
    vol: g.stocks.reduce((a, s) => a + s.volume, 0),
  };
  for (const s of STRATS) out[s.key] = avgOf(G[s.key]);
  return out;
}

const acc = {}, samples = {};
for (let k = 0; k < TRIALS; k++) {
  const r = oneRun(SEED0 + k);
  for (const key in r) { acc[key] = (acc[key] || 0) + r[key] / TRIALS; (samples[key] ||= []).push(r[key]); }
}
const sd = (v) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};
const se = (key) => sd(samples[key]) / Math.sqrt(samples[key].length);
/**
 * 두 전략의 평균 등수 차이가 진짜인지 판정한다.
 * 개별 시행의 표준편차가 아니라 "평균의 표준오차"로 봐야 한다.
 * 시행 20회면 오차가 표준편차의 1/√20 로 줄어든다.
 * 차이가 표준오차의 2배를 넘으면 우연으로 보기 어렵다(대략 95% 신뢰).
 */
function better(betterKey, worseKey) {
  const a = samples[betterKey], b = samples[worseKey];
  const n = a.length;
  const gap = acc[worseKey] - acc[betterKey];
  const s = Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / n);
  return { gap, se: s, significant: gap > 2 * s };
}
const line = (label, key) => `  ${label.padEnd(26)} ${acc[key].toFixed(1).padStart(5)}등  (표준오차 ±${se(key).toFixed(2)})`;

console.log(`\n밸런스 측정 — 사람 ${HUMANS} / 봇 ${BOTS} / ${NSTOCK}종목 / ${MINUTES}분 / ${TRIALS}회 평균 · 주문은 전부 시장가`);
if (Object.keys(overrides).length) console.log('설정 덮어쓰기:', JSON.stringify(overrides));
console.log(`\n[사람 전략별 평균 등수]  (${HUMANS}명 중, 낮을수록 상위)`);
for (const s of STRATS.slice().sort((a, b) => acc[a.key] - acc[b.key])) console.log(line(s.label, s.key));

console.log('\n[시장 건강도]');
console.log(`  매도 호가가 비는 시간   ${acc.noAsk.toFixed(1)}%   (30% 넘으면 월급을 줄이거나 maxBonusRate 를 올릴 것)`);
console.log(`  매수 호가가 비는 시간   ${acc.noBid.toFixed(1)}%`);
console.log(`  평균 주가 변동          ${((acc.px - 1) * 100).toFixed(1)}%`);
console.log(`  종목 간 성과 격차       ${acc.disp.toFixed(1)}%   (작으면 어느 종목을 사도 똑같아 종목 선택이 무의미해진다)`);
console.log(`  총 체결 수량            ${acc.vol.toFixed(0)}주`);
console.log(`  돌발뉴스                ${acc.newsCount.toFixed(1)}건 (호재 ${acc.newsPos.toFixed(1)} / 악재 ${(acc.newsCount - acc.newsPos).toFixed(1)})`);

console.log('\n[판정]');
const verdicts = {};
const ok = (name, c, t, f) => { verdicts[name] = c; console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c ? t : f}`); };
ok('idleLast', acc.idle > HUMANS * 0.75, '가만히 있으면 확실히 하위권', `무행동이 ${acc.idle.toFixed(1)}등 — 페널티가 약하다`);

// 막 사기 판정: 중앙값보다 아래여야 하고, 유능한 참가자(상시 투자 + 뉴스 대응)에 유의하게 져야 한다
const RS = better('smart', 'rand');
ok('randBad',
   acc.rand > HUMANS / 2 && RS.significant,
   `막 사기는 확실히 하위권 (${acc.rand.toFixed(1)}등 · 유능한 참가자보다 ${RS.gap.toFixed(1)}등 뒤)`,
   `막 사기가 ${acc.rand.toFixed(1)}등 —` +
   `${acc.rand <= HUMANS / 2 ? ' 중앙값(' + (HUMANS / 2) + ')보다 위다.' : ''}` +
   `${!RS.significant ? ' 유능한 참가자(' + acc.smart.toFixed(1) + '등)와 차이 ' + RS.gap.toFixed(2) + ' 가 표준오차 2배(' + (2 * RS.se).toFixed(2) + ')에 못 미친다' : ''}`);
const CS = better('smart', 'churn');
ok('churnBad',
   acc.churn > HUMANS / 2 && CS.significant,
   `막 사고팔기도 확실히 하위권 (${acc.churn.toFixed(1)}등)`,
   `막 사고팔기가 ${acc.churn.toFixed(1)}등 — 유능한 참가자(${acc.smart.toFixed(1)}등)에 확실히 지지 않는다`);
const YS = better('smart', 'yolo');
ok('yoloBad',
   acc.yolo > HUMANS / 2 && YS.significant,
   `한 종목 몰빵도 확실히 하위권 (${acc.yolo.toFixed(1)}등 · 편차 ±${sd(samples.yolo).toFixed(1)})`,
   `한 종목 몰빵이 ${acc.yolo.toFixed(1)}등 (판마다 편차 ±${sd(samples.yolo).toFixed(1)}) — 유능한 참가자(${acc.smart.toFixed(1)}등)에 확실히 지지 않는다`);
ok('smartTop', acc.smart <= HUMANS * 0.25,
   `유능한 참가자가 상위권 (${acc.smart.toFixed(1)}등)`,
   `유능한 참가자가 ${acc.smart.toFixed(1)}등 — 상위 25%(${HUMANS / 4}등) 밖이다`);

ok('bookOk', acc.noAsk < 30, '호가창 양쪽이 대체로 채워진다', `매도 호가가 ${acc.noAsk.toFixed(1)}% 비어 있다`);
ok('dispOk', acc.disp > 8, '종목 선택이 결과를 가른다', `종목 간 격차 ${acc.disp.toFixed(1)}% — 어느 종목을 사도 비슷하다`);
const N = better('news', 'hold');
ok('newsWins', N.significant, `돌발뉴스에 빠르게 반응하면 유리 (뉴스대응 ${acc.news.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등)`,
   `뉴스대응 ${acc.news.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등 — 차이 ${N.gap.toFixed(2)} 가 표준오차의 2배(${(2 * N.se).toFixed(2)})에 못 미쳐 우열을 단정할 수 없다`);
const F = better('fast', 'hold');
ok('fastWins', F.significant, `오르는 종목에 먼저 올라타는 게 보유보다 유리 (추격 ${acc.fast.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등)`,
   `추격 ${acc.fast.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등 — 차이 ${F.gap.toFixed(2)} 가 표준오차의 2배(${(2 * F.se).toFixed(2)})에 못 미쳐 우열을 단정할 수 없다`);
const S = better('fast', 'slow');
ok('fastBeatsSlow', S.significant, `뒷북보다 먼저 잡는 게 유리 (빠른추격 ${acc.fast.toFixed(1)}등 vs 뒷북 ${acc.slow.toFixed(1)}등)`,
   `빠른추격과 뒷북의 차이가 유의하지 않다`);
console.log('');

if (JSON_OUT) {
  const ranks = {}; for (const s of STRATS) ranks[s.key] = +acc[s.key].toFixed(2);
  const ses = {}; for (const s of STRATS) ses[s.key] = +se(s.key).toFixed(2);
  console.log('JSON ' + JSON.stringify({
    humans: HUMANS, bots: BOTS, stocks: NSTOCK, minutes: MINUTES, trials: TRIALS, seed: SEED0, overrides,
    ranks, se: ses,
    market: { noAsk: +acc.noAsk.toFixed(1), noBid: +acc.noBid.toFixed(1), pxChangePct: +((acc.px - 1) * 100).toFixed(1),
              dispersionPct: +acc.disp.toFixed(1), volume: Math.round(acc.vol), news: +acc.newsCount.toFixed(1) },
    verdicts,
  }));
}
