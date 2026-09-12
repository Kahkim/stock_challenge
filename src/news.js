'use strict';

/**
 * 돌발뉴스.
 *
 * 뉴스는 두 경로로 시장에 작용한다.
 *   1) 적정가(fair)를 즉시 점프시킨다 — 이론가가 바뀌었다는 뜻이고, 화면의 괴리율에 바로 보인다.
 *   2) 봇의 종목 선호에 가산점을 준다 — 봇들이 그 종목을 사거나 판다(동조).
 *
 * 중요한 건 봇이 뉴스를 "즉시" 보지 않는다는 점이다. 봇마다 인지 시점이 다르게 흩어져 있어서
 * 동조가 서서히 번진다. 그래야 뉴스를 먼저 본 사람이 먼저 진입하고, 뒤따라오는 봇들이
 * 가격을 밀어올려 준다. 봇이 전부 즉시 반응하면 사람은 항상 마지막 매수자가 되어 손해만 본다.
 *
 * 헤드라인은 게임 속 가상 종목의 수급에 대한 서술만 쓴다.
 * 실제 대학에 대한 사실 주장(비리 의혹, 학내 분규 같은 것)은 만들지 않는다.
 * 화면을 캡처했을 때 진짜 기사처럼 읽힐 여지를 남기지 않기 위해서다.
 */

const POSITIVE = [
  '{n} 대량 매수 유입 — 매도 호가 공백',
  '{n} 동문 매수세 결집',
  '{n} 신고가 경신 — 추격 매수 확산',
  '{n} 기관 순매수 전환',
  '{n} 유통 물량 급감 — 품절주 조짐',
  '{n} 목표가 상향 리포트 발간',
  '{n} 거래량 폭증 — 상승 탄력 확대',
  '{n} 저평가 매력 부각',
  '{n} 응원단 출정 — 개인 매수 유입',
  '{n} 대규모 단체 매수 소문',
];

const NEGATIVE = [
  '{n} 차익실현 매물 출회',
  '{n} 대량 매도 물량 감지',
  '{n} 투자심리 위축 — 매수 관망',
  '{n} 고평가 부담 확대',
  '{n} 목표가 하향 리포트 발간',
  '{n} 거래량 급감 — 매수세 실종',
  '{n} 단기 급등 피로 누적',
  '{n} 손절 물량 확산',
  '{n} 상승분 반납 — 눈치보기 장세',
  '{n} 대기 매물 부담',
];

/**
 * 이번 틱에 뉴스를 띄울지 판단하고, 띄운다면 뉴스 객체를 만들어 반환한다.
 * @returns {null | object}
 */
function maybeSpawn(cfg, stocks, activeNews, tickNo, rnd) {
  const n = cfg.news;
  if (!n || !n.enabled) return null;
  if (activeNews.length >= n.maxActive) return null;

  // 틱당 발생 확률 = (틱 길이) / (평균 간격)
  const perTick = (cfg.tickMs / 1000) / Math.max(1, n.intervalSec);
  if (rnd() > perTick) return null;

  // 이미 뉴스가 걸려 있는 종목은 피한다 — 한 종목에 겹치면 충격이 과해진다
  const busy = new Set(activeNews.map(x => x.code));
  const pool = stocks.filter(s => !busy.has(s.code));
  if (!pool.length) return null;

  const stock = pool[Math.floor(rnd() * pool.length)];
  const sign = rnd() < n.positiveRatio ? 1 : -1;
  const list = sign > 0 ? POSITIVE : NEGATIVE;
  const headline = list[Math.floor(rnd() * list.length)].replace('{n}', stock.name);

  // 충격 크기를 매번 흩뜨린다. 전부 같은 크기면 패턴이 읽혀서 재미가 없다.
  const scale = 0.5 + rnd() * 1.0;

  // 악재 배수는 '봇이 얼마나 세게 반응하는가'에만 건다. 적정가 점프에는 걸지 않는다.
  // 둘 다에 곱하면 악재 한 건이 적정가를 30% 넘게 떨어뜨려(실측 -32.9%, 최대 -46.9%)
  // 적정가가 인플레이션 경로에서 통째로 이탈한다.
  const negMult = sign < 0 ? (n.negativeMultiplier || 1) : 1;
  return {
    id: 'n' + tickNo + '_' + Math.floor(rnd() * 1e6).toString(36),
    code: stock.code,
    name: stock.name,
    sign,
    headline,
    impact: n.impact * scale,               // 적정가에 줄 충격 (호재·악재 대칭)
    strength: n.strength * scale * negMult,  // 봇 선호 가산점 (악재는 더 세게)
    tick: tickNo,
    lifeTicks: Math.max(1, Math.round(n.lifeSec * 1000 / cfg.tickMs)),
    reactionTicks: Math.max(1, Math.round(n.reactionSec * 1000 / cfg.tickMs)),
  };
}

/**
 * 특정 봇이 이 뉴스에 지금 얼마나 반응하고 있는지. 0이면 아직 못 봤거나 효력이 끝난 것.
 * 봇마다 인지 시점(_newsDelay)이 다르게 배정되어 동조가 서서히 번진다.
 */
function reactionFor(p, news, tickNo, rnd) {
  if (!p._newsDelay) p._newsDelay = {};
  if (p._newsDelay[news.id] === undefined) {
    p._newsDelay[news.id] = Math.floor(rnd() * news.reactionTicks);
  }
  const age = tickNo - news.tick;
  const delay = p._newsDelay[news.id];
  if (age < delay || age > news.lifeTicks) return 0;
  // 인지한 순간 가장 강하고, 수명이 다할수록 사그라든다
  const span = Math.max(1, news.lifeTicks - delay);
  const remain = 1 - (age - delay) / span;
  return news.sign * news.strength * Math.max(0, remain);
}

module.exports = { maybeSpawn, reactionFor, POSITIVE, NEGATIVE };
