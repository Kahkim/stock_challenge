'use strict';
/**
 * 엔진 스모크 테스트 (외부 프레임워크 없이 동작).
 * 실행: node tests/engine.test.js
 *
 * 가장 중요한 건 보존 법칙이다. 오더북에서 주식이나 현금이 새로 생기거나 사라지면
 * 순위가 통째로 거짓이 된다.
 */
const assert = require('assert');
const { Game, PHASE, MM_ID } = require('../src/game');
const { roundToTick, PRESETS } = require('../src/config');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}

/** 모든 참가자가 보유 + 미체결에 묶어둔 주식의 총합. 시장조성자가 든 실권주는 아직 유통되지 않은 주식이라 뺀다 */
function totalShares(g, code) {
  let t = 0;
  for (const p of g.players.values()) if (!p.system) t += (p.holdings[code] || 0);
  const s = g.stockByCode.get(code);
  for (const o of s.book.asks) if (!g.isSystemOrder(o)) t += o.qty;     // 매도 예약분
  return t;
}
function totalCash(g) {
  let t = 0;
  for (const p of g.players.values()) t += p.cash;
  for (const s of g.stocks) for (const o of s.book.bids) t += g._buyReserve(o.price, o.qty);
  return t;
}

function buildGame(over = {}, seed = 7) {
  const g = new Game({
    stockCodes: ['SEC', 'SKH', 'LGE', 'HMC'],
    botCount: 24, ipoSec: 10, durationMin: 3, tickMs: 250, ...over,
  }, seed);
  for (let i = 0; i < 6; i++) g.addPlayer('사람' + (i + 1));
  g.start();
  return g;
}
function runTicks(g, n) { for (let i = 0; i < n; i++) g.tick(); }

console.log('\n[엔진 스모크 테스트]');

test('방 생성 시 시가총액이 종목별로 균등하다 (저가주 유리 방지)', () => {
  const g = buildGame();
  const caps = g.stocks.map(s => s.initialPrice * s.float);
  const max = Math.max(...caps), min = Math.min(...caps);
  assert.ok((max - min) / max < 0.02, `시총 편차 ${(max / min).toFixed(3)}배`);
});

test('개장 공모가 끝나면 거래 단계로 넘어가고 시초가가 정해진다', () => {
  const g = buildGame();
  assert.strictEqual(g.phase, PHASE.IPO);
  runTicks(g, 45);                        // 10초 = 40틱 + 여유
  assert.strictEqual(g.phase, PHASE.TRADING);
  for (const s of g.stocks) {
    assert.ok(s.issued > 0, `${s.name} 공모 배정 0주`);
    assert.ok(s.last > 0);
  }
});

test('공모 배정 주식 총량이 발행량과 정확히 일치한다', () => {
  const g = buildGame();
  runTicks(g, 45);
  for (const s of g.stocks) {
    assert.strictEqual(totalShares(g, s.code), s.issued,
      `${s.name}: 보유합 ${totalShares(g, s.code)} vs 발행 ${s.issued}`);
  }
});

test('거래를 오래 돌려도 보유 주식 합계가 발행 장부와 일치한다', () => {
  // 무상증자로 발행량 자체는 늘어난다. 검증할 것은 "거래가 주식을 만들어내거나 없애지 않는다"는 것.
  const g = buildGame();
  runTicks(g, 45);
  runTicks(g, 600);
  for (const s of g.stocks) {
    assert.strictEqual(totalShares(g, s.code), s.issued,
      `${s.name}: 보유합 ${totalShares(g, s.code)} != 발행 ${s.issued}`);
  }
});

test('무상증자를 끄면 발행 주식 수가 전혀 변하지 않는다', () => {
  // 시장조성자는 실권주를 장중에 팔아 유통량을 늘리므로 여기서는 끈다 — 보는 것은 '거래가 주식을 만들지 않는다'다
  const g = buildGame({ bonusShares: false, marketMaker: { enabled: false } });
  runTicks(g, 45);
  const before = g.stocks.map(s => s.issued);
  runTicks(g, 600);
  g.stocks.forEach((s, i) => {
    assert.strictEqual(s.issued, before[i], `${s.name} 발행량이 변함`);
    assert.strictEqual(totalShares(g, s.code), before[i], `${s.name} 보유합 불일치`);
  });
});

