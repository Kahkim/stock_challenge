'use strict';

const crypto = require('crypto');
const { Game, PHASE } = require('./game');
const { DEFAULTS, STOCK_POOL } = require('./config');

/** 사람이 불러주기 쉬운 참가코드 (헷갈리는 0/O/1/I 제외) */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(len = 6) {
  let out = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return out;
}
const token = () => crypto.randomBytes(16).toString('hex');

/**
 * 방을 걷어내는 기준 두 가지.
 *
 * ROOM_ENDED_MS — 마감된 방을 보존하는 시간. 기본 30분. 방이 걷히면 결과 조회와 result.csv 도
 *   404 가 되므로 이 값이 결과를 받아갈 수 있는 시한이다. 시상·정산은 마감 직후에 하므로
 *   길게 둘 이유가 없고, 끝난 방이 쌓이면 메모리와 저장 파일만 차지한다.
 * ROOM_IDLE_MS — 마지막 요청 뒤 이만큼 조용하면 걷는다(시작 안 한 로비 포함). 기본 4시간.
 *
 * 리허설에서 정리 동작을 짧게 확인하려면 둘 중 필요한 값을 낮추면 된다.
 */
function readMs(name, DEFAULT) {
  const raw = Number(process.env[name]);
  // 음수나 0 을 그대로 받으면 하한(1초)으로 눌려서 진행 중인 방까지 즉시 걷힌다.
  // 오타 하나로 행사가 날아가므로 말이 안 되는 값은 기본값으로 돌려보낸다.
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT;
  return Math.max(1000, raw);
}
const ROOM_ENDED_MS = readMs('ROOM_ENDED_MS', 30 * 60 * 1000);
const ROOM_IDLE_MS = readMs('ROOM_IDLE_MS', 4 * 3600 * 1000);

/**
 * 훑는 주기. 기준보다 드물게 훑으면 기준을 낮춰도 그만큼 늦게 걷힌다 —
 * 30분 기준을 10분마다 훑으면 최대 40분이 걸린다. 그래서 두 기준 중 짧은 쪽의 절반으로
 * 두되 1분을 넘기지 않는다. 방 목록을 한 번 도는 비용은 무시할 만하다.
 */
function sweepIntervalMs(idleMs = ROOM_IDLE_MS, endedMs = ROOM_ENDED_MS) {
  return Math.max(1000, Math.min(60 * 1000, Math.floor(Math.min(idleMs, endedMs) / 2)));
}

