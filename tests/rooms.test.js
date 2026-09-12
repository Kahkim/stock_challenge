'use strict';
/**
 * 방 정리(sweep) 테스트. 실행: node tests/rooms.test.js
 *
 * 행사 서버는 리허설부터 본행사까지 며칠씩 떠 있다. 끝난 방이 걷히지 않으면 메모리와
 * .data 가 계속 자라고, 반대로 너무 일찍 걷히면 시상·정산 전에 결과가 사라진다
 * (방이 없어지면 /result 와 /result.csv 가 404 다). 두 방향을 다 확인한다.
 *
 * 시간은 흘려보내지 않고 endedAt / lastActivity 를 과거로 적어 넣는다. 4시간을 실제로
 * 기다릴 수는 없고, 검증하려는 건 어차피 그 두 값과 기준값의 비교다.
 */

// 방이 스스로 틱을 돌리지 않게 한다 — 타이머를 보는 테스트에서만 잠깐 켠다.
process.env.NO_AUTO_TICK = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { RoomStore, ROOM_IDLE_MS, sweepIntervalMs } = require('../src/rooms');
const { PHASE } = require('../src/game');
const persist = require('../src/persist');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}

const CFG = { stockCodes: ['SNU', 'YON'], botCount: 2, ipoSec: 5, durationMin: 1 };
const ROOT = path.join(__dirname, '..');
const HOUR = 3600 * 1000;

/** 참가자 한 명이 들어온 방. ended: true 면 시작했다가 마감까지 시킨다. */
function makeRoom(store, { ended = false } = {}) {
  const r = store.create(CFG, '테스트방');
  r.join('사람', 'dev-' + r.code);
  if (ended) { r.start(); r.forceEnd(); }
  return r;
}

/** 자식 프로세스에서 환경변수를 바꿔 읽어온다. 모듈 로드 시점에 한 번 읽는 값이라 그렇다. */
function readEnvConfig(env, script) {
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { NO_AUTO_TICK: '1', PERSIST_DIR: '' }, env),
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const READ_ROOMS = "const r=require('./src/rooms');" +
  "console.log(JSON.stringify({idle:r.ROOM_IDLE_MS,sweep:r.sweepIntervalMs()}))";
const READ_SERVER = "const s=require('./server');" +
  "console.log(JSON.stringify({idle:s.ROOM_IDLE_MS,sweep:s.SWEEP_MS}))";

console.log('\n[방 정리 테스트]');

// ── 걷어내는 조건 ────────────────────────────────────────────────

test('마감된 방은 기준 시간을 넘기면 걷힌다', () => {
  const store = new RoomStore();
  const r = makeRoom(store, { ended: true });
  assert.strictEqual(r.game.phase, PHASE.ENDED);
  assert.ok(r.game.endedAt, 'forceEnd 가 endedAt 을 남겨야 한다');

  r.game.endedAt = Date.now() - 5000;
  r.lastActivity = Date.now();            // 활동은 방금 — done 조건만으로 걷혀야 한다
  store.sweep(1000);
  assert.strictEqual(store.get(r.code), null);
  assert.strictEqual(store.rooms.size, 0);
});

test('마감 직후에는 남는다 — 결과를 받아갈 시간이 있어야 한다', () => {
  const store = new RoomStore();
  const r = makeRoom(store, { ended: true });
  store.sweep(1000);                      // 마감한 지 1초도 안 됐다
  assert.ok(store.get(r.code), '시상·정산 전에 사라지면 안 된다');
  assert.strictEqual(r.game.phase, PHASE.ENDED, '남아 있는 동안 결과는 그대로 읽힌다');
});

test('시작하지 않은 방도 오래 조용하면 걷힌다', () => {
  const store = new RoomStore();
  const r = makeRoom(store);
  assert.strictEqual(r.game.phase, PHASE.LOBBY);
  assert.strictEqual(r.game.endedAt, null, '마감 전에는 endedAt 이 없다');

  r.lastActivity = Date.now() - 5000;
  store.sweep(1000);
  assert.strictEqual(store.get(r.code), null, '버려진 로비가 남아 있으면 안 된다');
});

test('활동이 있으면 기준 시간이 지나도 남는다', () => {
  const store = new RoomStore();
  const r = makeRoom(store);
  r.lastActivity = Date.now() - 5000;     // 오래 조용했지만
  r.join('늦게 온 사람', 'dev-late');      // 지금 누가 들어왔다
  store.sweep(1000);
  assert.ok(store.get(r.code), 'join 이 lastActivity 를 갱신해야 한다');
  assert.ok(Date.now() - r.lastActivity < 1000);
});

test('진행 중이어도 요청이 끊긴 지 오래면 걷힌다 (SSE 는 활동이 아니다)', () => {
  const store = new RoomStore();
  const r = makeRoom(store);
  r.start();
  assert.notStrictEqual(r.game.phase, PHASE.ENDED);
  r.lastActivity = Date.now() - 5000;
  store.sweep(1000);
  assert.strictEqual(store.get(r.code), null, 'stale 조건은 단계를 가리지 않는다');
});

test('여러 방 중 기준을 넘긴 것만 골라 걷는다', () => {
  const store = new RoomStore();
  const old1 = makeRoom(store, { ended: true });
  const old2 = makeRoom(store);
  const fresh = makeRoom(store, { ended: true });
  old1.game.endedAt = Date.now() - 5000;
  old2.lastActivity = Date.now() - 5000;
  assert.strictEqual(store.rooms.size, 3);

  store.sweep(1000);
  assert.strictEqual(store.rooms.size, 1);
  assert.ok(store.get(fresh.code));
  assert.strictEqual(store.get(old1.code), null);
  assert.strictEqual(store.get(old2.code), null);
});

