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

  /** 오래되고 끝난 방을 정리한다 */
  sweep(maxIdleMs = 4 * 3600 * 1000) {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      const done = r.game.phase === PHASE.ENDED && r.game.endedAt && now - r.game.endedAt > maxIdleMs;
      const stale = now - r.lastActivity > maxIdleMs;
      if (done || stale) { r.stopTimer(); this.rooms.delete(code); }
    }
  }
}

module.exports = { Room, RoomStore, sanitizeConfig, makeCode };
