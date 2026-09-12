'use strict';
/**
 * 엔진 스모크 테스트 (외부 프레임워크 없이 동작).
 * 실행: node tests/engine.test.js
 *
 * 가장 중요한 건 보존 법칙이다. 오더북에서 주식이나 현금이 새로 생기거나 사라지면
 * 순위가 통째로 거짓이 된다.
 */
const assert = require('assert');
const { Game, PHASE } = require('../src/game');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}

/** 모든 참가자가 보유 + 미체결에 묶어둔 주식의 총합 */
function totalShares(g, code) {
  let t = 0;
  for (const p of g.players.values()) t += (p.holdings[code] || 0);
  const s = g.stockByCode.get(code);
  for (const o of s.book.asks) t += o.qty;     // 매도 예약분
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
    stockCodes: ['SNU', 'YON', 'KOR', 'HYU'],
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
  const g = buildGame({ bonusShares: false });
  runTicks(g, 45);
  const before = g.stocks.map(s => s.issued);
  runTicks(g, 600);
  g.stocks.forEach((s, i) => {
    assert.strictEqual(s.issued, before[i], `${s.name} 발행량이 변함`);
    assert.strictEqual(totalShares(g, s.code), before[i], `${s.name} 보유합 불일치`);
  });
});

test('무상증자는 주식을 가진 사람에게만 배정된다 (무행동자는 0주)', () => {
  const g = new Game({ stockCodes: ['SNU', 'YON'], botCount: 10, ipoSec: 5,
                       durationMin: 5, tickMs: 250, salaryIntervalSec: 15 }, 3);
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
  const g = buildGame({ ipoSec: 0, inflationPerMin: 0.05, idioVolatility: 0, durationMin: 10 });
  const f0 = g.stocks.map(s => s.fair);
  runTicks(g, 4 * 60);                    // 1분
  g.stocks.forEach((s, i) => {
    const grow = s.fair / f0[i];
    assert.ok(Math.abs(grow - 1.05) < 0.005, `적정가 상승률 ${grow.toFixed(4)} (기대 1.05)`);
  });
});

test('인플레이션이 봇을 통해 실제 체결가까지 전달된다', () => {
  const g = buildGame({ durationMin: 6, inflationPerMin: 0.08, idioVolatility: 0.05, botCount: 40 });
  runTicks(g, 45);
  const open = g.stocks.map(s => s.last);
  runTicks(g, 4 * 240);
  const ups = g.stocks.filter((s, i) => s.last > open[i]).length;
  assert.ok(ups >= Math.ceil(g.stocks.length / 2),
    `인플레 8%/분인데 오른 종목이 ${ups}/${g.stocks.length}개뿐`);
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
  assert.strictEqual(g.ranking(true).length, g.players.size);
});

test('아무것도 안 한 사람은 하위권으로 밀린다', () => {
  // 사람 12명 중 6명은 완전 무행동(공모도 거래도 안 함), 6명은 공모+매수
  const g = new Game({ stockCodes: ['SNU','YON','KOR','HYU'], botCount: 40,
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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
