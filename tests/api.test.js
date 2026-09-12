'use strict';
/**
 * API 엔드투엔드 테스트. 실제로 서버를 띄워 HTTP 로 호출한다.
 * 실행: node tests/api.test.js
 */
const assert = require('assert');
// 방이 스스로 틱을 돌리지 않게 해서, 진행을 테스트가 전적으로 통제하도록 만든다.
// server 를 require 하기 전에 켜야 한다.
process.env.NO_AUTO_TICK = '1';
const { server, store } = require('../server');

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; results.push('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}

let BASE;
const J = async (method, p, body, headers) => {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
};
/**
 * 방의 게임을 실시간 대기 없이 앞으로 감는다.
 *
 * 방은 자기 setInterval 로도 틱을 돌린다. 그게 켜져 있으면 테스트가 수동으로 감는 것과
 * 경합해서 결과가 매번 달라진다(실제로 5회 중 3회가 서로 다른 지점에서 실패했다).
 * 그래서 첫 호출 때 방 타이머를 끄고, 이후로는 테스트가 진행을 전적으로 통제한다.
 */
const fastForward = (code, n) => {
  const room = store.get(code);
  for (let i = 0; i < n; i++) room.game.tick();
  return room;
};

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('\n[API 엔드투엔드 테스트] ' + BASE);

  let roomCode, hostToken, alice, bob;

  await test('GET /api/health 가 응답한다', async () => {
    const { status, data } = await J('GET', '/api/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.ok, true);
  });

  await test('GET /api/meta 가 종목 풀과 기본설정을 준다 (방 만들기 화면용)', async () => {
    const { status, data } = await J('GET', '/api/meta');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.stockPool.length, 10);
    assert.ok(data.defaults.botCount >= 0);
    assert.ok(data.botTypes.maker);
  });

  await test('POST /api/rooms 로 방을 만들면 참가코드와 방장토큰이 나온다', async () => {
    const { status, data } = await J('POST', '/api/rooms', {
      title: '동문회 챌린지',
      config: { stockCodes: ['SNU', 'YON', 'KOR', 'HYU'], botCount: 20, ipoSec: 3,
                durationMin: 2, tickMs: 100, salaryIntervalSec: 20, seed: 20260912 },
    });
    assert.strictEqual(status, 201);
    assert.match(data.roomCode, /^[A-Z2-9]{6}$/);
    assert.ok(data.hostToken);
    assert.strictEqual(data.config.botCount, 20);
    assert.strictEqual(data.config.stockCodes.length, 4);
    roomCode = data.roomCode; hostToken = data.hostToken;
  });

  await test('같은 시드로 방을 만들면 같은 판이 재현된다', async () => {
    const mk = async () => {
      const { data } = await J('POST', '/api/rooms', {
        config: { stockCodes: ['SNU', 'YON', 'KOR'], botCount: 12, ipoSec: 2,
                  durationMin: 2, tickMs: 100, seed: 777 },
      });
      await J('POST', `/api/rooms/${data.roomCode}/join`, { name: '재현' });
      await J('POST', `/api/rooms/${data.roomCode}/start`, {}, { 'X-Host-Token': data.hostToken });
      fastForward(data.roomCode, 300);
      const g = store.get(data.roomCode).game;
      return g.stocks.map(s => `${s.code}:${s.last}:${s.volume}`).join('|');
    };
    const a = await mk(), b = await mk();
    assert.strictEqual(a, b, `같은 시드인데 결과가 다르다\n  ${a}\n  ${b}`);
  });

  await test('방 만들 때 잘못된 값은 안전한 범위로 정리된다', async () => {
    const { data } = await J('POST', '/api/rooms', {
      config: { stockCodes: ['SNU', 'YON', '없는종목'], botCount: 99999,
                durationMin: -5, feeRate: 9, lotSize: 0 },
    });
    assert.strictEqual(data.config.stockCodes.length, 2);
    assert.strictEqual(data.config.botCount, 500);
    assert.strictEqual(data.config.durationMin, 1);
    assert.ok(data.config.feeRate <= 0.05);
    assert.ok(data.config.lotSize >= 1);
  });

  await test('종목을 1개만 고르면 거부된다', async () => {
    const { status, data } = await J('POST', '/api/rooms', { config: { stockCodes: ['SNU'] } });
    assert.strictEqual(status, 400);
    assert.strictEqual(data.error.code, 'TOO_FEW_STOCKS');
  });

  await test('참가코드로 입장하면 참가자 토큰이 발급된다', async () => {
    const a = await J('POST', `/api/rooms/${roomCode}/join`, { name: '앨리스' });
    const b = await J('POST', `/api/rooms/${roomCode}/join`, { name: '밥' });
    assert.strictEqual(a.status, 200);
    alice = a.data; bob = b.data;
    assert.ok(alice.playerToken && alice.playerId);
    assert.notStrictEqual(alice.playerToken, bob.playerToken);
  });

  await test('없는 참가코드는 404', async () => {
    const { status, data } = await J('POST', '/api/rooms/ZZZZZZ/join', { name: 'x' });
    assert.strictEqual(status, 404);
    assert.strictEqual(data.error.code, 'ROOM_NOT_FOUND');
  });

  await test('로비에서 참가자 명단이 보인다', async () => {
    const { data } = await J('GET', `/api/rooms/${roomCode}`);
    assert.strictEqual(data.humanCount, 2);
    assert.deepStrictEqual(data.players.map(p => p.name), ['앨리스', '밥']);
    assert.strictEqual(data.stocks.length, 4);
  });

  await test('로비 스트림에 참가자 명단이 실시간으로 실려 온다', async () => {
    const { data } = await J('GET', `/api/rooms/${roomCode}/state`);
    assert.strictEqual(data.snapshot.phase, 'lobby');
    assert.ok(Array.isArray(data.snapshot.players), '로비인데 참가자 명단이 없다');
    assert.deepStrictEqual(data.snapshot.players.map(p => p.name), ['앨리스', '밥']);
  });

  await test('시작 전에는 방장이 설정을 바꿀 수 있고 참가자 토큰은 그대로 유지된다', async () => {
    const r = await J('POST', `/api/rooms/${roomCode}/config`,
      { config: { botCount: 24, durationMin: 2 } }, { 'X-Host-Token': hostToken });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.config.botCount, 24);
    assert.deepStrictEqual(r.data.players.map(p => p.name), ['앨리스', '밥']);
    // 기존 토큰으로 계속 조회된다
    const me = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': alice.playerToken });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.data.name, '앨리스');
    alice.playerId = me.data.id;      // 방을 다시 만들었으므로 id 는 바뀐다
  });

  await test('방장이 아니면 설정을 바꿀 수 없다', async () => {
    const r = await J('POST', `/api/rooms/${roomCode}/config`, { config: { botCount: 1 } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.data.error.code, 'NOT_HOST');
  });

  await test('방장 토큰 없이는 시작할 수 없다', async () => {
    const { status, data } = await J('POST', `/api/rooms/${roomCode}/start`);
    assert.strictEqual(status, 403);
    assert.strictEqual(data.error.code, 'NOT_HOST');
  });

  await test('방장이 시작하면 공모 단계로 들어간다', async () => {
    const { status, data } = await J('POST', `/api/rooms/${roomCode}/start`, {}, { 'X-Host-Token': hostToken });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.phase, 'ipo');
    assert.ok(data.stocks.every(s => s.float > 0));
  });

  await test('공모 청약이 들어가고 증거금이 예치된다', async () => {
    const before = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': alice.playerToken });
    // 봇 추세형은 초기가의 최대 1.35배까지 지른다. 확실히 배정받으려면 그보다 높게.
    const r = await J('POST', `/api/rooms/${roomCode}/ipo-bids`,
      { code: 'SNU', price: 1800, qty: 200 }, { 'X-Player-Token': alice.playerToken });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.reserved, 1800 * 200);
    const after = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': alice.playerToken });
    assert.strictEqual(before.data.cash - after.data.cash, 1800 * 200);
  });

  await test('토큰이 틀리면 401', async () => {
    const { status, data } = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': 'garbage' });
    assert.strictEqual(status, 401);
    assert.strictEqual(data.error.code, 'INVALID_TOKEN');
  });

  await test('공모가 끝나면 거래 단계로 넘어가고 배정이 이루어진다', async () => {
    fastForward(roomCode, 40);                   // ipoSec 3 · tickMs 100 → 30틱이면 마감
    const { data } = await J('GET', `/api/rooms/${roomCode}/state`);
    assert.strictEqual(data.snapshot.phase, 'trading');
    const me = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': alice.playerToken });
    const snu = me.data.holdings.find(h => h.code === 'SNU');
    assert.ok(snu && snu.qty > 0, '공모 배정을 못 받음');
    assert.ok(snu.avgPrice > 0);
  });

  await test('지정가 매수 주문이 접수된다', async () => {
    const st = await J('GET', `/api/rooms/${roomCode}/state`);
    const s = st.data.snapshot.stocks.find(x => x.code === 'YON');
    const r = await J('POST', `/api/rooms/${roomCode}/orders`,
      { code: 'YON', side: 'buy', price: Math.round(s.last * 0.8), qty: 20 },
      { 'X-Player-Token': bob.playerToken });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.resting, 20, '체결되면 안 되는 저가 주문이 체결됨');
    assert.ok(r.data.orderId);
    bob.orderId = r.data.orderId;
  });

  await test('미체결 주문이 내 주문목록에 보이고 취소하면 사라진다', async () => {
    const me1 = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': bob.playerToken });
    assert.ok(me1.data.openOrders.some(o => o.id === bob.orderId));
    assert.ok(me1.data.lockedCash > 0);
    const c = await J('POST', `/api/rooms/${roomCode}/orders/cancel`,
      { code: 'YON', orderId: bob.orderId }, { 'X-Player-Token': bob.playerToken });
    assert.strictEqual(c.status, 200);
    const me2 = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': bob.playerToken });
    assert.ok(!me2.data.openOrders.some(o => o.id === bob.orderId));
  });

  await test('남의 주문은 취소할 수 없다', async () => {
    const st = await J('GET', `/api/rooms/${roomCode}/state`);
    const s = st.data.snapshot.stocks[0];
    const r = await J('POST', `/api/rooms/${roomCode}/orders`,
      { code: s.code, side: 'buy', price: Math.round(s.last * 0.7), qty: 10 },
      { 'X-Player-Token': alice.playerToken });
    const c = await J('POST', `/api/rooms/${roomCode}/orders/cancel`,
      { code: s.code, orderId: r.data.orderId }, { 'X-Player-Token': bob.playerToken });
    assert.strictEqual(c.status, 400);
    assert.strictEqual(c.data.error.code, 'NOT_OWNER');
  });

  await test('잘못된 주문은 에러 코드로 구분되어 돌아온다', async () => {
    const H = { 'X-Player-Token': alice.playerToken };
    const lot = await J('POST', `/api/rooms/${roomCode}/orders`, { code: 'SNU', side: 'buy', price: 1000, qty: 3 }, H);
    assert.strictEqual(lot.data.error.code, 'LOT_SIZE');
    const nos = await J('POST', `/api/rooms/${roomCode}/orders`, { code: 'ZZZ', side: 'buy', price: 1000, qty: 10 }, H);
    assert.strictEqual(nos.data.error.code, 'NO_STOCK');
    const cash = await J('POST', `/api/rooms/${roomCode}/orders`, { code: 'SNU', side: 'buy', price: 99999, qty: 99999 }, H);
    assert.strictEqual(cash.data.error.code, 'INSUFFICIENT_CASH');
    const shr = await J('POST', `/api/rooms/${roomCode}/orders`, { code: 'KOR', side: 'sell', price: 100, qty: 999999 }, H);
    assert.strictEqual(shr.data.error.code, 'INSUFFICIENT_SHARES');
  });

  await test('시장가 매도가 즉시 체결되고 체결내역이 쌓인다', async () => {
    const me = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': alice.playerToken });
    const h = me.data.holdings.find(x => x.qty >= 10);
    assert.ok(h, '보유 종목이 없어 매도 테스트 불가');
    // 그 순간 매수 호가가 비어 있으면 NO_COUNTERPARTY 가 정상 동작이다.
    // 시장가 체결 자체를 검증하려는 테스트이므로 상대 호가를 확실히 만들어 둔다.
    {
      const room = store.get(roomCode);
      const st = room.game.stockByCode.get(h.code);
      const other = [...room.game.players.values()].find(p => p.id !== alice.playerId);
      other.cash += 50_000_000;
      // 현재가 위에 걸면 매도 호가에 그대로 체결되어 매수 호가가 남지 않는다.
      // 체결되지 않고 장부에 남도록 최우선 매도호가보다 낮게 건다.
      const ask = st.book.bestAsk();
      const bidPx = Math.round(Math.min(st.last, ask ? ask * 0.99 : st.last) * 0.99);
      room.game.submitOrder(other.id, h.code, 'buy', bidPx, 200);
      assert.ok(st.book.bestBid() !== null, '상대 매수 호가를 만들지 못했다');
    }
    const r = await J('POST', `/api/rooms/${roomCode}/orders`,
      { code: h.code, side: 'sell', price: 'market', qty: 10 }, { 'X-Player-Token': alice.playerToken });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.filled > 0, '시장가인데 체결 0');
    const after = await J('GET', `/api/rooms/${roomCode}/me?sinceFill=0`, undefined, { 'X-Player-Token': alice.playerToken });
    assert.ok(after.data.newFills.some(f => f.side === 'sell'));
  });

  await test('SSE 스트림이 state 이벤트를 밀어준다 (본인 잔고 포함)', async () => {
    const ctl = new AbortController();
    const r = await fetch(`${BASE}/api/rooms/${roomCode}/stream?token=${alice.playerToken}`, { signal: ctl.signal });
    assert.strictEqual(r.headers.get('content-type').split(';')[0], 'text/event-stream');
    const reader = r.body.getReader();
    let buf = '', got = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !got) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      const m = buf.match(/event: state\ndata: (.+)\n\n/);
      if (m) got = JSON.parse(m[1]);
    }
    ctl.abort();
    assert.ok(got, 'state 이벤트를 받지 못함');
    assert.ok(got.snapshot.stocks.length === 4);
    assert.ok(got.snapshot.stocks[0].depth, '호가창(depth)이 없음');
    assert.ok(got.me && got.me.id === alice.playerId, '본인 잔고가 안 옴');
  });

  await test('내 상태에 본인 순위와 종목별 매매 가능 수량이 들어온다', async () => {
    const { data } = await J('GET', `/api/rooms/${roomCode}/me`, undefined, { 'X-Player-Token': alice.playerToken });
    assert.ok(data.rank >= 1 && data.rank <= data.rankTotal, `순위 ${data.rank}/${data.rankTotal}`);
    assert.strictEqual(data.tradable.length, 4, '참여 종목 수만큼 나와야 한다');
    for (const t of data.tradable) {
      assert.ok(t.maxBuyQty >= 0 && t.maxBuyQty % 10 === 0, `${t.code} maxBuyQty ${t.maxBuyQty}`);
      assert.ok(t.maxSellQty >= 0 && t.maxSellQty % 10 === 0, `${t.code} maxSellQty ${t.maxSellQty}`);
    }
    // maxBuyQty 만큼은 실제로 살 수 있어야 한다
    const buyable = data.tradable.find(t => t.maxBuyQty >= 10);
    if (buyable) {
      const r = await J('POST', `/api/rooms/${roomCode}/orders`,
        { code: buyable.code, side: 'buy', price: buyable.last, qty: buyable.maxBuyQty },
        { 'X-Player-Token': alice.playerToken });
      assert.strictEqual(r.status, 200, `maxBuyQty 만큼 주문했는데 거부됨: ${JSON.stringify(r.data)}`);
    }
  });

  await test('순위표는 상위 일부만 실어 보낸다 (대역폭)', async () => {
    const { data } = await J('GET', `/api/rooms/${roomCode}/state`);
    assert.ok(data.snapshot.ranking.length <= 20, `순위표 ${data.snapshot.ranking.length}명`);
    assert.ok(data.snapshot.tape.length <= 20, `체결 테이프 ${data.snapshot.tape.length}건`);
    const bytes = Buffer.byteLength(JSON.stringify(data.snapshot));
    assert.ok(bytes < 9000, `스냅샷이 ${(bytes/1024).toFixed(1)}KB — 50명이면 대역폭이 과하다`);
  });

  await test('관전 모드(토큰 없음)는 공개 정보만 받는다', async () => {
    const { data } = await J('GET', `/api/rooms/${roomCode}/state`);
    assert.ok(data.snapshot);
    assert.strictEqual(data.me, undefined);
    assert.ok(Array.isArray(data.snapshot.ranking));
  });

  await test('차트 이력에 체결가와 적정가가 함께 들어있다', async () => {
    fastForward(roomCode, 60);
    const { data } = await J('GET', `/api/rooms/${roomCode}/chart?code=SNU`);
    assert.strictEqual(data.stocks.length, 1);
    assert.ok(data.stocks[0].history.length > 0);
    const pt = data.stocks[0].history[0];
    assert.ok('price' in pt && 'fair' in pt && 't' in pt);
  });

  await test('마감 후 결과에 사람 순위와 전체 순위가 모두 나온다', async () => {
    fastForward(roomCode, 2000);                 // durationMin 2 · tickMs 100
    const { data } = await J('GET', `/api/rooms/${roomCode}/result`);
    assert.strictEqual(data.phase, 'ended');
    assert.strictEqual(data.humanRanking.length, 2);
    assert.ok(data.ranking.length > data.humanRanking.length, '봇이 전체 순위에 없음');
    assert.ok(data.humanRanking.every(r => !r.isBot));
    assert.ok(data.feesCollected >= 0);
    for (let i = 1; i < data.ranking.length; i++) assert.ok(data.ranking[i - 1].nav >= data.ranking[i].nav);
  });

  await test('시작된 뒤에는 설정을 바꿀 수 없다', async () => {
    const r = await J('POST', `/api/rooms/${roomCode}/config`,
      { config: { botCount: 1 } }, { 'X-Host-Token': hostToken });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.data.error.code, 'ALREADY_STARTED');
  });

  await test('방장이 조기 마감할 수 있다', async () => {
    const mk = await J('POST', '/api/rooms', {
      config: { stockCodes: ['SNU', 'YON'], botCount: 8, ipoSec: 1, durationMin: 30,
                tickMs: 100, seed: 4242 },
    });
    const c = mk.data.roomCode;
    await J('POST', `/api/rooms/${c}/join`, { name: '참가' });
    await J('POST', `/api/rooms/${c}/start`, {}, { 'X-Host-Token': mk.data.hostToken });
    fastForward(c, 80);
    const before = await J('GET', `/api/rooms/${c}/state`);
    assert.strictEqual(before.data.snapshot.phase, 'trading');
    const nope = await J('POST', `/api/rooms/${c}/end`);
    assert.strictEqual(nope.status, 403, '아무나 마감할 수 있으면 안 된다');
    const r = await J('POST', `/api/rooms/${c}/end`, {}, { 'X-Host-Token': mk.data.hostToken });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.phase, 'ended');
    const result = await J('GET', `/api/rooms/${c}/result`);
    assert.strictEqual(result.data.phase, 'ended');
    assert.ok(result.data.humanRanking.length === 1);
  });

  await test('마감 후에는 주문이 거부된다', async () => {
    const { data } = await J('POST', `/api/rooms/${roomCode}/orders`,
      { code: 'SNU', side: 'buy', price: 1000, qty: 10 }, { 'X-Player-Token': alice.playerToken });
    assert.strictEqual(data.error.code, 'NOT_TRADING');
  });

  console.log(results.join('\n'));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  for (const r of store.rooms.values()) r.stopTimer();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
