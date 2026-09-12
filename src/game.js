'use strict';

const { STOCK_POOL, DEFAULTS, roundToTick } = require('./config');
const { OrderBook, Order, bumpSeq } = require('./orderbook');
const Bots = require('./bots');
const News = require('./news');

/** 결정론적 난수 (mulberry32) — 같은 seed 면 같은 게임이 재현된다. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 표준정규 난수 */
function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const PHASE = { LOBBY: 'lobby', IPO: 'ipo', TRADING: 'trading', ENDED: 'ended' };

/** 코드가 붙은 오류 — 화면에서 상황별로 다르게 안내할 수 있도록 한다. */
function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

class Game {
  constructor(config = {}, seed = 1) {
    const cfg = { ...DEFAULTS, ...config };
    cfg.botMix = { ...DEFAULTS.botMix, ...(config.botMix || {}) };
    this.cfg = cfg;
    this.rnd = makeRng(seed);
    this.phase = PHASE.LOBBY;
    this.tickNo = 0;
    this.players = new Map();
    this.tape = [];          // 전체 체결 테이프 (현황판/차트용)
    this.tapeSeq = 0;
    this.notices = [];       // 게임 공지 (월급 지급, 공모 결과 등)
    this.news = [];          // 효력이 살아 있는 돌발뉴스
    this.newsLog = [];       // 지금까지 터진 뉴스 전체 (결과 화면용)
    this.startedAt = null;
    this.endedAt = null;
    this._salaryCount = 0;
    this.paused = false;      // 방이 관리한다
    this.connections = 0;     // 지금 SSE 로 붙어 있는 화면 수. 서버가 관리한다
    this.feesCollected = 0;   // 수수료로 시장에서 빠져나간 총액(관측용)

    const chosen = cfg.stockCodes
      .map(code => STOCK_POOL.find(s => s.code === code))
      .filter(Boolean);
    if (!chosen.length) throw err('NO_STOCKS', '참여 종목이 하나도 선택되지 않았습니다');

    this.stocks = chosen.map(s => ({
      code: s.code,
      name: s.name,
      color: s.color,
      initialPrice: s.initialPrice,
      fair: s.initialPrice,      // 적정가 — 인플레이션과 개별 실적이 반영된 이론가. 참가자에게 공개된다.
      last: s.initialPrice,      // 최종 체결가. 오직 체결로만 움직인다.
      open: s.initialPrice,
      high: s.initialPrice,
      low: s.initialPrice,
      volume: 0,
      float: 0,                  // 발행주식수 — 참가자 수가 정해진 뒤 계산
      issued: 0,                 // 공모로 실제 배정된 수량
      book: new OrderBook(s.code),
      history: [],               // {t, price, fair}
      ipoBids: [],
    }));
    this.stockByCode = new Map(this.stocks.map(s => [s.code, s]));
  }

  // ── 참가자 ────────────────────────────────────────────────────
  _newPlayer(id, name, isBot, botType) {
    const p = {
      id, name, isBot, botType,
      cash: this.cfg.seedMoney,
      holdings: {},
      fills: [],           // 본인 체결 내역 (체결 팝업용)
      fillSeq: 0,
      costBasis: {},       // 종목별 총 매입원가(수수료 포함) — 평균단가 계산용
      costQty: {},
      realized: 0,         // 실현손익
      salaryTotal: 0,
      kicked: false,       // 강퇴. 삭제하지 않는 이유는 보유 주식이 증발하면 총량 보존이 깨지기 때문
      joinedAt: Date.now(),
    };
    for (const s of this.stocks) p.holdings[s.code] = this.cfg.initialShares;
    this.players.set(id, p);
    return p;
  }

