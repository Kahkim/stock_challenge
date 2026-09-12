'use strict';
/**
 * 밸런스 측정 도구.
 *
 *   node tools/balance.js
 *   node tools/balance.js --humans 20 --bots 50 --stocks 6 --min 15 --trials 24
 *   node tools/balance.js --set salaryAmount=200000 --set maxBonusRate=0.15
 *
 * 설정을 바꿨을 때 게임이 여전히 의도대로 굴러가는지 확인한다. 확인하는 것:
 *   1. 가만히 있는 사람이 확실히 꼴찌인가
 *   2. 오르는 종목에 먼저 올라탄 사람이 상위인가 / 뒷북이 하위인가
 *   3. 호가창 양쪽이 채워지는가 (매도 호가가 비는 시간 비율)
 *
 * 사람 전략은 아래 5가지를 봇 틈에 섞어 돌려 등수를 비교한다.
 *   무행동 · 공모후보유 · 빠른추격(10초창) · 뒷북추격(60초창) · 역추세 · 뉴스대응
 */
const { Game } = require('../src/game');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const overrides = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set' && argv[i + 1]) {
    const [k, v] = argv[i + 1].split('=');
    overrides[k] = /^[\d.]+$/.test(v) ? Number(v) : (v === 'true' ? true : v === 'false' ? false : v);
  }
}
const HUMANS = Number(arg('humans', 24));
const BOTS = Number(arg('bots', 50));
const NSTOCK = Number(arg('stocks', 6));
const MINUTES = Number(arg('min', 15));
const TRIALS = Number(arg('trials', 16));
const POOL = ['SNU', 'YON', 'KOR', 'HYU', 'DGU', 'KKU', 'HON', 'KHU', 'KGU', 'SSU'];

function oneRun(seed) {
  const g = new Game({
    stockCodes: POOL.slice(0, NSTOCK), botCount: BOTS,
    ipoSec: 20, durationMin: MINUTES, tickMs: 250, ...overrides,
  }, seed);
  const H = [];
  for (let i = 0; i < HUMANS; i++) H.push(g.addPlayer('P' + i).id);
  g.start();

  const NGROUP = 6;
  const group = (k) => Math.min(NGROUP - 1, Math.floor(k / (HUMANS / NGROUP)));
  // 0=무행동 1=보유 2=빠른추격 3=뒷북 4=역추세 5=뉴스대응
  for (let k = 0; k < HUMANS; k++) {
    if (group(k) === 0) continue;                              // 무행동은 청약도 안 한다
    for (const s of g.stocks) {
      try { g.submitIpoBid(H[k], s.code, Math.round(s.initialPrice * 1.1), 150); } catch (_) {}
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
  // prem: 현재가 대비 얼마나 값을 더 쳐줄지. 0 이면 소극적 지정가(잘 안 잡힌다),
  // 0.02 면 공격적 지정가(대부분 즉시 체결된다).
  const buy = (id, s, frac, prem = 0) => {
    const p = g.players.get(id), px = Math.round(s.last * (1 + prem));
    const q = Math.floor(p.cash * frac / px / g.cfg.lotSize) * g.cfg.lotSize;
    if (q >= g.cfg.lotSize) { try { g.submitOrder(id, s.code, 'buy', px, q); } catch (_) {} }
  };
  const sell = (id, s, frac, prem = 0) => {
    const p = g.players.get(id), held = p.holdings[s.code] || 0;
    const q = Math.floor(held * frac / g.cfg.lotSize) * g.cfg.lotSize;
    if (q >= g.cfg.lotSize) {
      try { g.submitOrder(id, s.code, 'sell', Math.round(s.last * (1 - prem)), q); } catch (_) {}
    }
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
        if (group(k) !== 5) continue;
        if (nw.sign > 0) {
          buy(H[k], st, 0.45, 0.02);
        } else {
          sell(H[k], st, 0.9, 0.02);
          if (alt.length) buy(H[k], alt[k % alt.length], 0.45, 0.02);
        }
      }
    }
    if (i % 240 === 0) {
      const fast = byWindow(10), slow = byWindow(60);
      for (let k = 0; k < HUMANS; k++) {
        const gp = group(k);
        if (gp === 2) { buy(H[k], fast[0].s, 0.5); sell(H[k], fast[fast.length - 1].s, 0.6); }
        if (gp === 3) { buy(H[k], slow[0].s, 0.5); sell(H[k], slow[slow.length - 1].s, 0.6); }
        if (gp === 4) { buy(H[k], fast[fast.length - 1].s, 0.5); sell(H[k], fast[0].s, 0.6); }
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
  return {
    idle: avgOf(0), hold: avgOf(1), fast: avgOf(2), slow: avgOf(3), contra: avgOf(4), news: avgOf(5),
    newsCount: g.newsLog.length, newsPos: g.newsLog.filter(x => x.sign > 0).length,
    noAsk: noAsk / n * 100, noBid: noBid / n * 100, px: m,
    disp: Math.sqrt(rel.reduce((a, b) => a + (b - m) ** 2, 0) / rel.length) / m * 100,
    vol: g.stocks.reduce((a, s) => a + s.volume, 0),
  };
}

const acc = {}, samples = {};
for (let k = 0; k < TRIALS; k++) {
  const r = oneRun(90000 + k);
  for (const key in r) { acc[key] = (acc[key] || 0) + r[key] / TRIALS; (samples[key] ||= []).push(r[key]); }
}
const sd = (v) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};
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
  const se = Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / n);
  return { gap, se, significant: gap > 2 * se };
}
const line = (label, key) => {
  const se = sd(samples[key]) / Math.sqrt(samples[key].length);
  return `  ${label.padEnd(22)} ${acc[key].toFixed(1).padStart(5)}등  (표준오차 ±${se.toFixed(2)})`;
};