test('무상증자는 주식을 가진 사람에게만 배정된다 (무행동자는 0주)', () => {
  const g = new Game({ stockCodes: ['SEC', 'SKH'], botCount: 10, ipoSec: 5,
                       durationMin: 5, tickMs: 250, salaryIntervalSec: 15, maxBonusRate: 0.05 }, 3);
  const idle = g.addPlayer('무행동').id;
  const act = g.addPlayer('적극').id;
  g.start();
  for (const s of g.stocks) g.submitIpoBid(act, s.code, Math.round(s.initialPrice * 1.2), 200);
  runTicks(g, 25);
  const idleP = g.players.get(idle), actP = g.players.get(act);
  const idleBefore = g.stocks.reduce((a, s) => a + (idleP.holdings[s.code] || 0), 0);
  const actBefore = g.stocks.reduce((a, s) => a + (actP.holdings[s.code] || 0), 0);
  runTicks(g, 4 * 80);
  const idleAfter = g.stocks.reduce((a, s) => a + (idleP.holdings[s.code] || 0), 0);
  const actAfter = g.stocks.reduce((a, s) => a + (actP.holdings[s.code] || 0), 0);
  assert.strictEqual(idleBefore, 0, '무행동자가 공모에서 주식을 받음');
  assert.strictEqual(idleAfter, 0, `무행동자가 증자로 ${idleAfter}주를 받음 — 그러면 안 된다`);
  assert.ok(actAfter > actBefore, `보유자에게 증자 배정이 안 됨 (${actBefore} -> ${actAfter})`);
});

test('현금은 수수료와 공모대금 말고는 새로 생기지 않는다', () => {
  const g = buildGame({ salaryAmount: 0 });
  const seedTotal = g.players.size * g.cfg.seedMoney;
  runTicks(g, 45);
  const afterIpo = totalCash(g);
  assert.ok(afterIpo <= seedTotal + 1, `공모 후 현금 ${afterIpo} > 시드 ${seedTotal}`);
  runTicks(g, 600);
  assert.ok(totalCash(g) <= afterIpo + 1, '거래 중 현금이 늘어남(수수료는 차감만 되어야 함)');
});

test('현금·보유주식이 음수가 되지 않는다', () => {
  const g = buildGame();
  runTicks(g, 700);
  for (const p of g.players.values()) {
    assert.ok(p.cash >= -1, `${p.name} 현금 ${p.cash}`);
    for (const s of g.stocks) assert.ok((p.holdings[s.code] || 0) >= 0, `${p.name} ${s.code} 음수 보유`);
  }
});

test('월급이 정해진 주기대로 전원에게 지급된다', () => {
  const g = buildGame({ ipoSec: 0, salaryIntervalSec: 10, salaryAmount: 500000, botCount: 4 });
  runTicks(g, 4 * 35);                    // 35초 -> 3회 지급
  for (const p of g.players.values()) assert.strictEqual(p.salaryTotal, 1500000);
});

test('인플레이션이 적정가를 실제로 끌어올린다', () => {
  // 돌발뉴스는 적정가를 점프시키므로 인플레만 따로 보려면 꺼야 한다
  const g = buildGame({ ipoSec: 0, inflationPerMin: 0.05, idioVolatility: 0, durationMin: 10,
                        news: { enabled: false } });
  const f0 = g.stocks.map(s => s.fair);
  runTicks(g, 4 * 60);                    // 1분
  g.stocks.forEach((s, i) => {
    const grow = s.fair / f0[i];
    assert.ok(Math.abs(grow - 1.05) < 0.005, `적정가 상승률 ${grow.toFixed(4)} (기대 1.05)`);
  });
});

