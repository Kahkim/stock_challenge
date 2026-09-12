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

  return {
    stockCodes: codes,
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
    this.game = new Game(config, crypto.randomBytes(4).readUInt32BE(0));
    this.tokens = new Map();       // playerToken -> playerId
    this.createdAt = Date.now();
    this.timer = null;
    this.lastActivity = Date.now();
  }

  join(name) {
    const p = this.game.addPlayer(name);
    const t = token();
    this.tokens.set(t, p.id);
    this.lastActivity = Date.now();
    return { playerId: p.id, playerToken: t, name: p.name };
  }

  playerIdOf(playerToken) { return this.tokens.get(playerToken) || null; }

  start() {
    const snap = this.game.start();
    const ms = this.config.tickMs;
    this.timer = setInterval(() => {
      try {
        this.game.tick();
        if (this.game.phase === PHASE.ENDED) this.stopTimer();
      } catch (e) {
        console.error('[tick]', this.code, e.message);
      }
    }, ms);
    if (this.timer.unref) this.timer.unref();
    return snap;
  }

  stopTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  lobbyInfo() {
    return {
      code: this.code,
      title: this.title,
      phase: this.game.phase,
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
