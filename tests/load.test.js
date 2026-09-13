'use strict';
/**
 * 부하 테스트 — 행사 당일 규모를 그대로 재현한다.
 * 실행: node tests/load.test.js [참가자수]
 *
 * 50명이 동시에 SSE 로 붙어 있고 계속 주문을 낼 때 서버가 버티는지 본다.
 * 재는 것: 주문 응답 지연, SSE 수신 누락, 스냅샷 크기, 메모리, 틱 지연.
 */
delete process.env.NO_AUTO_TICK;   // 부하 테스트는 실제 타이머로 돌려야 의미가 있다
const { server, store } = require('../server');

const N = Number(process.argv[2]) || 50;
const DURATION_SEC = 45;

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const MB = (b) => (b / 1024 / 1024).toFixed(1);

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const J = async (m, p, b, h) => {
    const r = await fetch(BASE + p, {
      method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}),
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };

  console.log(`\n[부하 테스트] 사람 ${N}명 + 봇 50명, ${DURATION_SEC}초 실주행\n`);

  const room = await J('POST', '/api/rooms', {
    title: '부하 테스트',
    config: { stockCodes: ['SEC','SKH','LGE','HMC','NVR','KKO'], botCount: 50,
              ipoSec: 5, durationMin: 3, tickMs: 250 },
  });
  const code = room.data.roomCode;

  const players = [];
  for (let i = 0; i < N; i++) {
    const r = await J('POST', `/api/rooms/${code}/join`, { name: '참가자' + i });
    players.push(r.data);
  }
  console.log(`  방 생성 + ${players.length}명 입장 완료 (${code})`);

  await J('POST', `/api/rooms/${code}/start`, {}, { 'X-Host-Token': room.data.hostToken });

  // ── SSE 연결 N개 ──
  const stats = players.map(() => ({ events: 0, bytes: 0, gaps: [], lastAt: 0 }));
  const ctls = [];
  const readers = players.map(async (p, i) => {
    const ctl = new AbortController();
    ctls.push(ctl);
    let res;
    try {
      res = await fetch(`${BASE}/api/rooms/${code}/stream?token=${p.playerToken}`, { signal: ctl.signal });
    } catch (_) { return; }
    const reader = res.body.getReader();
    const st = stats[i];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        st.bytes += value.length;
        const text = Buffer.from(value).toString('utf8');
        const n = (text.match(/event: state/g) || []).length;
        if (n > 0) {
          const now = Date.now();
          if (st.lastAt) st.gaps.push(now - st.lastAt);
          st.lastAt = now;
          st.events += n;
        }
      }
    } catch (_) { /* abort */ }
  });

  // ── 주문 부하: 각 참가자가 1.5~4초마다 주문 ──
  const orderLat = [];
  let orderOk = 0, orderErr = 0, orderFail = 0;
  let running = true;
  const traders = players.map(async (p, i) => {
    await new Promise(r => setTimeout(r, Math.random() * 2000));
    while (running) {
      const g = store.get(code) && store.get(code).game;
      if (g && g.phase === 'trading') {
        const s = g.stocks[Math.floor(Math.random() * g.stocks.length)];
        const me = g.players.get(p.playerId);
        const side = (me && (me.holdings[s.code] || 0) > 50 && Math.random() < 0.45) ? 'sell' : 'buy';
        const body = { code: s.code, side,
                       price: Math.round(s.last * (side === 'buy' ? 1.01 : 0.99)),
                       qty: 20 + Math.floor(Math.random() * 60) * 10 };
        const t0 = Date.now();
        try {
          const r = await J('POST', `/api/rooms/${code}/orders`, body, { 'X-Player-Token': p.playerToken });
          orderLat.push(Date.now() - t0);
          if (r.status === 200) orderOk++; else orderErr++;
        } catch (_) { orderFail++; }
      }
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));
    }
  });

  // ── 틱 지연 관측 ──
  const room0 = store.get(code);
  const tickLag = [];
  let lastTick = room0.game.tickNo, lastCheck = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const dt = now - lastCheck;
    const dTick = room0.game.tickNo - lastTick;
    const expected = dt / room0.config.tickMs;
    if (expected > 0) tickLag.push((expected - dTick) / expected * 100);   // 놓친 틱 비율 %
    lastTick = room0.game.tickNo; lastCheck = now;
  }, 1000);

  const m0 = process.memoryUsage();
  const c0 = process.cpuUsage();
  await new Promise(r => setTimeout(r, DURATION_SEC * 1000));
  const cpu = process.cpuUsage(c0);
  const m1 = process.memoryUsage();

  running = false;
  clearInterval(lagTimer);
  ctls.forEach(c => { try { c.abort(); } catch (_) {} });
  await Promise.race([Promise.all(readers), new Promise(r => setTimeout(r, 1500))]);
  await Promise.race([Promise.all(traders), new Promise(r => setTimeout(r, 3000))]);

  const g = store.get(code).game;
  const snapBytes = Buffer.byteLength(JSON.stringify(g.snapshot()));
  const evs = stats.map(s => s.events);
  const allGaps = stats.flatMap(s => s.gaps);
  const totalBytes = stats.reduce((a, s) => a + s.bytes, 0);

  console.log('\n  [SSE 수신]');
  console.log(`    연결 ${stats.filter(s => s.events > 0).length}/${N}개가 이벤트 수신`);
  console.log(`    참가자당 수신 이벤트  최소 ${Math.min(...evs)} / 중앙 ${pct(evs, 0.5)} / 최대 ${Math.max(...evs)}`);
  console.log(`    이벤트 간격(ms)  중앙 ${pct(allGaps, 0.5)} / p95 ${pct(allGaps, 0.95)} / 최대 ${Math.max(...allGaps)}   (설정 400ms)`);
  console.log(`    총 전송량 ${MB(totalBytes)}MB (${(totalBytes / DURATION_SEC / 1024 / 1024).toFixed(2)}MB/s), 스냅샷 1건 ${(snapBytes / 1024).toFixed(1)}KB`);

  console.log('\n  [주문 처리]');
  console.log(`    성공 ${orderOk}건 / 거부 ${orderErr}건 / 실패 ${orderFail}건`);
  console.log(`    응답 지연(ms)  중앙 ${pct(orderLat, 0.5)} / p95 ${pct(orderLat, 0.95)} / p99 ${pct(orderLat, 0.99)} / 최대 ${Math.max(...orderLat, 0)}`);

  console.log('\n  [서버]');
  console.log(`    놓친 틱 비율  중앙 ${pct(tickLag, 0.5).toFixed(1)}% / p95 ${pct(tickLag, 0.95).toFixed(1)}% / 최대 ${Math.max(...tickLag).toFixed(1)}%`);
  console.log(`    CPU ${((cpu.user + cpu.system) / 1000 / DURATION_SEC / 10).toFixed(0)}% (1코어 기준)`);
  console.log(`    메모리 ${MB(m0.heapUsed)}MB → ${MB(m1.heapUsed)}MB (RSS ${MB(m1.rss)}MB)`);
  console.log(`    총 체결 ${g.stocks.reduce((a, s) => a + s.volume, 0).toLocaleString()}주`);

  console.log('\n  [판정]');
  const ok = (c, t, f) => console.log(`    ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c ? t : f}`);
  ok(stats.every(s => s.events > 0), '모든 참가자가 실시간 갱신을 받는다', '일부 연결이 이벤트를 못 받았다');
  ok(pct(orderLat, 0.95) < 300, `주문 응답이 빠르다 (p95 ${pct(orderLat, 0.95)}ms)`, `주문 p95 ${pct(orderLat, 0.95)}ms — 체감 지연이 생긴다`);
  ok(pct(allGaps, 0.95) < 1200, `화면 갱신이 끊기지 않는다 (p95 ${pct(allGaps, 0.95)}ms)`, `갱신 간격 p95 ${pct(allGaps, 0.95)}ms — 화면이 멈춘 것처럼 보인다`);
  // 1초 창으로 재므로 틱 하나가 한 번 늦으면 그 창은 25% 가 된다. 최대값이 아니라 p95 로 본다.
  ok(pct(tickLag, 0.95) < 25, '게임 틱이 밀리지 않는다',
     `틱 지연 p95 ${pct(tickLag, 0.95).toFixed(0)}% — 화면이 주기적으로 끊긴다`);
  ok(orderFail === 0, '주문 요청이 유실되지 않는다', `${orderFail}건 유실`);
  console.log('');

  for (const r of store.rooms.values()) r.stopTimer();
  server.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