test('인플레이션은 적정가만 움직이고 체결가는 시장 수급이 정한다', () => {
  // 인플레율을 0 과 10%/분으로 두 판 돌려 비교한다.
  //
  // 적정가가 오르는 것이 실제 체결가로 전달되는 통로는 value 봇 하나뿐이고 기본 비중이 2%라,
  // 인플레율을 아무리 올려도 체결가는 거의 그대로다. 실측으로 확인한 한계이지 의도한 설계는 아니다.
  // 나중에 전달 경로를 손볼 일이 생기면 이 테스트가 먼저 깨져서 알려줄 것이다.
  const measure = (infl) => {
    const g = new Game({ stockCodes: ['SEC','SKH','LGE','HMC'], botCount: 40, ipoSec: 10,
                         durationMin: 8, tickMs: 250, inflationPerMin: infl,
                         idioVolatility: 0, news: { enabled: false } }, 31);
    for (let i = 0; i < 6; i++) g.addPlayer('P' + i);
    g.start();
    runTicks(g, 45);
    const open = g.stocks.map(s => s.last);
    const fair0 = g.stocks.map(s => s.fair);
    runTicks(g, 4 * 480);
    return {
      price: g.stocks.reduce((a, s, i) => a + s.last / open[i], 0) / g.stocks.length,
      fair: g.stocks.reduce((a, s, i) => a + s.fair / fair0[i], 0) / g.stocks.length,
    };
  };
  const flat = measure(0), hot = measure(0.10);

  // 적정가는 인플레율만큼 확실히 갈라진다
  assert.ok(hot.fair > flat.fair * 1.5,
    `적정가가 안 갈라짐: 인플레0 ${flat.fair.toFixed(2)}배 vs 인플레10% ${hot.fair.toFixed(2)}배`);
  // 반면 체결가는 거의 같다 — 인플레가 가격을 만들지 않는다
  assert.ok(Math.abs(hot.price - flat.price) < 0.15,
    `체결가가 인플레율에 따라 크게 달라짐: ${flat.price.toFixed(2)}배 vs ${hot.price.toFixed(2)}배`);
});

test('개장 공모 청약이 많을수록 매도 호가가 두꺼워진다', () => {
  // 공모에서 현금이 주식으로 전환되어야 봇이 팔 물량을 갖는다.
  // 이게 부족하면 매도 호가가 나오는 족족 두꺼운 매수 호가에 먹혀서,
  // 사려는 사람은 살 물건이 없어 선점 경쟁 자체가 성립하지 않는다.
  const askDepth = (ratio) => {
    const g = new Game({ stockCodes: ['SEC','SKH','LGE','HMC'], botCount: 40, ipoSec: 10,
                         durationMin: 8, tickMs: 250, ipoBidRatio: ratio }, 41);
    for (let i = 0; i < 6; i++) g.addPlayer('P' + i);
    g.start();
    runTicks(g, 45 + 4 * 200);
    let ask = 0, n = 0;
    for (let i = 0; i < 4 * 120; i++) {
      g.tick();
      if (i % 20) continue;
      for (const s of g.stocks) { n++; ask += s.book.asks.reduce((a, o) => a + o.price * o.qty, 0); }
    }
    return ask / Math.max(1, n);
  };
  const thin = askDepth(0.05), thick = askDepth(0.30);
  assert.ok(thick > thin * 1.5,
    `공모 비중을 6배로 올렸는데 매도 호가가 ${Math.round(thin)} -> ${Math.round(thick)} 밖에 안 늘었다`);
});

test('호가 제시형 봇이 여러 단계에 걸쳐 호가를 깐다', () => {
  const levelsOf = (makerLevels) => {
    const g = new Game({ stockCodes: ['SEC','SKH'], botCount: 30, ipoSec: 10, durationMin: 8,
                         tickMs: 250, makerLevels,
                         botMix: { trend: 0.2, maker: 0.8, noise: 0, contra: 0, value: 0 } }, 51);
    g.addPlayer('t'); g.start();
    runTicks(g, 45 + 4 * 120);
    // 서로 다른 가격대가 몇 개나 깔려 있는지 (양쪽 합산 최대치)
    let best = 0;
    for (const s of g.stocks) {
      best = Math.max(best, new Set(s.book.asks.map(o => o.price)).size,
                            new Set(s.book.bids.map(o => o.price)).size);
    }
    return best;
  };
  assert.ok(levelsOf(4) > levelsOf(1),
    `사다리 4단계가 1단계보다 호가 단계가 많아야 한다 (${levelsOf(1)} -> ${levelsOf(4)})`);
});

test('시장가 주문이 호가를 긁으며 즉시 체결된다', () => {
  const g = buildGame();
  runTicks(g, 60);
  const s = g.stocks[0];
  const me = g.humans()[0];
  me.cash = 50_000_000;
  if (s.book.bestAsk() === null) {
    // 매도 호가가 비어 있으면(전원 순매수 국면) 다른 참가자에게 물량을 쥐여 주고 팔게 한다
    const other = [...g.players.values()].find(p => p.id !== me.id);
    other.holdings[s.code] = (other.holdings[s.code] || 0) + 500;
    g.submitOrder(other.id, s.code, 'sell', Math.round(s.last * 1.05), 200);
  }
  assert.ok(s.book.bestAsk() !== null, '매도 호가 준비 실패');
  const before = me.holdings[s.code] || 0;
  const r = g.submitOrder(me.id, s.code, 'buy', 'market', 50);
  assert.ok(r.filled > 0, '시장가인데 체결이 0');
  assert.ok((me.holdings[s.code] || 0) > before);
});

