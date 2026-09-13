'use strict';
/**
 * 밸런스 측정 도구.
 *
 *   node tools/balance.js                    # 사람 8·24·48명 (봇은 config 기본값) 을 한 번에 잰다
 *   node tools/balance.js --humans 24        # 한 구성만 자세히
 *   node tools/balance.js --curve            # 뉴스에 늦게 반응할수록 얼마나 손해인지 (선점 보상 곡선)
 *   node tools/balance.js --humans 20 --bots 50 --stocks 6 --min 15 --trials 24
 *   node tools/balance.js --set salaryAmount=200000 --set maxBonusRate=0.15 --set news.lifeSec=60
 *
 * 설정을 바꿨을 때 게임이 여전히 의도대로 굴러가는지 확인한다. 확인하는 것:
 *   1. 가만히 있는 사람이 확실히 꼴찌인가
 *   2. 오르는 종목에 먼저 올라탄 사람이 상위인가 / 뒷북이 하위인가
 *   3. 돌발뉴스에 빠르게 반응하면 보유보다 유리한가
 *   4. 호가창 양쪽이 채워지는가 (매도 호가가 비는 시간 비율)
 *
 * 밸런스는 방 크기(사람 수 대 봇 수)에 따라 달라진다. 그래서 기본 실행은 사람 수를
 * 세 가지로 바꿔 가며 잰다 — 한 구성에서만 통과하는 설정은 행사장에서 깨진다.
 *
 * 사람 전략 7가지를 봇 틈에 섞어 돌려 등수를 비교한다.
 *   무행동 · 공모후보유 · 빠른추격(10초창) · 뒷북추격(60초창) · 역추세 · 뉴스대응 · 전액투자(매분 월급 전부 매수)
 */
const { Game } = require('../src/game');
const { DEFAULTS, STOCK_POOL } = require('../src/config');

const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const overrides = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set' && argv[i + 1]) {
    const [k, v] = argv[i + 1].split('=');
    const val = /^-?[\d.]+$/.test(v) ? Number(v) : (v === 'true' ? true : v === 'false' ? false : v);
    // news.lifeSec 처럼 점으로 중첩 키를 지정할 수 있다
    const path = k.split('.');
    let o = overrides;
    for (let d = 0; d < path.length - 1; d++) o = (o[path[d]] ||= {});
    o[path[path.length - 1]] = val;
  }
}
if (overrides.news) overrides.news = { ...DEFAULTS.news, ...overrides.news };
if (overrides.botMix) overrides.botMix = { ...DEFAULTS.botMix, ...overrides.botMix };

const BOTS = Number(arg('bots', DEFAULTS.botCount));
const NSTOCK = Number(arg('stocks', 6));
const MINUTES = Number(arg('min', 15));
const TRIALS = Number(arg('trials', 16));
const POOL = STOCK_POOL.map(s => s.code);

// 전략 군. 순서가 곧 그룹 번호다.
const STRATS = ['idle', 'hold', 'fast', 'slow', 'contra', 'news', 'dca'];
const LABEL = {
  idle: '무행동', hold: '공모 후 보유', fast: '빠른 추격 (10초창)', slow: '뒷북 추격 (60초창)',
  contra: '역추세', news: '뉴스 대응 (2초 뒤)', dca: '전액 투자 (매분 월급 전부 매수)',
};

/**
 * 한 판을 돌리고 전략별 등수와 시장 지표를 돌려준다.
 * @param {number} humans   사람 수
 * @param {number} seed
 * @param {number} newsDelayTicks  뉴스대응 군이 반응하는 시점(틱). 8틱 = 2초
 */
