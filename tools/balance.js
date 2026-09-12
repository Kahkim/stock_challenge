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
 *   무행동 · 공모후보유 · 빠른추격(10초창) · 뒷북추격(60초창) · 역추세
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
const HUMANS = Number(arg('humans', 20));
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

  const group = (k) => Math.floor(k / (HUMANS / 5));          // 0=무행동 1=보유 2=빠른추격 3=뒷북 4=역추세
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
  const buy = (id, s, frac) => {
    const p = g.players.get(id), px = Math.round(s.last);
    const q = Math.floor(p.cash * frac / px / g.cfg.lotSize) * g.cfg.lotSize;
    if (q >= g.cfg.lotSize) { try { g.submitOrder(id, s.code, 'buy', px, q); } catch (_) {} }
  };
  const sell = (id, s, frac) => {
    const p = g.players.get(id), held = p.holdings[s.code] || 0;
    const q = Math.floor(held * frac / g.cfg.lotSize) * g.cfg.lotSize;
    if (q >= g.cfg.lotSize) { try { g.submitOrder(id, s.code, 'sell', Math.round(s.last), q); } catch (_) {} }
  };

  let noAsk = 0, noBid = 0, n = 0;
  const total = Math.ceil(MINUTES * 60 * 1000 / 250);
  for (let i = 0; i < total; i++) {
    g.tick();
    for (const s of g.stocks) { n++; if (s.book.bestAsk() === null) noAsk++; if (s.book.bestBid() === null) noBid++; }
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
    return ids.reduce((a, id) => a + rk.find(r => r.id === id).rank, 0) / ids.length;
  };
  const rel = g.stocks.map(s => s.last / s.open);
  const m = rel.reduce((a, b) => a + b, 0) / rel.length;
  return {
    idle: avgOf(0), hold: avgOf(1), fast: avgOf(2), slow: avgOf(3), contra: avgOf(4),
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
const line = (label, key) =>
  `  ${label.padEnd(22)} ${acc[key].toFixed(1).padStart(5)}등  ±${sd(samples[key]).toFixed(1)}`;

console.log(`\n밸런스 측정 — 사람 ${HUMANS} / 봇 ${BOTS} / ${NSTOCK}종목 / ${MINUTES}분 / ${TRIALS}회 평균`);
if (Object.keys(overrides).length) console.log('설정 덮어쓰기:', JSON.stringify(overrides));
console.log(`\n[사람 전략별 평균 등수]  (${HUMANS}명 중, 낮을수록 상위)`);
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

console.log('\n[판정]');
const ok = (c, t, f) => console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c ? t : f}`);
ok(acc.idle > HUMANS * 0.75, '가만히 있으면 확실히 하위권', `무행동이 ${acc.idle.toFixed(1)}등 — 페널티가 약하다`);
ok(acc.slow > acc.fast + 2, '뒷북으로 따라가면 손해 (타이밍이 중요)', '빠른 추격과 뒷북의 차이가 작다');
ok(acc.noAsk < 30, '호가창 양쪽이 대체로 채워진다', `매도 호가가 ${acc.noAsk.toFixed(1)}% 비어 있다`);
ok(acc.disp > 8, '종목 선택이 결과를 가른다', `종목 간 격차 ${acc.disp.toFixed(1)}% — 어느 종목을 사도 비슷하다`);
const gap = acc.hold - acc.fast, noise = sd(samples.fast);
ok(gap > noise, '오르는 종목에 먼저 올라타는 게 보유보다 유리',
   `추격 ${acc.fast.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등 — 차이(${gap.toFixed(1)})가 측정 편차(±${noise.toFixed(1)})보다 작아 우열을 단정할 수 없다`);
console.log('');