test('주문 취소 시 예약된 현금이 정확히 환불된다', () => {
  const g = buildGame();
  runTicks(g, 45);
  const me = g.humans()[0];
  const s = g.stocks[0];
  const cash0 = me.cash;
  const r = g.submitOrder(me.id, s.code, 'buy', Math.max(5, Math.round(s.last * 0.5)), 100);
  assert.ok(r.resting === 100, '체결되면 안 되는 저가 주문이 체결됨');
  assert.ok(me.cash < cash0, '예약이 안 됨');
  g.cancelOrder(me.id, s.code, r.orderId);
  assert.strictEqual(me.cash, cash0, `환불 불일치 ${me.cash} != ${cash0}`);
});

test('보유 주식보다 많이 팔 수 없다', () => {
  const g = buildGame();
  runTicks(g, 45);
  const me = g.humans()[0];
  const s = g.stocks[0];
  assert.throws(() => g.submitOrder(me.id, s.code, 'sell', s.last, (me.holdings[s.code] || 0) + 1000));
});

test('최소 거래 단위(lotSize) 미만 주문은 거부된다', () => {
  const g = buildGame({ lotSize: 10 });
  runTicks(g, 45);
  const me = g.humans()[0];
  assert.throws(() => g.submitOrder(me.id, g.stocks[0].code, 'buy', g.stocks[0].last, 5));
});

test('마감되면 미체결 주문이 모두 취소되고 예약분이 반환된다', () => {
  const g = buildGame({ durationMin: 1 });
  runTicks(g, 45 + 4 * 70);
  assert.strictEqual(g.phase, PHASE.ENDED);
  for (const s of g.stocks) {
    assert.strictEqual(s.book.bids.length, 0);
    assert.strictEqual(s.book.asks.length, 0);
    assert.strictEqual(totalShares(g, s.code), s.issued, `${s.name} 마감 후 주식 총량 불일치`);
  }
});

test('순위표가 총자산 내림차순으로 정렬되고 봇을 제외할 수 있다', () => {
  const g = buildGame();
  runTicks(g, 300);
  const human = g.ranking(false);
  assert.strictEqual(human.length, 6);
  assert.ok(human.every(r => !r.isBot));
  for (let i = 1; i < human.length; i++) assert.ok(human[i - 1].nav >= human[i].nav);
  assert.strictEqual(g.ranking(true).length, g.participants().length);   // 시장조성자는 순위에 없다
});

test('아무것도 안 한 사람은 하위권으로 밀린다', () => {
  // 사람 12명 중 6명은 완전 무행동(공모도 거래도 안 함), 6명은 공모+매수
  const g = new Game({ stockCodes: ['SEC','SKH','LGE','HMC'], botCount: 40,
                       ipoSec: 10, durationMin: 8, tickMs: 250 }, 11);
  const idle = [], act = [];
  for (let i = 0; i < 6; i++) idle.push(g.addPlayer('무행동' + i).id);
  for (let i = 0; i < 6; i++) act.push(g.addPlayer('적극' + i).id);
  g.start();
  for (const id of act) for (const s of g.stocks) {
    try { g.submitIpoBid(id, s.code, Math.round(s.initialPrice * 1.1), 200); } catch (_) {}
  }
  runTicks(g, 45);
  for (let i = 0; i < 4 * 480; i++) {
    g.tick();
    if (i % 200 === 0) for (const id of act) {
      const s = g.stocks[i % g.stocks.length];
      try { g.submitOrder(id, s.code, 'buy', Math.round(s.last * 1.01), 50); } catch (_) {}
    }
  }
  const rank = g.ranking(false);
  const pos = (id) => rank.find(r => r.id === id).rank;
  const idleAvg = idle.reduce((a, id) => a + pos(id), 0) / idle.length;
  const actAvg = act.reduce((a, id) => a + pos(id), 0) / act.length;
  assert.ok(idleAvg > actAvg,
    `무행동 평균 ${idleAvg.toFixed(1)}등 vs 적극 ${actAvg.toFixed(1)}등 — 가만히 있는 게 불리하지 않다`);
});


