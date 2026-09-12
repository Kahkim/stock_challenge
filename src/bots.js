'use strict';

const { roundToTick } = require('./config');

/**
 * NPC 참가자(봇).
 *
 * 설계 원칙 — 봇은 어떤 특권도 갖지 않는다.
 *  · 사람과 똑같이 시드머니를 받고, 똑같이 월급을 받고, 똑같이 인플레이션을 맞는다.
 *  · 사람 화면에 보이는 정보(현재가, 적정가, 최근 추세, 자기 잔고)만 본다.
 *    남의 미체결 주문이나 보유내역은 절대 보지 않는다. 서버가 볼 수 있다고 해서 보여주면
 *    봇이 구조적 내부자가 되고 게임의 정당성이 무너진다.
 *
 * 매매 방식은 "목표비중 리밸런싱"이다. 성향에 따라 종목별 목표 비중을 다르게 잡고,
 * 현재 비중이 목표보다 높으면 팔고 낮으면 산다.
 * 단순 확률로 매수/매도를 정하면 전원이 매수만 하게 되어 매도 호가가 말라붙는다.
 * (실측: 고정 매수편향 방식에서는 매도호가가 전체 시간의 77.6% 동안 비어 있었다.)
 *
 * 시장의 성격은 봇 한 명의 알고리즘이 아니라 "봇 집단의 성향 구성비(botMix)"로 제어한다.
 */

const BOT_TYPES = ['trend', 'contra', 'value', 'noise', 'maker'];

const NICKNAMES = [
  '불꽃투자', '차트왕', '존버킹', '급등타자', '물타기장인', '단타요정', '역발상', '느긋이',
  '풀매수', '손절의신', '상한가꿈', '분할매수', '고점수집가', '저점사냥꾼', '눈치백단',
  '뇌동매매', '무지성매수', '기술적분석', '추격자', '기다림', '한방노림', '스캘퍼',
  '가치투자', '모멘텀', '역추세', '데이트레이더', '평단내리기', '익절맨', '털썩', '우직이',
  '칼손절', '물린개미', '초보운전', '감으로산다', '소신파', '군중심리', '박스권', '돌파왕',
];

/** 성향 구성비(botMix)를 실제 봇 명단으로 펼친다. */
function buildRoster(count, mix, rnd) {
  const roster = [];
  const entries = BOT_TYPES.filter(t => (mix[t] || 0) > 0).map(t => [t, mix[t]]);
  const total = entries.reduce((s, [, w]) => s + w, 0) || 1;
  let assigned = 0;
  for (let i = 0; i < entries.length; i++) {
    const [type, w] = entries[i];
    const n = (i === entries.length - 1) ? count - assigned : Math.round(count * (w / total));
    for (let k = 0; k < n; k++) roster.push(type);
    assigned += n;
  }
  while (roster.length > count) roster.pop();
  while (roster.length < count) roster.push(entries.length ? entries[0][0] : 'noise');

  const pool = NICKNAMES.slice();
  return roster.map((type, i) => {
    const base = pool.length
      ? pool.splice(Math.floor(rnd() * pool.length), 1)[0]
      : NICKNAMES[i % NICKNAMES.length] + (Math.floor(i / NICKNAMES.length) + 1);
    return { type, name: base };
  });
}

/** 성향별 종목 선호 점수. 높을수록 많이 담고 싶어한다. */
function preference(p, s) {
  switch (p.botType) {
    case 'trend':  return s.refReturn;                    // 오른 종목에 올라탄다
    case 'contra': return -s.refReturn;                   // 내린 종목을 줍는다
    case 'value':  return -(s.last / s.fair - 1);         // 적정가 대비 싼 종목. 인플레 전달 통로.
    case 'maker':  return 0;                              // 종목 견해 없음. 양방향 호가만 낸다.
    default: {                                            // noise — 봇마다 고정된 무작위 취향
      if (!p._pref) p._pref = {};
      if (p._pref[s.code] === undefined) p._pref[s.code] = 0;
      return p._pref[s.code];
    }
  }
}

/** 성향 점수를 목표 비중으로 바꾼다(소프트맥스). */
function targetWeights(p, stocks, cashTarget, sharpness) {
  const scores = stocks.map(s => preference(p, s));
  const mx = Math.max(...scores);
  const exps = scores.map(v => Math.exp((v - mx) * sharpness));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const investable = Math.max(0, 1 - cashTarget);
  const out = new Map();
  stocks.forEach((s, i) => out.set(s.code, investable * exps[i] / sum));
  return out;
}

/**
 * 봇 한 명의 한 틱 의사결정. 주문 배열을 반환한다(빈 배열 가능).
 *
 * @param {object} p    참가자 객체 {botType, cash, holdings, _pref?}
 * @param {object} ctx  {stocks, rnd, lotSize, cashTarget, sharpness, makerSpread}
 *   stocks: [{code, last, fair, initialPrice, refReturn}]
 */