/** 코드가 붙은 오류 */
function cfgErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 방 만들기 화면에서 넘어온 값을 검증하고 안전한 범위로 정리한다. */
function sanitizeConfig(raw = {}) {
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const poolCodes = new Set(STOCK_POOL.map(s => s.code));
  let codes = Array.isArray(raw.stockCodes)
    ? raw.stockCodes.filter(c => poolCodes.has(c))
    : DEFAULTS.stockCodes.slice();
  codes = [...new Set(codes)];
  if (codes.length < 2) throw cfgErr('TOO_FEW_STOCKS', '종목을 2개 이상 선택해야 합니다');
  if (codes.length > STOCK_POOL.length) codes = codes.slice(0, STOCK_POOL.length);

  const mixRaw = raw.botMix || DEFAULTS.botMix;
  const mix = {};
  let mixSum = 0;
  for (const k of ['trend', 'maker', 'noise', 'contra', 'value']) {
    const v = Math.max(0, Number(mixRaw[k]) || 0);
    mix[k] = v; mixSum += v;
  }
  if (mixSum <= 0) Object.assign(mix, DEFAULTS.botMix);

  const seed = raw.seed === undefined || raw.seed === null || raw.seed === ''
    ? undefined
    : (Number.isFinite(Number(raw.seed)) ? (Number(raw.seed) >>> 0) : undefined);

  return {
    stockCodes: codes,
    seed,
    seedMoney: Math.round(num(raw.seedMoney, DEFAULTS.seedMoney, 10_000, 1_000_000_000)),
    initialShares: Math.round(num(raw.initialShares, DEFAULTS.initialShares, 0, 100_000)),
    salaryAmount: Math.round(num(raw.salaryAmount, DEFAULTS.salaryAmount, 0, 1_000_000_000)),
    salaryIntervalSec: Math.round(num(raw.salaryIntervalSec, DEFAULTS.salaryIntervalSec, 5, 3600)),
    bonusShares: raw.bonusShares === undefined ? DEFAULTS.bonusShares : !!raw.bonusShares,
    maxBonusRate: num(raw.maxBonusRate, DEFAULTS.maxBonusRate, 0, 5),
    inflationPerMin: num(raw.inflationPerMin, DEFAULTS.inflationPerMin, 0, 1),
    cashInterestPerMin: num(raw.cashInterestPerMin, DEFAULTS.cashInterestPerMin, 0, 0.1),
    openPremium: num(raw.openPremium, DEFAULTS.openPremium, 0, 2),
    marketMaker: {
      enabled: !raw.marketMaker || raw.marketMaker.enabled === undefined
        ? DEFAULTS.marketMaker.enabled : !!raw.marketMaker.enabled,
      band: num(raw.marketMaker && raw.marketMaker.band, DEFAULTS.marketMaker.band, 0.0005, 0.5),
      lagSec: num(raw.marketMaker && raw.marketMaker.lagSec, DEFAULTS.marketMaker.lagSec, 0, 3600),
      slice: num(raw.marketMaker && raw.marketMaker.slice, DEFAULTS.marketMaker.slice, 0.001, 1),
    },
    idioVolatility: num(raw.idioVolatility, DEFAULTS.idioVolatility, 0, 3),
    durationMin: num(raw.durationMin, DEFAULTS.durationMin, 1, 180),
    ipoSec: Math.round(num(raw.ipoSec, DEFAULTS.ipoSec, 0, 600)),
    tickMs: Math.round(num(raw.tickMs, DEFAULTS.tickMs, 100, 2000)),
    lotSize: Math.max(1, Math.round(num(raw.lotSize, DEFAULTS.lotSize, 1, 1000))),
    feeRate: num(raw.feeRate, DEFAULTS.feeRate, 0, 0.05),
    floatCapitalRatio: num(raw.floatCapitalRatio, DEFAULTS.floatCapitalRatio, 0.05, 5),
    botCount: Math.round(num(raw.botCount, DEFAULTS.botCount, 0, 500)),
    botExcludeFromRanking: raw.botExcludeFromRanking === undefined
      ? DEFAULTS.botExcludeFromRanking : !!raw.botExcludeFromRanking,
    botActionRate: num(raw.botActionRate, DEFAULTS.botActionRate, 0.001, 0.5),
    botCashBiasSpread: num(raw.botCashBiasSpread, DEFAULTS.botCashBiasSpread, 0, 0.9),
    botSharpness: num(raw.botSharpness, DEFAULTS.botSharpness, 0, 60),
    makerSpread: num(raw.makerSpread, DEFAULTS.makerSpread, 0.0005, 0.1),
    makerLevels: Math.round(num(raw.makerLevels, DEFAULTS.makerLevels, 1, 10)),
    ipoBidRatio: num(raw.ipoBidRatio, DEFAULTS.ipoBidRatio, 0.02, 0.35),
    ipoFloorRatio: num(raw.ipoFloorRatio, DEFAULTS.ipoFloorRatio, 0.1, 2),
    lookbackSec: Math.round(num(raw.lookbackSec, DEFAULTS.lookbackSec, 3, 600)),
    botMix: mix,
  };
}

class Room {
  constructor(code, config, title) {
    this.code = code;
    this.title = String(title || '모의주식 챌린지').slice(0, 40);
    this.hostToken = token();
    this.config = config;
    // 시드를 지정하면 같은 게임이 그대로 재현된다. 리허설을 반복하거나
    // 문제 상황을 다시 만들어 볼 때 쓴다. 지정하지 않으면 매번 다른 판이 된다.
    this.seed = config.seed || crypto.randomBytes(4).readUInt32BE(0);
    this.game = new Game(config, this.seed);
    this.tokens = new Map();       // playerToken -> playerId
    this.devices = new Map();      // deviceId  -> playerToken  (새로고침·재접속 복구용)
    this.createdAt = Date.now();
    this.timer = null;
    this.lastActivity = Date.now();
  }

  /**
   * 입장, 또는 재접속 복구.
   *
   * 50명이 모이면 새로고침하거나 잠깐 통신이 끊기는 사람이 반드시 나온다.
   * 화면이 deviceId(브라우저에 보관하는 임의 문자열)를 같이 보내면,
   * 같은 기기로 다시 들어올 때 원래 참가자로 복귀시킨다. 토큰도 그대로 돌려준다.
   * 복귀는 게임이 시작된 뒤에도 허용한다 — 막아야 하는 건 난입이지 복귀가 아니다.
   */
  join(name, deviceId) {
    const dev = deviceId ? String(deviceId).slice(0, 64) : null;

    if (dev && this.devices.has(dev)) {
      const t = this.devices.get(dev);
      const pid = this.tokens.get(t);
      const p = pid && this.game.players.get(pid);
      if (p) {
        this.lastActivity = Date.now();
        return { playerId: p.id, playerToken: t, name: p.name, resumed: true };
      }
      this.devices.delete(dev);   // 설정 변경 등으로 사라진 참가자
    }

    const p = this.game.addPlayer(name);   // 시작 뒤면 여기서 ALREADY_STARTED 가 난다
    const t = token();
    this.tokens.set(t, p.id);
    if (dev) this.devices.set(dev, t);
    this.lastActivity = Date.now();
    return { playerId: p.id, playerToken: t, name: p.name, resumed: false };
  }