test('시장가 주문은 잔량이 호가에 남지 않는다 (IOC)', () => {
  const g = buildGame();
  runTicks(g, 60);
  const s = g.stocks[0];
  const me = g.humans()[0];
  me.cash = 500_000_000;
  const other = [...g.players.values()].find(p => p.id !== me.id);
  // 매도 물량을 소량만 깔아두고, 그보다 훨씬 큰 시장가 매수를 낸다
  other.holdings[s.code] = (other.holdings[s.code] || 0) + 1000;
  const asksBefore = s.book.asks.length;
  g.submitOrder(other.id, s.code, 'sell', Math.round(s.last * 1.5), 20);
  const bidsBefore = s.book.bids.length;
  const r = g.submitOrder(me.id, s.code, 'buy', 'market', 2000);
  assert.ok(r.filled > 0, '시장가인데 체결 0');
  assert.strictEqual(r.resting, 0, `시장가 잔량 ${r.resting}주가 호가에 남음`);
  assert.strictEqual(s.book.bids.length, bidsBefore, '시장가 매수 잔량이 매수호가에 남음');
  assert.ok(asksBefore >= 0);
});

test('시장가 주문 후 예약 현금이 남김없이 환불된다', () => {
  const g = buildGame();
  runTicks(g, 60);
  const s = g.stocks[0];
  const me = g.humans()[0];
  const other = [...g.players.values()].find(p => p.id !== me.id);
  other.holdings[s.code] = (other.holdings[s.code] || 0) + 500;
  g.submitOrder(other.id, s.code, 'sell', Math.round(s.last * 1.2), 50);
  me.cash = 100_000_000;
  const before = me.cash;
  const r = g.submitOrder(me.id, s.code, 'buy', 'market', 3000);
  // 체결된 만큼만 빠져나가야 한다 (잔량 예약이 남아 있으면 안 된다)
  const paid = before - me.cash;
  const maxPaid = r.filled * s.last * 1.35;
  assert.ok(paid <= maxPaid, `체결 ${r.filled}주에 ${paid}원 지출 — 잔량 예약이 안 풀렸다`);
});

test('호가에 자기 주문만 있으면 시장가가 명확한 오류를 낸다', () => {
  const g = buildGame({ botCount: 0, ipoSec: 0 });
  const me = g.humans()[0];
  const s = g.stocks[0];
  g.submitOrder(me.id, s.code, 'buy', Math.round(s.last * 0.9), 100);
  assert.ok(s.book.bestBid() !== null);
  me.holdings[s.code] = 500;
  try {
    g.submitOrder(me.id, s.code, 'sell', 'market', 100);
    assert.fail('오류가 나야 한다');
  } catch (e) {
    assert.strictEqual(e.code, 'NO_COUNTERPARTY');
  }
  assert.strictEqual(me.holdings[s.code], 500, '실패한 시장가 매도가 주식을 묶어둠');
});


test('돌발뉴스가 발생하고 호재/악재가 대체로 균형을 이룬다', () => {
  let pos = 0, neg = 0, total = 0;
  for (let seed = 0; seed < 8; seed++) {
    const g = new Game({ stockCodes: ['SEC','SKH','LGE','HMC','NVR','KKO'], botCount: 20,
                         ipoSec: 5, durationMin: 15, tickMs: 250 }, seed + 55);
    for (let i = 0; i < 6; i++) g.addPlayer('P' + i);
    g.start();
    runTicks(g, 25 + 4 * 900);
    total += g.newsLog.length;
    pos += g.newsLog.filter(n => n.sign > 0).length;
    neg += g.newsLog.filter(n => n.sign < 0).length;
  }
  assert.ok(total >= 8 * 6, `15분에 뉴스가 평균 ${(total / 8).toFixed(1)}건뿐`);
  const ratio = pos / (pos + neg);
  assert.ok(ratio > 0.3 && ratio < 0.7, `호재 비율 ${(ratio * 100).toFixed(0)}% — 한쪽으로 쏠렸다`);
});