console.log(`\n밸런스 측정 — 사람 ${HUMANS} / 봇 ${BOTS} / ${NSTOCK}종목 / ${MINUTES}분 / ${TRIALS}회 평균`);
if (Object.keys(overrides).length) console.log('설정 덮어쓰기:', JSON.stringify(overrides));
console.log(`\n[사람 전략별 평균 등수]  (${HUMANS}명 중, 낮을수록 상위)`);
console.log(line('뉴스 대응 (발생 2초 뒤)', 'news'));
console.log(line('빠른 추격 (10초창)', 'fast'));
console.log(line('공모 후 보유', 'hold'));
console.log(line('역추세', 'contra'));
console.log(line('뒷북 추격 (60초창)', 'slow'));
console.log(line('무행동', 'idle'));

console.log('\n[시장 건강도]');
console.log(`  매도 호가가 비는 시간   ${acc.noAsk.toFixed(1)}%   (30% 넘으면 월급을 줄이거나 maxBonusRate 를 올릴 것)`);
console.log(`  매수 호가가 비는 시간   ${acc.noBid.toFixed(1)}%`);
console.log(`  평균 주가 변동          ${((acc.px - 1) * 100).toFixed(1)}%`);
console.log(`  종목 간 성과 격차       ${acc.disp.toFixed(1)}%   (작으면 어느 종목을 사도 똑같아 종목 선택이 무의미해진다)`);
console.log(`  총 체결 수량            ${acc.vol.toFixed(0)}주`);
console.log(`  돌발뉴스                ${acc.newsCount.toFixed(1)}건 (호재 ${acc.newsPos.toFixed(1)} / 악재 ${(acc.newsCount - acc.newsPos).toFixed(1)})`);

console.log('\n[판정]');
const ok = (c, t, f) => console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c ? t : f}`);
ok(acc.idle > HUMANS * 0.75, '가만히 있으면 확실히 하위권', `무행동이 ${acc.idle.toFixed(1)}등 — 페널티가 약하다`);

ok(acc.noAsk < 30, '호가창 양쪽이 대체로 채워진다', `매도 호가가 ${acc.noAsk.toFixed(1)}% 비어 있다`);
ok(acc.disp > 8, '종목 선택이 결과를 가른다', `종목 간 격차 ${acc.disp.toFixed(1)}% — 어느 종목을 사도 비슷하다`);
const N = better('news', 'hold');
ok(N.significant, `돌발뉴스에 빠르게 반응하면 유리 (뉴스대응 ${acc.news.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등)`,
   `뉴스대응 ${acc.news.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등 — 차이 ${N.gap.toFixed(2)} 가 표준오차의 2배(${(2 * N.se).toFixed(2)})에 못 미쳐 우열을 단정할 수 없다`);
const F = better('fast', 'hold');
ok(F.significant, `오르는 종목에 먼저 올라타는 게 보유보다 유리 (추격 ${acc.fast.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등)`,
   `추격 ${acc.fast.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등 — 차이 ${F.gap.toFixed(2)} 가 표준오차의 2배(${(2 * F.se).toFixed(2)})에 못 미쳐 우열을 단정할 수 없다`);
const S = better('fast', 'slow');
ok(S.significant, `뒷북보다 먼저 잡는 게 유리 (빠른추격 ${acc.fast.toFixed(1)}등 vs 뒷북 ${acc.slow.toFixed(1)}등)`,
   `빠른추격과 뒷북의 차이가 유의하지 않다`);
console.log('');