// ── 걷을 때 같이 정리되는 것 ─────────────────────────────────────

test('걷어낼 때 방 타이머를 멈춘다', () => {
  const store = new RoomStore();
  const saved = process.env.NO_AUTO_TICK;
  delete process.env.NO_AUTO_TICK;         // 이 테스트만 진짜 타이머를 쓴다
  try {
    const r = store.create(Object.assign({}, CFG, { tickMs: 2000 }), '타이머방');
    r.join('사람', 'dev-timer');
    r.start();
    assert.ok(r.timer, '시작하면 틱 타이머가 돈다');

    r.lastActivity = Date.now() - 5000;
    store.sweep(1000);
    assert.strictEqual(r.timer, null, '걷어낸 방의 타이머가 계속 돌면 안 된다');
    assert.strictEqual(store.get(r.code), null);
  } finally {
    if (saved === undefined) delete process.env.NO_AUTO_TICK;
    else process.env.NO_AUTO_TICK = saved;
  }
});

test('걷어낸 방의 저장 파일도 다음 저장에서 사라진다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sweep-'));
  try {
    const store = new RoomStore();
    const gone = makeRoom(store, { ended: true });
    const kept = makeRoom(store, { ended: true });

    assert.strictEqual(persist.saveAll(store, dir), 2);
    assert.ok(fs.existsSync(path.join(dir, gone.code + '.json')));
    assert.ok(fs.existsSync(path.join(dir, kept.code + '.json')));

    gone.game.endedAt = Date.now() - 5000;
    store.sweep(1000);
    assert.strictEqual(store.rooms.size, 1);

    assert.strictEqual(persist.saveAll(store, dir), 1);
    assert.strictEqual(fs.existsSync(path.join(dir, gone.code + '.json')), false,
      '방이 걷혔으면 저장 파일도 남아 있으면 안 된다');
    assert.ok(fs.existsSync(path.join(dir, kept.code + '.json')), '남은 방은 그대로 저장된다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 기준값과 훑는 주기 ───────────────────────────────────────────

test('기본 기준값은 4시간이다', () => {
  const r = readEnvConfig({ ROOM_IDLE_MS: '' }, READ_ROOMS);
  assert.strictEqual(r.idle, 4 * HOUR);
});

test('훑는 주기는 기준의 절반이고 10분을 넘지 않는다', () => {
  assert.strictEqual(sweepIntervalMs(4 * HOUR), 10 * 60 * 1000);   // 평상시
  assert.strictEqual(sweepIntervalMs(10 * 60 * 1000), 5 * 60 * 1000);
  assert.strictEqual(sweepIntervalMs(60 * 1000), 30 * 1000);       // 리허설용 짧은 기준
  assert.strictEqual(sweepIntervalMs(1000), 1000);                 // 하한
  assert.strictEqual(sweepIntervalMs(1), 1000);
});

test('ROOM_IDLE_MS 로 기준값을 바꿀 수 있다', () => {
  const r = readEnvConfig({ ROOM_IDLE_MS: String(60 * 1000) }, READ_ROOMS);
  assert.strictEqual(r.idle, 60 * 1000);
  assert.strictEqual(r.sweep, 30 * 1000, '기준을 낮추면 훑는 주기도 같이 짧아져야 한다');
});

test('ROOM_IDLE_MS 가 이상한 값이면 기본값으로 돌아간다', () => {
  for (const bad of ['0', '-5000', 'abc', '']) {
    const r = readEnvConfig({ ROOM_IDLE_MS: bad }, READ_ROOMS);
    assert.strictEqual(r.idle, 4 * HOUR, `ROOM_IDLE_MS=${JSON.stringify(bad)} 는 무시돼야 한다`);
  }
  // 너무 작은 양수는 버리지 않고 하한으로 올린다
  const tiny = readEnvConfig({ ROOM_IDLE_MS: '5' }, READ_ROOMS);
  assert.strictEqual(tiny.idle, 1000);
});

test('서버가 그 기준값으로 훑는 주기를 정한다', () => {
  const def = readEnvConfig({ ROOM_IDLE_MS: '' }, READ_SERVER);
  assert.strictEqual(def.idle, 4 * HOUR);
  assert.strictEqual(def.sweep, 10 * 60 * 1000);

  const short = readEnvConfig({ ROOM_IDLE_MS: String(2 * 60 * 1000) }, READ_SERVER);
  assert.strictEqual(short.idle, 2 * 60 * 1000);
  assert.strictEqual(short.sweep, 60 * 1000);
});

test('기준값을 넘기지 않으면 모듈 기본값을 쓴다', () => {
  const store = new RoomStore();
  const r = makeRoom(store);
  r.lastActivity = Date.now() - (ROOM_IDLE_MS + 60 * 1000);
  store.sweep();                          // 인자 없이
  assert.strictEqual(store.get(r.code), null);

  const store2 = new RoomStore();
  const r2 = makeRoom(store2);
  r2.lastActivity = Date.now() - (ROOM_IDLE_MS - 60 * 1000);
  store2.sweep();
  assert.ok(store2.get(r2.code), '기준에 1분 못 미치면 남아 있어야 한다');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