test('뉴스가 적정가를 즉시 점프시킨다', () => {
  const g = new Game({ stockCodes: ['SEC','SKH','LGE','HMC'], botCount: 20, ipoSec: 0,
                       durationMin: 15, tickMs: 250, inflationPerMin: 0, idioVolatility: 0 }, 91);
  g.addPlayer('t'); g.start();
  const seen = new Set();
  let checked = 0;
  for (let i = 0; i < 4 * 900 && checked < 3; i++) {
    const before = new Map(g.stocks.map(s => [s.code, s.fair]));
    g.tick();
    for (const n of g.news) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const s = g.stockByCode.get(n.code);
      const moved = s.fair / before.get(n.code) - 1;
      assert.ok(Math.sign(moved) === n.sign, `${n.sign > 0 ? '호재' : '악재'}인데 적정가가 ${(moved * 100).toFixed(1)}% 움직임`);
      assert.ok(Math.abs(moved) > 0.01, `적정가 변화가 ${(moved * 100).toFixed(2)}% 로 너무 작다`);
      checked++;
    }
  }
  assert.ok(checked >= 1, '뉴스가 한 건도 발생하지 않았다');
});

test('봇이 뉴스에 한꺼번에 반응하지 않고 시차를 두고 동조한다', () => {
  const News = require('../src/news');
  const g = buildGame();
  const bots = [...g.players.values()].filter(p => p.isBot).slice(0, 20);
  const fake = { id: 'nx', code: 'SEC', sign: 1, strength: 0.06, tick: 100,
                 lifeTicks: 360, reactionTicks: 160 };
  let reactingAt110 = 0, reactingAt250 = 0;
  for (const b of bots) {
    if (News.reactionFor(b, fake, 110, g.rnd) !== 0) reactingAt110++;
    if (News.reactionFor(b, fake, 250, g.rnd) !== 0) reactingAt250++;
  }
  assert.ok(reactingAt110 < bots.length, '뉴스 직후 전원이 즉시 반응한다 — 사람이 먼저 진입할 틈이 없다');
  assert.ok(reactingAt250 > reactingAt110, '시간이 지나도 동조가 번지지 않는다');
});

test('뉴스를 끄면 뉴스가 한 건도 발생하지 않는다', () => {
  const g = buildGame({ news: { enabled: false } });
  runTicks(g, 45 + 4 * 600);
  assert.strictEqual(g.newsLog.length, 0);
  assert.strictEqual(g.news.length, 0);
});

test('화면이 계산한 최대 수량으로 시장가 매수해도 거부되지 않고 현금 안에서 체결된다', () => {
  // 화면의 '최대' 는 tradable.maxBuyQty(현재가 기준)다. 시장가 예약금을 최우선 매도호가의
  // 1.30배로 잡으면 이 수량이 통째로 거부됐다 — 막 사는 사람이 가장 많이 누르는 버튼이다.
  const g = buildGame({ botCount: 30 });
  runTicks(g, 45 + 400);                       // 봇 호가가 깔릴 시간
  const id = [...g.players.values()].find(p => !p.isBot).id;
  const s = g.stocks.find(x => x.book.bestAsk() !== null);
  assert.ok(s, '매도 호가가 있는 종목이 있어야 한다');
  const p = g.players.get(id);
  const cashBefore = p.cash;
  const t = g.playerView(id, 0).tradable.find(x => x.code === s.code);
  assert.ok(t.maxBuyQty >= g.cfg.lotSize, '살 수 있는 수량이 있어야 한다');

  const r = g.submitOrder(id, s.code, 'buy', 'market', t.maxBuyQty);
  assert.ok(r.filled > 0, '최대 수량 시장가가 한 주도 체결되지 않았다');
  assert.ok(p.cash >= 0, `현금이 음수가 됐다: ${p.cash}`);
  assert.ok(p.cash < cashBefore, '현금이 줄지 않았다');
  assert.strictEqual(r.resting, 0, '시장가는 남는 수량이 없어야 한다(IOC)');
});

test('현금보다 많은 수량을 시장가로 내면 거부하지 않고 살 수 있는 만큼만 산다', () => {
  const g = buildGame({ botCount: 30 });
  runTicks(g, 45 + 400);
  const id = [...g.players.values()].find(p => !p.isBot).id;
  const s = g.stocks.find(x => x.book.bestAsk() !== null);
  const p = g.players.get(id);
  const ask = s.book.bestAsk();
  const canAtBest = Math.floor(p.cash / (ask * (1 + g.cfg.feeRate)) / g.cfg.lotSize) * g.cfg.lotSize;
  const r = g.submitOrder(id, s.code, 'buy', 'market', canAtBest + g.cfg.lotSize * 10);
  assert.ok(r.filled > 0, '한 주도 체결되지 않았다');
  assert.ok(r.filled <= canAtBest, `최우선 매도호가 기준 한도(${canAtBest})를 넘겨 샀다: ${r.filled}`);
  assert.ok(p.cash >= 0, `현금이 음수가 됐다: ${p.cash}`);
});