function oneRun(humans, seed, newsDelayTicks = 8) {
  const g = new Game({
    stockCodes: POOL.slice(0, NSTOCK), botCount: BOTS,
    ipoSec: 20, durationMin: MINUTES, tickMs: 250, ...overrides,
  }, seed);
  const H = [];
  for (let i = 0; i < humans; i++) H.push(g.addPlayer('P' + i).id);
  g.start();

  const NG = STRATS.length;
  const group = (k) => STRATS[Math.min(NG - 1, Math.floor(k / (humans / NG)))];
  for (let k = 0; k < humans; k++) {
    if (group(k) === 'idle') continue;                          // 무행동은 청약도 안 한다
    for (const s of g.stocks) {
      try { g.submitIpoBid(H[k], s.code, Math.round(s.initialPrice * 1.1), 150); } catch (_) {}
    }
  }
  // 공모 청약 배수(발행량 대비 유효 청약 금액)를 마감 직전에 잰다
  let ipoDemand = 0, ipoFloat = 0;
  const ipoTicks = Math.ceil(20 * 1000 / 250) + 5;
  for (let i = 0; i < ipoTicks; i++) {
    if (g.phase === 'ipo') {
      ipoDemand = 0; ipoFloat = 0;
      for (const s of g.stocks) {
        ipoDemand += s.ipoBids.reduce((a, b) => a + b.qty * b.price, 0);
        ipoFloat += s.float * s.initialPrice;
      }
    }
    g.tick();
  }

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
    // 뉴스 대응: 뉴스가 뜬 뒤 정해진 시점에 한 번만 움직인다.
    // 악재에 현금으로 도망가면 인플레이션에 그대로 당하므로, 팔고 나서 바로 다른 종목으로 갈아탄다.
    for (const nw of g.news) {
      if (g.tickNo - nw.tick !== newsDelayTicks) continue;
      const st = g.stockByCode.get(nw.code);
      const alt = g.stocks.filter(x => x.code !== nw.code);
      for (let k = 0; k < humans; k++) {
        if (group(k) !== 'news') continue;
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
      for (let k = 0; k < humans; k++) {
        const gp = group(k);
        if (gp === 'fast') { buy(H[k], fast[0].s, 0.5); sell(H[k], fast[fast.length - 1].s, 0.6); }
        if (gp === 'slow') { buy(H[k], slow[0].s, 0.5); sell(H[k], slow[slow.length - 1].s, 0.6); }
        if (gp === 'contra') { buy(H[k], fast[fast.length - 1].s, 0.5); sell(H[k], fast[0].s, 0.6); }
        // 전액 투자: 종목 판단 없이 매분 현금을 전 종목에 고르게 넣는다. 가장 무식한 전략이자
        // 이 경제에서 가장 강한 전략이다 — 비교 기준선으로 둔다.
        if (gp === 'dca') for (const s of g.stocks) buy(H[k], s, 0.95 / g.stocks.length, 0.02);
      }
    }
  }
  const rk = g.ranking(false);
  const out = {};
  for (const st of STRATS) {
    const ids = H.filter((_, k) => group(k) === st);
    out[st] = ids.length ? ids.reduce((a, id) => a + rk.find(r => r.id === id).rank, 0) / ids.length : 0;
    out['pnl_' + st] = ids.length ? ids.reduce((a, id) => a + rk.find(r => r.id === id).pnlPct, 0) / ids.length : 0;
  }
  const rel = g.stocks.map(s => s.last / s.open);
  const m = rel.reduce((a, b) => a + b, 0) / rel.length;
  return {
    ...out,
    newsCount: g.newsLog.length, newsPos: g.newsLog.filter(x => x.sign > 0).length,
    noAsk: noAsk / n * 100, noBid: noBid / n * 100, px: m,
    disp: Math.sqrt(rel.reduce((a, b) => a + (b - m) ** 2, 0) / rel.length) / m * 100,
    vol: g.stocks.reduce((a, s) => a + s.volume, 0),
    ipoSub: ipoDemand / Math.max(1, ipoFloat),
    vsFair: g.stocks.reduce((a, s) => a + (s.last / s.fair - 1), 0) / g.stocks.length * 100,
  };
}

const sd = (v) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};

/** 같은 구성으로 TRIALS 번 돌려 평균과 표본을 모은다 */
function measure(humans, newsDelayTicks = 8) {
  const acc = {}, samples = {};
  for (let k = 0; k < TRIALS; k++) {
    const r = oneRun(humans, 90000 + k, newsDelayTicks);
    for (const key in r) { acc[key] = (acc[key] || 0) + r[key] / TRIALS; (samples[key] ||= []).push(r[key]); }
  }
  /**
   * 두 전략의 평균 등수 차이가 진짜인지 판정한다.
   * 개별 시행의 표준편차가 아니라 "평균의 표준오차"로 봐야 한다.
   * 시행 20회면 오차가 표준편차의 1/√20 로 줄어든다.
   * 차이가 표준오차의 2배를 넘으면 우연으로 보기 어렵다(대략 95% 신뢰).
   */
  const better = (betterKey, worseKey) => {
    const a = samples[betterKey], b = samples[worseKey];
    const gap = acc[worseKey] - acc[betterKey];
    const se = Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / a.length);
    return { gap, se, significant: gap > 2 * se };
  };
  const se = (key) => sd(samples[key]) / Math.sqrt(samples[key].length);
  return { humans, acc, samples, better, se };
}