  /** 방 제목도 같은 방식으로 다듬는다 */
  static cleanTitle(raw) {
    const s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, 40);
    return s || '모의주식 챌린지';
  }

  /**
   * 이름을 다듬는다. 제어문자와 줄바꿈, 폭 없는 공백을 걷어내고 연속 공백을 하나로 줄인다.
   * 화면이 어떻게 그리든 서버가 이상한 문자열을 보관하지 않게 한다.
   */
  static cleanName(raw, fallback) {
    const s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, 12);
    return s || fallback;
  }

  addPlayer(name) {
    if (this.phase !== PHASE.LOBBY) throw err('ALREADY_STARTED', '이미 시작된 게임입니다');
    const id = 'p' + (this.players.size + 1) + '_' + Math.floor(this.rnd() * 1e6).toString(36);
    let clean = Game.cleanName(name, `참가자${this.players.size + 1}`);
    // 같은 이름이 여럿이면 화면에서 누가 누군지 알 수 없다. 뒤에 번호를 붙인다.
    const taken = new Set([...this.players.values()].map(p => p.name));
    if (taken.has(clean)) {
      const base = clean.slice(0, 10);
      let n = 2;
      while (taken.has(base + n) && n < 100) n++;
      clean = base + n;
    }
    return this._newPlayer(id, clean, false, null);
  }

  _spawnBots() {
    const roster = Bots.buildRoster(this.cfg.botCount, this.cfg.botMix, this.rnd);
    roster.forEach((b, i) => this._newPlayer('b' + (i + 1), b.name, true, b.type));
  }

  humans() { return [...this.players.values()].filter(p => !p.isBot && !p.kicked); }

  // ── 시작 ──────────────────────────────────────────────────────
  start() {
    if (this.phase !== PHASE.LOBBY) throw err('ALREADY_STARTED', '이미 시작된 게임입니다');
    if (!this.humans().length) throw err('NO_PLAYERS', '참가자가 없습니다');
    this._spawnBots();

    // 발행주식수: 전체 시드머니의 floatCapitalRatio 만큼을 종목 수로 나눠 시가총액을 균등 배분한다.
    // 초기가가 낮은 종목일수록 주식수가 많아지므로 저가주가 유리해지지 않는다.
    const totalSeed = this.players.size * this.cfg.seedMoney;
    const capPerStock = (totalSeed * this.cfg.floatCapitalRatio) / this.stocks.length;
    for (const s of this.stocks) {
      s.float = Math.max(this.cfg.lotSize,
        Math.floor(capPerStock / s.initialPrice / this.cfg.lotSize) * this.cfg.lotSize);
    }

    this.startedAt = Date.now();
    this.phase = this.cfg.ipoSec > 0 ? PHASE.IPO : PHASE.TRADING;
    this._notice(this.phase === PHASE.IPO
      ? `개장 공모 시작 — ${this.cfg.ipoSec}초 안에 청약하세요`
      : '장이 열렸습니다');
    return this.snapshot();
  }

  _notice(text, kind = 'info') {
    this.notices.push({ seq: ++this.tapeSeq, ts: Date.now(), text, kind });
    if (this.notices.length > 200) this.notices.shift();
  }

  // ── 시간 ──────────────────────────────────────────────────────
  get elapsedSec() { return this.tickNo * this.cfg.tickMs / 1000; }
  get ipoRemainSec() {
    if (this.phase !== PHASE.IPO) return 0;
    return Math.max(0, this.cfg.ipoSec - this.elapsedSec);
  }
  get tradeRemainSec() {
    if (this.phase !== PHASE.TRADING) return this.phase === PHASE.ENDED ? 0 : this.cfg.durationMin * 60;
    const used = this.elapsedSec - this.cfg.ipoSec;
    return Math.max(0, this.cfg.durationMin * 60 - used);
  }


  // ── 적정가(인플레이션 + 개별 실적) ────────────────────────────
  // 적정가는 참가자에게 공개된다. "정답을 알아도" 현재가는 적정가에서 벌어지고,
  // 그 괴리가 곧 버블이자 눈치싸움의 재료가 된다.
  _updateFair() {
    const dtMin = this.cfg.tickMs / 60000;
    const drift = Math.log(1 + this.cfg.inflationPerMin) * dtMin;
    const totalTicks = Math.max(1, (this.cfg.durationMin * 60 * 1000) / this.cfg.tickMs);
    const sigma = this.cfg.idioVolatility / Math.sqrt(totalTicks);
    for (const s of this.stocks) {
      s.fair = Math.max(1, s.fair * Math.exp(drift + gauss(this.rnd) * sigma));
    }
  }

  /**
   * 참가자를 내보낸다. 삭제하지 않고 차단만 한다 —
   * 삭제하면 그 사람이 들고 있던 주식이 증발해 총량 보존이 깨진다.
   * 미체결 주문은 걷어내고 예약분을 돌려준다.
   */
  kickPlayer(pid) {
    const p = this.players.get(pid);
    if (!p) throw err('NO_PLAYER', '참가자를 찾을 수 없습니다');
    if (p.isBot) throw err('CANNOT_KICK_BOT', '봇은 내보낼 수 없습니다');
    for (const s of this.stocks) {
      for (const o of s.book.openOrders(pid)) {
        const cancelled = s.book.cancel(o.id);
        if (!cancelled) continue;
        if (cancelled.side === 'buy') p.cash += this._buyReserve(cancelled.price, cancelled.qty);
        else p.holdings[s.code] = (p.holdings[s.code] || 0) + cancelled.qty;
      }
    }
    p.kicked = true;
    this._notice(`${p.name} 님이 방에서 나갔습니다`, 'kick');
    return { playerId: pid, name: p.name };
  }

  /** 한 종목의 총 유통주식 (미체결 매도 예약분 포함) */
  _totalShares(s) {
    let q = 0;
    for (const p of this.players.values()) q += (p.holdings[s.code] || 0);
    for (const o of s.book.asks) q += o.qty;
    return q;
  }

  /**
   * 무상증자 — 월급으로 현금이 늘어난 만큼 주식도 늘린다.
   *
   * 이게 없으면 현금만 불어나고 주식 공급은 고정이라, 전원이 매수만 하게 되어
   * 매도 호가가 말라붙는다(실측: 월급 100만/분에서 매도호가가 85%의 시간 동안 비었다).
   * 실제 증권시장의 무상증자와 같은 방식으로, 기존 보유자에게만 비례 배정한다.
   * 따라서 주식이 없는 사람 — 즉 가만히 있는 사람 — 은 한 주도 받지 못한다.
   */
  _issueBonusShares() {
    if (!this.cfg.bonusShares) return;
    const cashAdded = this.cfg.salaryAmount * this.players.size;
    if (!(cashAdded > 0)) return;
    let stockValue = 0;
    for (const s of this.stocks) stockValue += this._totalShares(s) * s.last;
    if (!(stockValue > 0)) return;

    const rate = Math.min(this.cfg.maxBonusRate, cashAdded / stockValue);
    if (!(rate > 0)) return;
    let issued = 0;
    for (const s of this.stocks) {
      let add = 0;
      for (const p of this.players.values()) {
        const held = p.holdings[s.code] || 0;
        if (held <= 0) continue;
        const bonus = Math.floor(held * rate);
        if (bonus <= 0) continue;
        p.holdings[s.code] = held + bonus;
        // 무상으로 받은 주식이므로 매입원가는 그대로 두고 수량만 늘린다 → 평균단가가 내려간다
        p.costQty[s.code] = (p.costQty[s.code] || 0) + bonus;
        add += bonus;
      }
      s.issued += add;
      issued += add;
    }
    if (issued > 0) {
      this._notice(`무상증자 ${(rate * 100).toFixed(0)}% — 보유 주식 ${issued.toLocaleString()}주 추가 배정`, 'bonus');
    }
  }

  // ── 돌발뉴스 ──────────────────────────────────────────────────
  _updateNews() {
    const n = this.cfg.news;
    if (!n || !n.enabled) return;
    // 수명이 다한 뉴스를 걷어낸다
    this.news = this.news.filter(x => this.tickNo - x.tick <= x.lifeTicks);

    const fresh = News.maybeSpawn(this.cfg, this.stocks, this.news, this.tickNo, this.rnd);
    if (!fresh) return;
    this.news.push(fresh);

    // 적정가를 즉시 점프시킨다. 체결가는 봇과 사람이 반응해야 따라온다.
    const s = this.stockByCode.get(fresh.code);
    if (s) s.fair = Math.max(1, s.fair * (1 + fresh.sign * fresh.impact));

    this.newsLog.push({
      id: fresh.id, code: fresh.code, name: fresh.name, sign: fresh.sign,
      headline: fresh.headline, impactPct: fresh.sign * fresh.impact * 100,
      atSec: Math.round(this.elapsedSec),
      priceAt: s ? s.last : null,
    });
    this._notice(fresh.headline, fresh.sign > 0 ? 'news-up' : 'news-down');
  }

  // ── 월급 ──────────────────────────────────────────────────────
  _applySalary() {
    const iv = this.cfg.salaryIntervalSec;
    if (!(iv > 0) || !(this.cfg.salaryAmount > 0)) return;
    const used = this.elapsedSec - this.cfg.ipoSec;
    const due = Math.floor(used / iv);
    if (due <= this._salaryCount) return;
    this._salaryCount = due;
    for (const p of this.players.values()) {
      p.cash += this.cfg.salaryAmount;
      p.salaryTotal += this.cfg.salaryAmount;
    }
    this._notice(`월급 ${this.cfg.salaryAmount.toLocaleString()}원 지급`, 'salary');
    this._issueBonusShares();
  }

  // ── 가격 이력 (1초에 한 점) ───────────────────────────────────
  _recordHistory() {
    const per = Math.max(1, Math.round(1000 / this.cfg.tickMs));
    if (this.tickNo % per !== 0) return;
    for (const s of this.stocks) {
      s.history.push({ t: Math.round(this.elapsedSec), price: s.last, fair: Math.round(s.fair) });
      if (s.history.length > 1800) s.history.shift();
    }
  }

  _refReturn(s) {
    const h = s.history;
    if (h.length < 2) return 0;
    const back = Math.min(h.length - 1, this.cfg.lookbackSec);
    const prev = h[h.length - 1 - back];
    return prev && prev.price > 0 ? (s.last / prev.price - 1) : 0;
  }

  /** 시장 전체의 현금 비중. 봇의 목표 비중 기준점이 된다. */
  _marketCashRatio() {
    let cash = 0, stock = 0;
    for (const p of this.players.values()) cash += p.cash;
    for (const s of this.stocks) {
      for (const o of s.book.bids) cash += this._buyReserve(o.price, o.qty);
      let q = 0;
      for (const p of this.players.values()) q += (p.holdings[s.code] || 0);
      for (const o of s.book.asks) q += o.qty;
      stock += q * s.last;
    }
    const tot = cash + stock;
    return tot > 0 ? cash / tot : 0.5;
  }

  _botCtx() {
    return {
      news: this.news,
      tickNo: this.tickNo,
      marketCashRatio: this._marketCashRatio(),
      cashBiasSpread: this.cfg.botCashBiasSpread,
      rnd: this.rnd,
      lotSize: this.cfg.lotSize,
      cashTarget: this.cfg.botCashTarget,
      sharpness: this.cfg.botSharpness,
      makerSpread: this.cfg.makerSpread,
      makerLevels: this.cfg.makerLevels,
      ipoBidRatio: this.cfg.ipoBidRatio,
      stocks: this.stocks.map(s => ({
        code: s.code, last: s.last, fair: s.fair,
        initialPrice: s.initialPrice, refReturn: this._refReturn(s),
      })),
    };
  }

  // ── 봇 ────────────────────────────────────────────────────────
  _runBots() {
    const ctx = this._botCtx();
    for (const p of this.players.values()) {
      if (!p.isBot) continue;
      if (this.rnd() > this.cfg.botActionRate) continue;
      const orders = Bots.decide(p, ctx) || [];
      for (const d of orders) {
        try { this.submitOrder(p.id, d.code, d.side, d.price, d.qty); }
        catch (_) { /* 잔고 부족 등은 그냥 넘긴다 */ }
      }
    }
  }

  // ── 개장 공모 (단일가 배정) ───────────────────────────────────
  submitIpoBid(pid, code, price, qty) {
    if (this.phase !== PHASE.IPO) throw err('NOT_IPO', '공모 시간이 아닙니다');
    const p = this.players.get(pid);
    if (!p) throw err('NO_PLAYER', '참가자를 찾을 수 없습니다');
    if (p.kicked) throw err('KICKED', '이 방에서 내보내졌습니다');
    const s = this.stockByCode.get(code);
    if (!s) throw err('NO_STOCK', '없는 종목입니다');
    price = roundToTick(Number(price));
    qty = Math.floor(Number(qty) / this.cfg.lotSize) * this.cfg.lotSize;
    if (!(price > 0) || !(qty >= this.cfg.lotSize)) throw err('LOT_SIZE', `수량은 ${this.cfg.lotSize}주 단위입니다`);
    const need = price * qty;
    if (p.cash < need) throw err('INSUFFICIENT_CASH', '현금이 부족합니다');
    p.cash -= need;                       // 청약증거금 예치
    s.ipoBids.push({ pid, price, qty, seq: ++this.tapeSeq });
    return { code, price, qty, reserved: need };
  }

  _runIpoBots() {
    const ctx = this._botCtx();
    for (const p of this.players.values()) {
      if (!p.isBot || p._ipoDone) continue;
      if (p._ipoTick === undefined) {
        const window = Math.max(1, (this.cfg.ipoSec * 1000) / this.cfg.tickMs);
        p._ipoTick = 1 + Math.floor(this.rnd() * window * 0.8);
      }
      if (this.tickNo < p._ipoTick) continue;
      p._ipoDone = true;
      // 봇도 사람과 같은 공모 화면만 보고, 1~3개 종목에 청약한다.
      const picks = this.stocks.slice().sort(() => this.rnd() - 0.5)
        .slice(0, 1 + Math.floor(this.rnd() * Math.min(3, this.stocks.length)));
      for (const s of picks) {
        const bid = Bots.decideIpo(p, s, ctx);
        if (!bid) continue;
        try { this.submitIpoBid(p.id, bid.code, bid.price, bid.qty); } catch (_) {}
      }
    }
  }

  _closeIpo() {
    for (const s of this.stocks) {
      const bids = s.ipoBids.slice().sort((a, b) => (b.price - a.price) || (a.seq - b.seq));
      if (!bids.length) {
        this._notice(`${s.name} 공모 미달 — 시초가 ${s.initialPrice.toLocaleString()}원`, 'ipo');
        continue;
      }
      // 공모가: 발행 물량이 소진되는 가격. 수요가 물량에 못 미치면 최저 청약가.
      let cum = 0, clearing = bids[bids.length - 1].price;
      for (const b of bids) { cum += b.qty; if (cum >= s.float) { clearing = b.price; break; } }

      let remain = s.float;
      for (const b of bids) {
        const p = this.players.get(b.pid);
        let take = 0;
        if (b.price >= clearing && remain > 0) {
          take = Math.min(b.qty, remain);
          take = Math.floor(take / this.cfg.lotSize) * this.cfg.lotSize;
          remain -= take;
        }
        if (take > 0) {
          p.holdings[s.code] = (p.holdings[s.code] || 0) + take;
          this._addCost(p, s.code, clearing * take, take);
          this._pushFill(p, 'buy', s, clearing, take, '공모');
        }
        p.cash += b.price * b.qty - clearing * take;   // 낙찰 차액 + 미배정분 환급
      }
      s.issued = s.float - remain;
      s.last = clearing; s.open = clearing; s.high = clearing; s.low = clearing;
      s.ipoBids = [];
      const ratio = cum / Math.max(1, s.float);
      this._notice(`${s.name} 공모가 ${clearing.toLocaleString()}원 확정 (청약 ${ratio.toFixed(1)}배, ${s.issued.toLocaleString()}주 배정)`, 'ipo');
    }
    this.phase = PHASE.TRADING;
    this._notice('장이 열렸습니다', 'open');
  }

  // ── 주문 ──────────────────────────────────────────────────────
  _buyReserve(price, qty) { return Math.ceil(price * qty * (1 + this.cfg.feeRate)); }

  _addCost(p, code, gross, qty) {
    p.costBasis[code] = (p.costBasis[code] || 0) + gross;
    p.costQty[code] = (p.costQty[code] || 0) + qty;
  }

  _reduceCost(p, code, qty) {
    const q = p.costQty[code] || 0;
    if (q <= 0) return 0;
    const take = Math.min(q, qty);
    const avg = (p.costBasis[code] || 0) / q;
    p.costBasis[code] = Math.max(0, (p.costBasis[code] || 0) - avg * take);
    p.costQty[code] = q - take;
    return avg;
  }

  _pushFill(p, side, s, price, qty, tag) {
    p.fills.push({
      seq: ++p.fillSeq, ts: Date.now(), code: s.code, name: s.name,
      side, price, qty, amount: price * qty, tag: tag || null,
    });
    if (p.fills.length > 300) p.fills.shift();
  }

  _settleTrades(s, trades) {
    for (const t of trades) {
      const buyerId = t.takerSide === 'buy' ? t.taker : t.maker;
      const sellerId = t.takerSide === 'buy' ? t.maker : t.taker;
      const B = this.players.get(buyerId), S = this.players.get(sellerId);
      const gross = t.price * t.qty;
      const fee = Math.floor(gross * this.cfg.feeRate);
      this.feesCollected += fee * 2;   // 매수자·매도자 양쪽에서 걷는다

      // 매수자: 주식 입고 (현금은 주문 시 예약분에서 정산)
      B.holdings[s.code] = (B.holdings[s.code] || 0) + t.qty;
      this._addCost(B, s.code, gross + fee, t.qty);
      // 매도자: 대금 입금 (주식은 주문 시 예약분에서 이미 차감)
      const avg = this._reduceCost(S, s.code, t.qty);
      S.cash += gross - fee;
      S.realized = (S.realized || 0) + (t.price - avg) * t.qty - fee;

      s.last = t.price;
      s.volume += t.qty;
      s.high = Math.max(s.high, t.price);
      s.low = Math.min(s.low, t.price);

      this._pushFill(B, 'buy', s, t.price, t.qty);
      this._pushFill(S, 'sell', s, t.price, t.qty);
      this.tape.push({ seq: ++this.tapeSeq, code: s.code, price: t.price, qty: t.qty,
                       side: t.takerSide, t: Math.round(this.elapsedSec) });
      if (this.tape.length > 400) this.tape.shift();
    }
  }

  /**
   * 주문 제출.
   * price 를 생략하거나 'market' 을 주면 시장가로 처리한다.
   *
   * 시장가는 IOC(즉시 체결하고 남은 물량은 취소)로 동작한다. 이게 중요하다.
   * 잔량을 호가에 남기면 "현재가 −30%짜리 매도 주문"이 장부에 걸려 있다가
   * 나중에 체결되어 참가자가 헐값에 팔리게 된다.
   */
  submitOrder(pid, code, side, price, qty) {
    if (this.phase !== PHASE.TRADING) throw err('NOT_TRADING', '거래 시간이 아닙니다');
    const p = this.players.get(pid);
    if (!p) throw err('NO_PLAYER', '참가자를 찾을 수 없습니다');
    if (p.kicked) throw err('KICKED', '이 방에서 내보내졌습니다');
    const s = this.stockByCode.get(code);
    if (!s) throw err('NO_STOCK', '없는 종목입니다');
    if (side !== 'buy' && side !== 'sell') throw err('BAD_SIDE', 'side 는 buy 또는 sell 이어야 합니다');

    const lot = this.cfg.lotSize;
    qty = Math.floor(Number(qty) / lot) * lot;
    if (!(qty >= lot)) throw err('LOT_SIZE', `수량은 ${lot}주 단위로 ${lot}주 이상이어야 합니다`);

    const isMarket = (price === undefined || price === null || price === 'market');
    if (isMarket) {
      // 반대편 호가를 전부 쓸어담을 수 있는 지정가로 변환한 뒤, 남은 물량은 아래에서 취소한다.
      const opp = side === 'buy' ? s.book.bestAsk() : s.book.bestBid();
      if (opp === null) throw err('NO_COUNTERPARTY', '반대편 호가가 없습니다. 지정가로 주문하세요');
      price = roundToTick(side === 'buy' ? opp * 1.30 : opp * 0.70);
    } else {
      price = roundToTick(Number(price));
    }
    if (!(price > 0)) throw err('BAD_PRICE', '가격이 올바르지 않습니다');

    if (side === 'buy') {
      const reserve = this._buyReserve(price, qty);
      if (p.cash < reserve) throw err('INSUFFICIENT_CASH', '현금이 부족합니다');
      p.cash -= reserve;
      let { trades, rest, filled } = s.book.submit('buy', price, qty, pid);
      this._settleTrades(s, trades);
      if (isMarket && rest) { s.book.cancel(rest.id); rest = null; }   // IOC
      let spent = 0;
      for (const t of trades) spent += t.price * t.qty + Math.floor(t.price * t.qty * this.cfg.feeRate);
      const stillLocked = rest ? this._buyReserve(rest.price, rest.qty) : 0;
      p.cash += reserve - spent - stillLocked;      // 유리하게 체결된 차액 + 취소분 환급
      if (isMarket && filled === 0) {
        throw err('NO_COUNTERPARTY', '체결 가능한 매도 호가가 없습니다 (본인 주문은 체결되지 않습니다)');
      }
      return { filled, resting: rest ? rest.qty : 0, orderId: rest ? rest.id : null,
               price: isMarket ? (trades[0] ? trades[0].price : price) : price, qty, market: isMarket };
    } else {
      if ((p.holdings[code] || 0) < qty) throw err('INSUFFICIENT_SHARES', '보유 주식이 부족합니다');
      p.holdings[code] -= qty;
      let { trades, rest, filled } = s.book.submit('sell', price, qty, pid);
      this._settleTrades(s, trades);
      if (isMarket && rest) {                                          // IOC
        s.book.cancel(rest.id);
        p.holdings[code] = (p.holdings[code] || 0) + rest.qty;
        rest = null;
      }
      if (isMarket && filled === 0) {
        throw err('NO_COUNTERPARTY', '체결 가능한 매수 호가가 없습니다 (본인 주문은 체결되지 않습니다)');
      }
      return { filled, resting: rest ? rest.qty : 0, orderId: rest ? rest.id : null,
               price: isMarket ? (trades[0] ? trades[0].price : price) : price, qty, market: isMarket };
    }
  }

  cancelOrder(pid, code, orderId) {
    const p = this.players.get(pid);
    const s = this.stockByCode.get(code);
    if (!p || !s) throw err('NOT_FOUND', '대상을 찾을 수 없습니다');
    const o = s.book.cancel(orderId);
    if (!o) throw err('ORDER_GONE', '이미 체결되었거나 없는 주문입니다');
    if (o.owner !== pid) { // 남의 주문은 되돌려 놓는다
      if (o.side === 'buy') s.book._insert(s.book.bids, o, true);
      else s.book._insert(s.book.asks, o, false);
      throw err('NOT_OWNER', '본인 주문이 아닙니다');
    }
    if (o.side === 'buy') p.cash += this._buyReserve(o.price, o.qty);
    else p.holdings[code] = (p.holdings[code] || 0) + o.qty;
    return { cancelled: o.qty };
  }

  // ── 평가 ──────────────────────────────────────────────────────
  /** 미체결 주문에 묶인 현금/주식을 한 번에 집계 */
  _lockedMap() {
    const m = new Map();
    const get = (id) => {
      let v = m.get(id);
      if (!v) { v = { cash: 0, shares: {} }; m.set(id, v); }
      return v;
    };
    for (const s of this.stocks) {
      for (const o of s.book.bids) get(o.owner).cash += this._buyReserve(o.price, o.qty);
      for (const o of s.book.asks) {
        const v = get(o.owner);
        v.shares[s.code] = (v.shares[s.code] || 0) + o.qty;
      }
    }
    return m;
  }

  nav(p, locked) {
    const L = locked || { cash: 0, shares: {} };
    let v = p.cash + L.cash;
    for (const s of this.stocks) {
      const q = (p.holdings[s.code] || 0) + (L.shares[s.code] || 0);
      v += q * s.last;
    }
    return Math.round(v);
  }

  ranking(includeBots) {
    const inc = includeBots === undefined ? !this.cfg.botExcludeFromRanking : includeBots;
    const locked = this._lockedMap();
    const base = this.cfg.seedMoney;
    const rows = [...this.players.values()]
      .filter(p => !p.kicked)
      .filter(p => inc || !p.isBot)
      .map(p => {
        const invested = base + p.salaryTotal;
        const v = this.nav(p, locked.get(p.id));
        return { id: p.id, name: p.name, isBot: p.isBot, nav: v,
                 pnl: v - invested, pnlPct: invested ? (v / invested - 1) * 100 : 0 };
      })
      .sort((a, b) => b.nav - a.nav);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  // ── 스냅샷 ────────────────────────────────────────────────────
  //
  // 초당 2.5회 × 참가자 수만큼 나가므로 크기가 곧 대역폭이다.
  // 순위표 50명 전체를 매번 실어 보내면 그것만으로 페이로드의 43%를 차지한다.
  // 상위 몇 명만 싣고, 본인 순위는 playerView 의 rank 로 따로 알려준다.
  snapshot(depthLevels, opts) {
    const lv = depthLevels || 10;
    const o = opts || {};
    const rankLimit = o.rankingLimit !== undefined ? o.rankingLimit : 20;
    const tapeLimit = o.tapeLimit !== undefined ? o.tapeLimit : 20;
    return {
      phase: this.phase,
      tickNo: this.tickNo,
      elapsedSec: Math.round(this.elapsedSec),
      ipoRemainSec: Math.round(this.ipoRemainSec),
      remainSec: Math.round(this.tradeRemainSec),
      playerCount: this.players.size,
      paused: this.paused,
      connections: this.connections,
      feesCollected: Math.round(this.feesCollected),
      // 로비에서는 참가자가 속속 들어오는 걸 화면이 실시간으로 보여줘야 한다.
      // 봇은 시작할 때 생기므로 이 단계에는 사람만 있다. 시작 뒤에는 싣지 않는다(크기).
      players: this.phase === PHASE.LOBBY
        ? [...this.players.values()].map(p => ({ id: p.id, name: p.name })) : undefined,
      humanCount: this.humans().length,
      config: {
        lotSize: this.cfg.lotSize, feeRate: this.cfg.feeRate,
        seedMoney: this.cfg.seedMoney, salaryAmount: this.cfg.salaryAmount,
        salaryIntervalSec: this.cfg.salaryIntervalSec, inflationPerMin: this.cfg.inflationPerMin,
        durationMin: this.cfg.durationMin, ipoSec: this.cfg.ipoSec,
      },
      stocks: this.stocks.map(s => ({
        code: s.code, name: s.name, color: s.color,
        last: s.last, fair: Math.round(s.fair), open: s.open,
        high: s.high, low: s.low, volume: s.volume,
        float: s.float, issued: s.issued,
        changePct: s.open ? (s.last / s.open - 1) * 100 : 0,
        vsFairPct: s.fair ? (s.last / s.fair - 1) * 100 : 0,
        depth: s.book.depth(lv),
        ipoDemand: this.phase === PHASE.IPO
          ? s.ipoBids.reduce((a, b) => a + b.qty, 0) : undefined,
      })),
      ranking: this.ranking().slice(0, rankLimit),
      news: this.news.map(n => ({
        id: n.id, code: n.code, name: n.name, sign: n.sign, headline: n.headline,
        impactPct: Math.round(n.sign * n.impact * 1000) / 10,
        ageSec: Math.round((this.tickNo - n.tick) * this.cfg.tickMs / 1000),
        lifeSec: Math.round(n.lifeTicks * this.cfg.tickMs / 1000),
      })),
      notices: this.notices.slice(-12),
      tape: this.tape.slice(-tapeLimit),
    };
  }

  playerView(pid, sinceFillSeq) {
    const p = this.players.get(pid);
    if (!p) return null;
    const locked = this._lockedMap().get(p.id) || { cash: 0, shares: {} };
    const holdings = this.stocks.map(s => {
      const free = p.holdings[s.code] || 0;
      const lockedQty = locked.shares[s.code] || 0;
      const qty = free + lockedQty;
      const cq = p.costQty[s.code] || 0;
      const avg = cq > 0 ? (p.costBasis[s.code] || 0) / cq : 0;
      const evalAmt = qty * s.last;
      return {
        code: s.code, name: s.name, qty, free, locked: lockedQty,
        avgPrice: Math.round(avg), last: s.last, evalAmount: Math.round(evalAmt),
        pnl: Math.round(evalAmt - avg * qty),
        pnlPct: avg > 0 ? (s.last / avg - 1) * 100 : 0,
      };
    }).filter(h => h.qty > 0);

    const openOrders = [];
    for (const s of this.stocks) {
      for (const o of s.book.openOrders(p.id)) openOrders.push({ ...o, name: s.name });
    }
    // 종목별로 지금 낼 수 있는 최대 수량. 화면이 직접 계산하다 틀리면
    // 참가자가 계속 "현금이 부족합니다" 를 맞게 된다(부하 테스트에서 거부의 83%가 이것이었다).
    const lot = this.cfg.lotSize;
    const tradable = this.stocks.map(s => {
      const unit = s.last * (1 + this.cfg.feeRate);
      const free = p.holdings[s.code] || 0;
      return {
        code: s.code, name: s.name, last: s.last,
        maxBuyQty: unit > 0 ? Math.floor(p.cash / unit / lot) * lot : 0,
        maxSellQty: Math.floor(free / lot) * lot,
      };
    });

    const myRank = this.ranking().find(r => r.id === p.id) || null;
    const since = Number(sinceFillSeq) || 0;
    return {
      id: p.id, name: p.name, isBot: p.isBot,
      rank: myRank ? myRank.rank : null,
      rankTotal: this.ranking().length,
      cash: Math.round(p.cash), lockedCash: Math.round(locked.cash),
      nav: this.nav(p, locked),
      invested: this.cfg.seedMoney + p.salaryTotal,
      salaryTotal: p.salaryTotal,
      realized: Math.round(p.realized || 0),
      holdings, openOrders, tradable,
      newFills: p.fills.filter(f => f.seq > since),
      fillSeq: p.fillSeq,
    };
  }

  // ── 저장과 복원 ───────────────────────────────────────────────
  //
  // 행사 중 서버가 죽으면 진행 중인 게임이 통째로 사라진다. 호가창까지 전부 담는다.
  // 난수는 시드에서 새로 시작하므로 복원 뒤의 전개는 원래와 달라지지만,
  // 참가자의 자산과 시장 상태는 그대로 이어진다.
  serialize() {
    return {
      v: 1,
      phase: this.phase,
      tickNo: this.tickNo,
      tapeSeq: this.tapeSeq,
      salaryCount: this._salaryCount,
      feesCollected: this.feesCollected,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      paused: this.paused,
      stocks: this.stocks.map(s => ({
        code: s.code, fair: s.fair, last: s.last, open: s.open,
        high: s.high, low: s.low, volume: s.volume, float: s.float, issued: s.issued,
        history: s.history.slice(-600),
        ipoBids: s.ipoBids,
        bids: s.book.bids.map(o => ({ id: o.id, seq: o.seq, side: o.side, price: o.price, qty: o.qty, owner: o.owner, ts: o.ts })),
        asks: s.book.asks.map(o => ({ id: o.id, seq: o.seq, side: o.side, price: o.price, qty: o.qty, owner: o.owner, ts: o.ts })),
      })),
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, isBot: p.isBot, botType: p.botType,
        cash: p.cash, holdings: p.holdings, costBasis: p.costBasis, costQty: p.costQty,
        realized: p.realized, salaryTotal: p.salaryTotal, kicked: p.kicked,
        fillSeq: p.fillSeq, fills: p.fills.slice(-40),
      })),
      news: this.news,
      newsLog: this.newsLog.slice(-60),
      notices: this.notices.slice(-30),
      tape: this.tape.slice(-40),
    };
  }

  /** serialize() 로 저장한 상태를 이 게임 인스턴스에 덮어쓴다 */
  load(d) {
    if (!d || d.v !== 1) throw err('BAD_SNAPSHOT', '알 수 없는 저장 형식입니다');
    this.phase = d.phase;
    this.tickNo = d.tickNo || 0;
    this.tapeSeq = d.tapeSeq || 0;
    this._salaryCount = d.salaryCount || 0;
    this.feesCollected = d.feesCollected || 0;
    this.startedAt = d.startedAt || null;
    this.endedAt = d.endedAt || null;
    this.paused = !!d.paused;

    this.players.clear();
    for (const q of d.players || []) {
      const p = this._newPlayer(q.id, q.name, q.isBot, q.botType);
      p.cash = q.cash; p.holdings = q.holdings || {};
      p.costBasis = q.costBasis || {}; p.costQty = q.costQty || {};
      p.realized = q.realized || 0; p.salaryTotal = q.salaryTotal || 0;
      p.kicked = !!q.kicked; p.fillSeq = q.fillSeq || 0; p.fills = q.fills || [];
    }

    for (const sd of d.stocks || []) {
      const s = this.stockByCode.get(sd.code);
      if (!s) continue;
      Object.assign(s, {
        fair: sd.fair, last: sd.last, open: sd.open, high: sd.high, low: sd.low,
        volume: sd.volume, float: sd.float, issued: sd.issued,
        history: sd.history || [], ipoBids: sd.ipoBids || [],
      });
      s.book = new OrderBook(s.code);
      for (const o of sd.bids || []) s.book.bids.push(Order.from(o));
      for (const o of sd.asks || []) s.book.asks.push(Order.from(o));
      s.book.bids.sort((a, b) => (b.price - a.price) || (a.seq - b.seq));
      s.book.asks.sort((a, b) => (a.price - b.price) || (a.seq - b.seq));
    }
    bumpSeq(d.tapeSeq || 0);

    this.news = d.news || [];
    this.newsLog = d.newsLog || [];
    this.notices = d.notices || [];
    this.tape = d.tape || [];
    return this;
  }

  // ── 진행 ──────────────────────────────────────────────────────
  tick() {
    if (this.phase === PHASE.ENDED || this.phase === PHASE.LOBBY) return;
    this.tickNo++;
    if (this.phase === PHASE.IPO) {
      this._runIpoBots();
      if (this.ipoRemainSec <= 0) this._closeIpo();
      return;
    }
    this._updateFair();
    this._updateNews();
    this._applySalary();
    this._runBots();
    this._recordHistory();
    if (this.tradeRemainSec <= 0) this._end();
  }

  _end() {
    // 미체결 주문 전량 취소 후 예약분 반환
    for (const s of this.stocks) {
      for (const o of [...s.book.bids, ...s.book.asks]) {
        const p = this.players.get(o.owner);
        if (!p) continue;
        if (o.side === 'buy') p.cash += this._buyReserve(o.price, o.qty);
        else p.holdings[s.code] = (p.holdings[s.code] || 0) + o.qty;
      }
      s.book.bids.length = 0;
      s.book.asks.length = 0;
    }
    this.phase = PHASE.ENDED;
    this.endedAt = Date.now();
    this._notice('장이 마감되었습니다', 'close');
  }
}

module.exports = { Game, PHASE, makeRng, gauss, err };