test('한 단위도 못 살 만큼 현금이 없으면 시장가 매수는 거부된다', () => {
  const g = buildGame({ botCount: 30 });
  runTicks(g, 45 + 400);
  const id = [...g.players.values()].find(p => !p.isBot).id;
  const s = g.stocks.find(x => x.book.bestAsk() !== null);
  g.players.get(id).cash = s.book.bestAsk() * g.cfg.lotSize - 1;    // 10주 값에서 1원 모자라게
  assert.throws(() => g.submitOrder(id, s.code, 'buy', 'market', g.cfg.lotSize), e => e.code === 'INSUFFICIENT_CASH');
});

test('화면의 maxBuyQty 는 최우선 매도호가 기준이라 그대로 시장가로 내도 전량 체결을 시도한다', () => {
  const g = buildGame({ botCount: 30 });
  runTicks(g, 45 + 400);
  const id = [...g.players.values()].find(p => !p.isBot).id;
  const s = g.stocks.find(x => x.book.bestAsk() !== null);
  const p = g.players.get(id);
  const t = g.playerView(id, 0).tradable.find(x => x.code === s.code);
  const ask = s.book.bestAsk();
  assert.ok(t.maxBuyQty * ask * (1 + g.cfg.feeRate) <= p.cash, 'maxBuyQty 가 최우선 매도호가로도 살 수 없는 수량이다');
});

test('공모 미달이어도 최저 청약가가 아니라 기준가(하한)로 배정된다', () => {
  // 하한이 없으면 수요가 물량에 못 미칠 때 "가장 낮은 청약가"가 공모가가 되어,
  // 누가 10주를 5원에 써내는 순간 전원이 5원에 배정받는다.
  const g = new Game({ stockCodes: ['SEC', 'SKH'], botCount: 4, ipoSec: 5, durationMin: 1,
                       tickMs: 250, floatCapitalRatio: 3 }, 5);          // 발행을 넉넉히 → 확실한 미달
  const fair = g.addPlayer('정상').id, low = g.addPlayer('저가').id;
  g.start();
  const s = g.stocks[0];
  g.submitIpoBid(fair, s.code, Math.round(s.initialPrice * 1.1), 100);
  g.submitIpoBid(low, s.code, 5, 10);
  runTicks(g, 25);
  assert.strictEqual(g.phase, PHASE.TRADING);
  assert.strictEqual(s.ipoPrice, s.initialPrice, `공모가 ${s.ipoPrice} — 기준가 ${s.initialPrice} 가 하한이어야 한다`);
  assert.strictEqual(g.players.get(fair).holdings[s.code], 100, '정상 청약이 전량 배정되지 않음');
  assert.strictEqual(g.players.get(fair).cash, 1_000_000 - s.initialPrice * 100, '기준가로 정산되지 않음');
  assert.strictEqual(g.players.get(low).holdings[s.code] || 0, 0, '하한 미만 청약이 배정됨');
  assert.strictEqual(g.players.get(low).cash, 1_000_000, '하한 미만 청약 증거금이 환급되지 않음');
});

test('공모 초과 청약이면 공모가는 하한 위에서 청약가 경쟁으로 정해진다', () => {
  const g = new Game({ stockCodes: ['SEC'], botCount: 0, ipoSec: 5, durationMin: 1,
                       tickMs: 250, floatCapitalRatio: 0.05 }, 5);       // 발행을 아주 적게 → 확실한 초과
  const a = g.addPlayer('A').id, b = g.addPlayer('B').id;
  g.start();
  const s = g.stocks[0];
  const hi = Math.round(s.initialPrice * 1.3), lo = Math.round(s.initialPrice * 1.1);
  g.submitIpoBid(a, s.code, hi, s.float);          // 혼자서 발행량을 다 가져간다
  g.submitIpoBid(b, s.code, lo, s.float);
  runTicks(g, 25);
  assert.strictEqual(s.ipoPrice, hi, `공모가 ${s.ipoPrice} — 물량이 소진되는 청약가 ${hi} 여야 한다`);
  assert.strictEqual(g.players.get(a).holdings[s.code], s.float);
  assert.strictEqual(g.players.get(b).holdings[s.code] || 0, 0, '낮은 청약가가 배정됨');
  assert.strictEqual(g.players.get(b).cash, 1_000_000, '미배정 증거금이 환급되지 않음');
});