/** 여섯 가지 판정. [통과여부, 통과문구, 실패문구] */
function judge(M) {
  const { humans, acc, better } = M;
  const N = better('news', 'hold'), F = better('fast', 'hold'), S = better('fast', 'slow');
  return [
    [acc.idle > humans * 0.75, '가만히 있으면 확실히 하위권', `무행동이 ${acc.idle.toFixed(1)}등 — 페널티가 약하다`],
    [acc.noAsk < 30, '호가창 양쪽이 대체로 채워진다', `매도 호가가 ${acc.noAsk.toFixed(1)}% 비어 있다`],
    [acc.disp > 8, '종목 선택이 결과를 가른다', `종목 간 격차 ${acc.disp.toFixed(1)}% — 어느 종목을 사도 비슷하다`],
    [N.significant, `돌발뉴스에 빠르게 반응하면 유리 (뉴스대응 ${acc.news.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등)`,
      `뉴스대응 ${acc.news.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등 — 차이 ${N.gap.toFixed(2)} 가 표준오차의 2배(${(2 * N.se).toFixed(2)})에 못 미쳐 우열을 단정할 수 없다`],
    [F.significant, `오르는 종목에 먼저 올라타는 게 보유보다 유리 (추격 ${acc.fast.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등)`,
      `추격 ${acc.fast.toFixed(1)}등 vs 보유 ${acc.hold.toFixed(1)}등 — 차이 ${F.gap.toFixed(2)} 가 표준오차의 2배(${(2 * F.se).toFixed(2)})에 못 미쳐 우열을 단정할 수 없다`],
    [S.significant, `뒷북보다 먼저 잡는 게 유리 (빠른추격 ${acc.fast.toFixed(1)}등 vs 뒷북 ${acc.slow.toFixed(1)}등)`,
      '빠른추격과 뒷북의 차이가 유의하지 않다'],
  ];
}

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', Z = '\x1b[0m';
const okLine = ([c, t, f]) => `  ${c ? G + '✓' + Z : R + '✗' + Z} ${c ? t : f}`;

/** 한 구성의 상세 보고 */
function report(M) {
  const { humans, acc, se } = M;
  const line = (key) => `  ${LABEL[key].padEnd(24)} ${acc[key].toFixed(1).padStart(5)}등  (표준오차 ±${se(key).toFixed(2)})   수익률 ${acc['pnl_' + key].toFixed(1).padStart(5)}%`;
  console.log(`\n[사람 전략별 평균 등수]  (${humans}명 중, 낮을수록 상위)`);
  for (const key of ['news', 'fast', 'hold', 'contra', 'slow', 'idle']) console.log(line(key));
  console.log(`  ${Y}참고${Z} ${LABEL.dca.padEnd(21)} ${acc.dca.toFixed(1).padStart(5)}등  (표준오차 ±${se('dca').toFixed(2)})   수익률 ${acc.pnl_dca.toFixed(1).padStart(5)}%`);
  console.log('       월급을 매분 전부 투자하는 것이 이 경제에서 가장 강하다. 무상증자와 월급 유입이 "주식을 들고 있는 것" 자체에');
  console.log('       보상을 주기 때문이다. 뉴스·추세 판단은 그 위에 얹히는 몇 %p 다. (판정에는 넣지 않는다 — README "밸런스에 관한 기록")');

  console.log('\n[시장 건강도]');
  console.log(`  매도 호가가 비는 시간   ${acc.noAsk.toFixed(1)}%   (30% 넘으면 floatCapitalRatio 를 올리거나 봇을 늘릴 것)`);
  console.log(`  매수 호가가 비는 시간   ${acc.noBid.toFixed(1)}%`);
  console.log(`  평균 주가 변동          ${((acc.px - 1) * 100).toFixed(1)}%   (마감 시 적정가 대비 ${acc.vsFair >= 0 ? '+' : ''}${acc.vsFair.toFixed(1)}%)`);
  console.log(`  종목 간 성과 격차       ${acc.disp.toFixed(1)}%   (작으면 어느 종목을 사도 똑같아 종목 선택이 무의미해진다)`);
  console.log(`  개장 공모 청약          ${acc.ipoSub.toFixed(2)}배   (1 미만이면 하한가(기준가)에 전량 배정, 1 이상이면 청약가 경쟁)`);
  console.log(`  총 체결 수량            ${acc.vol.toFixed(0)}주`);
  console.log(`  돌발뉴스                ${acc.newsCount.toFixed(1)}건 (호재 ${acc.newsPos.toFixed(1)} / 악재 ${(acc.newsCount - acc.newsPos).toFixed(1)})`);

  console.log('\n[판정]');
  for (const j of judge(M)) console.log(okLine(j));
  console.log('');
}

/** 여러 방 크기를 한 줄씩 요약 */
function matrix(sizes) {
  let failed = 0;
  for (const h of sizes) {
    const M = measure(h);
    const { acc } = M;
    const J = judge(M);
    const bad = J.filter(j => !j[0]);
    failed += bad.length;
    const r = (k) => acc[k].toFixed(1);
    console.log(`\n[사람 ${h} / 봇 ${BOTS}]  ${h}명 중 평균 등수 — 뉴스대응 ${r('news')} · 추격 ${r('fast')} · 보유 ${r('hold')} · 역추세 ${r('contra')} · 뒷북 ${r('slow')} · 무행동 ${r('idle')}   (참고: 전액투자 ${r('dca')})`);
    console.log(`  매도호가 공백 ${acc.noAsk.toFixed(0)}% · 매수 ${acc.noBid.toFixed(0)}% · 주가 ${((acc.px - 1) * 100).toFixed(1)}% · 종목격차 ${acc.disp.toFixed(1)}% · 공모청약 ${acc.ipoSub.toFixed(2)}배 · 뉴스 ${acc.newsCount.toFixed(0)}건`);
    const names = ['무행동 하위', '호가창', '종목격차', '뉴스>보유', '추격>보유', '추격>뒷북'];
    console.log('  ' + J.map(([c], i) => (c ? G + '✓' : R + '✗') + Z + names[i]).join('  '));
    for (const j of bad) console.log(`    ${R}✗${Z} ${j[2]}`);
  }
  console.log(failed ? `\n${R}${failed}개 판정 실패${Z} — 어느 방 크기에서 깨지는지 위를 볼 것\n`
                     : `\n${G}모든 방 크기에서 판정 통과${Z}\n`);
}

/** 뉴스에 늦게 반응할수록 얼마나 손해인지 — README 의 '선점 보상' 표를 다시 만든다 */
function curve(humans) {
  console.log(`\n[뉴스 반응 지연에 따른 손익]  사람 ${humans} / 봇 ${BOTS} / ${TRIALS}회 평균, 뉴스대응 군의 최종 수익률`);
  const base = measure(humans, 240);
  const late = base.acc.pnl_news;
  for (const sec of [0, 3, 10, 30, 60]) {
    const M = sec === 60 ? base : measure(humans, Math.max(1, sec * 4));
    const p = M.acc.pnl_news;
    console.log(`  ${String(sec).padStart(3)}초 뒤   수익률 ${p.toFixed(1).padStart(5)}%   (60초 뒤 대비 ${(p - late >= 0 ? '+' : '')}${(p - late).toFixed(1)}%p)   ${M.acc.news.toFixed(1)}등 / ${humans}명   보유 ${M.acc.pnl_hold.toFixed(1)}%`);
  }
  console.log('');
}

const header = `밸런스 측정 — 봇 ${BOTS} / ${NSTOCK}종목 / ${MINUTES}분 / ${TRIALS}회 평균`;
console.log('\n' + header);
if (Object.keys(overrides).length) console.log('설정 덮어쓰기:', JSON.stringify(overrides));

if (has('curve')) {
  curve(Number(arg('humans', 24)));
} else if (has('humans')) {
  const h = Number(arg('humans', 24));
  console.log(`사람 ${h}명`);
  report(measure(h));
} else {
  console.log('기본 실행은 사람 수 세 가지를 잰다. 한 구성만 자세히 보려면 --humans N, 지연 곡선은 --curve');
  matrix([8, 24, 48]);
}