  /** 보관해 둔 토큰이 아직 쓸 수 있는지 확인한다 */
  resume(playerToken) {
    const pid = this.playerIdOf(playerToken);
    const p = pid && this.game.players.get(pid);
    if (!p) {
      const e = new Error('더 이상 유효하지 않은 참가자 토큰입니다');
      e.code = 'INVALID_TOKEN';
      throw e;
    }
    this.lastActivity = Date.now();
    return { playerId: p.id, playerToken, name: p.name, resumed: true };
  }

  playerIdOf(playerToken) { return this.tokens.get(playerToken) || null; }

  /**
   * 시작 전 설정 변경. 참가자가 예상보다 적게(또는 많이) 왔을 때
   * 봇 수나 진행 시간을 손볼 수 있어야 한다.
   * 이미 입장한 참가자의 잔고는 새 시드머니로 다시 맞춘다.
   */
  reconfigure(rawConfig) {
    if (this.game.phase !== PHASE.LOBBY) {
      const e = new Error('게임이 시작된 뒤에는 설정을 바꿀 수 없습니다');
      e.code = 'ALREADY_STARTED';
      throw e;
    }
    const merged = sanitizeConfig(Object.assign({}, this.config, rawConfig));
    const names = this.game.humans().map(p => p.name);
    const tokenByName = new Map();
    for (const [t, id] of this.tokens) {
      const p = this.game.players.get(id);
      if (p) tokenByName.set(p.name, t);
    }
    this.config = merged;
    this.seed = merged.seed || this.seed;
    this.game = new Game(merged, this.seed);
    this.tokens = new Map();
    for (const name of names) {
      const p = this.game.addPlayer(name);
      const t = tokenByName.get(name);
      // 이미 나눠준 참가자 토큰을 그대로 유지해야 접속이 끊기지 않는다.
      // deviceId -> token 매핑은 토큰이 그대로이므로 손댈 필요가 없다.
      this.tokens.set(t || token(), p.id);
    }
    this.lastActivity = Date.now();
    return this.lobbyInfo();
  }

  /** 행사 운영상 조기 마감 */
  forceEnd() {
    if (this.game.phase === PHASE.LOBBY) {
      const e = new Error('아직 시작하지 않은 게임입니다');
      e.code = 'NOT_STARTED';
      throw e;
    }
    if (this.game.phase !== PHASE.ENDED) this.game._end();
    this.stopTimer();
    return this.game.snapshot();
  }

  start() {
    const snap = this.game.start();
    // 테스트는 틱을 직접 돌려 검증한다. 방 타이머가 같이 돌면 HTTP 왕복 사이에
    // 몇 틱이 지났는지가 매번 달라져(공유 난수까지 어긋난다) 결과가 재현되지 않는다.
    this._startTimer();
    return snap;
  }

  stopTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _startTimer() {
    if (this.timer || process.env.NO_AUTO_TICK) return;
    this.timer = setInterval(() => {
      try {
        this.game.tick();
        if (this.game.phase === PHASE.ENDED) this.stopTimer();
      } catch (e) { console.error('[tick]', this.code, e.message); }
    }, this.config.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * 일시정지. 틱을 멈추면 게임 시간도 같이 멈춘다 —
   * 남은 시간이 tickNo 로 계산되기 때문에 별도 보정이 필요 없다.
   */
  pause() {
    if (this.game.phase === PHASE.LOBBY) { const e = new Error('아직 시작하지 않은 게임입니다'); e.code = 'NOT_STARTED'; throw e; }
    if (this.game.phase === PHASE.ENDED) { const e = new Error('이미 마감된 게임입니다'); e.code = 'ALREADY_ENDED'; throw e; }
    this.stopTimer();
    this.paused = true;
    this.game.paused = true;
    this.game._notice('게임이 일시정지되었습니다', 'pause');
    return this.game.snapshot();
  }

  resumeGame() {
    if (!this.paused) { const e = new Error('일시정지 상태가 아닙니다'); e.code = 'NOT_PAUSED'; throw e; }
    this.paused = false;
    this.game.paused = false;
    this._startTimer();
    this.game._notice('게임이 재개되었습니다', 'resume');
    return this.game.snapshot();
  }

  kick(playerId) {
    const r = this.game.kickPlayer(playerId);
    for (const [t, id] of [...this.tokens]) if (id === playerId) this.tokens.delete(t);
    for (const [d, t] of [...this.devices]) if (!this.tokens.has(t)) this.devices.delete(d);
    this.lastActivity = Date.now();
    return r;
  }

  lobbyInfo() {
    return {
      code: this.code,
      title: this.title,
      seed: this.seed,
      phase: this.game.phase,
      paused: this.paused,
      connections: this.game.connections,
      players: this.game.humans().map(p => ({ id: p.id, name: p.name })),
      humanCount: this.game.humans().length,
      config: this.config,
      stocks: this.game.stocks.map(s => ({
        code: s.code, name: s.name, color: s.color, initialPrice: s.initialPrice,
      })),
    };
  }
}

// ── 저장과 복원 ─────────────────────────────────────────────────
Room.prototype.serialize = function () {
  return {
    v: 1,
    code: this.code, title: this.title, hostToken: this.hostToken,
    seed: this.seed, config: this.config,
    paused: this.paused,
    createdAt: this.createdAt, lastActivity: this.lastActivity,
    tokens: [...this.tokens],       // [[playerToken, playerId], ...]
    devices: [...this.devices],     // [[deviceId, playerToken], ...]
    game: this.game.serialize(),
  };
};

Room.restore = function (d) {
  if (!d || d.v !== 1) throw new Error('알 수 없는 저장 형식입니다');
  const room = new Room(d.code, d.config, d.title);
  room.hostToken = d.hostToken;
  room.seed = d.seed;
  room.paused = !!d.paused;
  room.createdAt = d.createdAt || Date.now();
  room.lastActivity = d.lastActivity || Date.now();
  room.tokens = new Map(d.tokens || []);
  room.devices = new Map(d.devices || []);
  room.game = new Game(d.config, d.seed).load(d.game);
  // 진행 중이었고 멈춰 있지 않았다면 다시 돌린다
  if (room.game.phase !== PHASE.LOBBY && room.game.phase !== PHASE.ENDED && !room.paused) {
    room._startTimer();
  }
  return room;
};

class RoomStore {
  constructor() { this.rooms = new Map(); }

  create(rawConfig, title) {
    const config = sanitizeConfig(rawConfig);
    let code;
    do { code = makeCode(); } while (this.rooms.has(code));
    const room = new Room(code, config, title);
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()) || null; }

  /**
   * 오래되고 끝난 방을 정리한다.
   *
   * 두 조건 중 하나라도 맞으면 지운다.
   *   done  — 마감된 방이 endedAt 으로부터 maxIdleMs 를 넘겼다
   *   stale — 어떤 단계든 lastActivity 로부터 maxIdleMs 를 넘겼다 (버려진 로비까지 걷힌다)
   *
   * lastActivity 는 참가코드로 방을 찾는 모든 요청에서 갱신된다(server.js 가 라우팅 직전에
   * 한 번 찍는다). 다만 이미 열려 있는 SSE 스트림은 새 요청이 아니라서 갱신하지 않으므로,
   * SSE 만 붙여 놓고 다른 요청을 전혀 보내지 않는 현황판은 기준 시간이 지나면 걷힌다.
   */
  /**
   * 숫자 하나를 주면 두 기준 모두 그 값이고(리허설·테스트용), { endedMs, idleMs } 로 따로 줄 수도
   * 있다. 안 주면 모듈 기본값(환경변수)을 쓴다.
   */
  sweep(opts) {
    const o = typeof opts === 'number' ? { endedMs: opts, idleMs: opts } : (opts || {});
    const endedMs = o.endedMs ?? ROOM_ENDED_MS, idleMs = o.idleMs ?? ROOM_IDLE_MS;
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      const done = r.game.phase === PHASE.ENDED && r.game.endedAt && now - r.game.endedAt > endedMs;
      const stale = now - r.lastActivity > idleMs;
      if (done || stale) { r.stopTimer(); this.rooms.delete(code); }
    }
  }
}

module.exports = { Room, RoomStore, sanitizeConfig, makeCode, ROOM_IDLE_MS, ROOM_ENDED_MS, sweepIntervalMs };