console.log('\n[시초가 프리미엄 · 시장조성자]');

test('시초가는 공모가가 아니라 적정가(기준가 + 프리미엄)에서 열린다', () => {
  const g = new Game({ stockCodes: ['SEC', 'SKH'], botCount: 4, ipoSec: 5, durationMin: 1,
                       tickMs: 250, ...PRESETS.marketMaker }, 5);
  const who = g.addPlayer('청약자').id;
  g.start();
  const s = g.stocks[0];
  g.submitIpoBid(who, s.code, s.initialPrice, 100);
  runTicks(g, 25);
  assert.strictEqual(g.phase, PHASE.TRADING);
  assert.strictEqual(s.ipoPrice, s.initialPrice, `공모가 ${s.ipoPrice} — 미달이면 기준가(하한)여야 한다`);
  assert.strictEqual(s.open, roundToTick(s.initialPrice * 1.30), `시초가 ${s.open} — 적정가(기준가 +30%)여야 한다`);
  const p = g.players.get(who);
  assert.strictEqual(p.holdings[s.code], 100);
  // 공모 참여자는 개장 순간 프리미엄만큼 평가익을 얻는다 (평가는 체결가 기준이라 시초가 = 첫 체결 전 last)
  assert.ok(g.nav(p) > 1_000_000, `개장 직후 평가액 ${g.nav(p)} — 공모 참여자는 프리미엄을 얻어야 한다`);
});

test('시장조성자는 실권주를 들고 양방향 호가를 대며, 순위·월급·참가자 수에서는 빠진다', () => {
  const g = buildGame({ salaryIntervalSec: 15, ...PRESETS.marketMaker });
  runTicks(g, 45);
  const mm = g.players.get(MM_ID);
  assert.ok(mm && mm.system, '시장조성자가 없다');
  assert.ok(g.stocks.every(s => (mm.holdings[s.code] || 0) + s.book.asks.filter(o => o.owner === MM_ID).reduce((a, o) => a + o.qty, 0) > 0),
    '실권주를 넘겨받지 않았다');
  // 실권주를 들고 있는 동안 매도 호가는 늘 있어야 한다. 매수 호가는 판 대금이 재원이라 팔고 난 뒤부터 생긴다.
  let asked = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    g.tick(); n++;
    if (g.stocks.every(s => s.book.asks.some(o => o.owner === MM_ID))) asked++;
  }
  assert.ok(asked / n > 0.95, `시장조성자 매도 호가가 있는 틱 ${(asked / n * 100).toFixed(0)}% — 호가를 대지 않는다`);
  assert.ok(mm.cash > 0, '실권주를 한 주도 못 팔았다');
  assert.ok(g.stocks.some(s => s.book.bids.some(o => o.owner === MM_ID)), '판 대금으로 매수 호가를 대지 않는다');
  assert.ok(g.ranking(true).every(r => r.id !== MM_ID), '시장조성자가 순위에 들어 있다');
  assert.strictEqual(mm.salaryTotal, 0, '시장조성자가 월급을 받았다');
  assert.strictEqual(g.snapshot().playerCount, g.players.size - 1, '참가자 수에 시장조성자가 들어 있다');
  // 판 실권주만큼만 유통량이 늘고, 장부는 참가자 보유 + 참가자 매도 예약과 맞는다
  for (const s of g.stocks) assert.strictEqual(totalShares(g, s.code), s.issued, `${s.name} 유통량 장부가 어긋난다`);
});

test('시장조성자는 기본으로 꺼져 있다 — 시스템 참가자가 없고 유통량은 공모 배정량 그대로다', () => {
  const g = buildGame({ bonusShares: false });
  runTicks(g, 45);
  assert.ok(!g.players.has(MM_ID), '기본값(끔)인데 시장조성자가 생겼다');
  const before = g.stocks.map(s => s.issued);
  runTicks(g, 300);
  g.stocks.forEach((s, i) => assert.strictEqual(s.issued, before[i]));
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