function decide(p, ctx) {
  const { stocks, rnd, lotSize } = ctx;
  if (!stocks.length) return [];
  // 목표 현금비중은 "시장 전체의 실제 현금비중"을 기준으로 잡는다.
  // 이게 핵심이다. 봇들의 목표 주식비중 합이 실제로 존재하는 주식보다 크면
  // 전원이 영원히 매수만 하게 되어 매도 호가가 말라붙는다.
  // 시장 비중에 맞추고 봇마다 개인 편차를 줘야 양방향 거래가 생긴다.
  if (p._cashBias === undefined) p._cashBias = (rnd() - 0.5) * (ctx.cashBiasSpread || 0.30);
  const mkt = ctx.marketCashRatio !== undefined ? ctx.marketCashRatio
            : (ctx.cashTarget !== undefined ? ctx.cashTarget : 0.15);
  const cashTarget = Math.min(0.70, Math.max(0.02, mkt + p._cashBias));
  const sharpness = ctx.sharpness !== undefined ? ctx.sharpness : 12;
  const makerSpread = ctx.makerSpread !== undefined ? ctx.makerSpread : 0.006;

  // noise 봇의 고정 취향을 최초 1회 정해둔다
  if (p.botType === 'noise' && !p._pref) {
    p._pref = {};
    for (const s of stocks) p._pref[s.code] = rnd() * 2 - 1;
  }

  let nav = p.cash;
  for (const s of stocks) nav += (p.holdings[s.code] || 0) * s.last;
  if (!(nav > 0)) return [];

  // ── 호가 제시형: 자기 현금과 자기 주식으로 양쪽에 지정가를 건다 ──
  if (p.botType === 'maker') {
    const s = stocks[Math.floor(rnd() * stocks.length)];
    if (!(s.last > 0)) return [];
    const out = [];
    const bid = roundToTick(s.last * (1 - makerSpread * (0.5 + rnd())));
    const ask = roundToTick(s.last * (1 + makerSpread * (0.5 + rnd())));
    const bq = Math.floor((p.cash * 0.10) / Math.max(1, bid) / lotSize) * lotSize;
    if (bq >= lotSize) out.push({ code: s.code, side: 'buy', price: bid, qty: bq });
    const held = p.holdings[s.code] || 0;
    const sq = Math.floor(held * 0.25 / lotSize) * lotSize;
    if (sq >= lotSize) out.push({ code: s.code, side: 'sell', price: ask, qty: sq });
    return out;
  }

  // ── 목표비중에서 가장 많이 벗어난 종목을 고쳐 잡는다 ──
  const target = targetWeights(p, stocks, cashTarget, sharpness);
  let pick = null, worst = 0;
  for (const s of stocks) {
    if (!(s.last > 0)) continue;
    const cur = ((p.holdings[s.code] || 0) * s.last) / nav;
    const gap = cur - target.get(s.code);
    const jitter = 1 + (rnd() * 0.5 - 0.25);      // 전원이 같은 종목에 몰리지 않게
    if (Math.abs(gap) * jitter > Math.abs(worst)) { worst = gap; pick = s; }
  }
  if (!pick || Math.abs(worst) < 0.02) return [];   // 이미 목표에 가까우면 쉰다

  const side = worst > 0 ? 'sell' : 'buy';
  const mid = pick.last;
  // 목표까지 한 번에 가지 않고 일부만 조정한다(분할 매매)
  const adjustValue = Math.abs(worst) * nav * (0.35 + rnd() * 0.45);

  if (side === 'buy') {
    const price = roundToTick(mid * (1 + (rnd() * 0.020 - 0.008)));
    const budget = Math.min(adjustValue, p.cash);
    const qty = Math.floor(budget / price / lotSize) * lotSize;
    if (qty < lotSize) return [];
    return [{ code: pick.code, side, price, qty }];
  } else {
    const price = roundToTick(mid * (1 + (rnd() * 0.020 - 0.012)));
    const held = p.holdings[pick.code] || 0;
    const qty = Math.min(held, Math.floor(adjustValue / Math.max(1, mid) / lotSize) * lotSize);
    const q = Math.floor(qty / lotSize) * lotSize;
    if (q < lotSize) return [];
    return [{ code: pick.code, side, price, qty: q }];
  }
}

/** 개장 공모(IPO) 청약 — 봇도 사람과 같은 공모 화면만 보고 지른다. */
function decideIpo(p, stock, ctx) {
  const { rnd, lotSize } = ctx;
  const eager = p.botType === 'trend' ? 1.05 + rnd() * 0.30
              : p.botType === 'value' ? 0.90 + rnd() * 0.15
              : p.botType === 'maker' ? 0.98 + rnd() * 0.12
              : 0.95 + rnd() * 0.25;
  const price = roundToTick(stock.initialPrice * eager);
  const budget = p.cash * (0.10 + rnd() * 0.25);
  const qty = Math.floor(budget / price / lotSize) * lotSize;
  if (qty < lotSize) return null;
  return { code: stock.code, price, qty };
}

module.exports = { BOT_TYPES, buildRoster, decide, decideIpo };
