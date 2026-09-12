import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* =======================================================================
   아트보드 소스 생성기.   실행:  node design/gen.mjs

   화면에 찍히는 모든 수치는 이 파일에서 계산된다. 손으로 적은 값은 없다.
   게임 규칙과 필드 이름은 claude/dreamy-knuth-bgjjrp 브랜치의
   docs/API.md · src/config.js · src/game.js 를 따른다.
   ======================================================================= */
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artboards');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- design tokens ---------- */
const T = {
  bg: '#0A0C10', surf: '#12151B', surf2: '#191D25', surf3: '#20252E',
  line: '#242A34', line2: '#2E3540',
  text: '#EDEFF3', dim: '#8B93A1', dim2: '#5C6472',
  up: '#FF4D5E',        // 상승 · 매수
  down: '#4C8DFF',      // 하락 · 매도
  accent: '#C6F24E',    // 게임 UI (타이머 · 나 · 주 CTA · 월급)
  warn: '#F5A524',      // 거품 경고 (적정가 대비 과열)
  ink: '#0A0C10',
  sans: "'IBM Plex Sans KR', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
};
const upTint = 'rgba(255,77,94,0.13)';
const downTint = 'rgba(76,141,255,0.13)';
const accTint = 'rgba(198,242,78,0.10)';
const warnTint = 'rgba(245,165,36,0.13)';

/* ---------- 서버 설정 (src/config.js DEFAULTS) ------------------------- */
const CFG = {
  seedMoney: 1_000_000,
  salaryAmount: 100_000,
  salaryIntervalSec: 60,
  inflationPerMin: 0.05,
  maxBonusRate: 0.05,
  durationMin: 15,
  ipoSec: 45,
  lotSize: 10,
  feeRate: 0.0015,
  floatCapitalRatio: 0.60,
  botCount: 30,
};
const HUMANS = 6;
const PLAYERS = HUMANS + CFG.botCount;
const ELAPSED = 482;                                   // 정규장 경과 8분 2초
const REMAIN = CFG.durationMin * 60 - ELAPSED;         // 06:58
const SALARY_TICKS = Math.floor(ELAPSED / CFG.salaryIntervalSec);   // 8회
const NEXT_TICK_IN = CFG.salaryIntervalSec - (ELAPSED % CFG.salaryIntervalSec);

/** 호가 단위 — src/config.js tickSize() 와 동일 */
const tickSize = (p) => (p < 2000 ? 5 : p < 5000 ? 10 : 25);
const onTick = (p) => p % tickSize(p) === 0;

/* ---------- 종목 (src/config.js STOCK_POOL, 10개 대학) ----------------- */
const STOCKS = [
  { code: 'SNU', name: '서울대', color: '#1b3f7a', init: 1200, open: 1240, fair: 1773, last: 1650, high: 1710, low: 1215, volume: 8430 },
  { code: 'YON', name: '연세대', color: '#0a2d5e', init: 2500, open: 2680, fair: 3694, last: 3480, high: 3540, low: 2650, volume: 4120 },
  { code: 'KOR', name: '고려대', color: '#8b1a2b', init: 3400, open: 3560, fair: 5024, last: 5250, high: 5300, low: 3520, volume: 2980 },
  { code: 'HYU', name: '한양대', color: '#0f4c81', init: 1800, open: 1865, fair: 2660, last: 2850, high: 2900, low: 1840, volume: 6250 },
  { code: 'DGU', name: '동국대', color: '#d4870c', init: 900, open: 985, fair: 1330, last: 1190, high: 1250, low: 940, volume: 9870 },
  { code: 'KKU', name: '건국대', color: '#00704a', init: 2200, open: 2310, fair: 3251, last: 3120, high: 3210, low: 2280, volume: 3640 },
  { code: 'HON', name: '홍익대', color: '#1a1a2e', init: 5000, open: 5300, fair: 7388, last: 8150, high: 8250, low: 5225, volume: 1820 },
  { code: 'KHU', name: '경희대', color: '#8c2b3f', init: 1500, open: 1545, fair: 2216, last: 1975, high: 2080, low: 1520, volume: 5310 },
  { code: 'KGU', name: '경기대', color: '#2b5f8c', init: 3000, open: 3140, fair: 4433, last: 4020, high: 4150, low: 3100, volume: 2470 },
  { code: 'SSU', name: '숭실대', color: '#1f6f3f', init: 4200, open: 4350, fair: 6206, last: 5900, high: 6025, low: 4310, volume: 1960 },
];
const STOCK_COUNT = STOCKS.length;
// 발행 계획 수량: 전체 시드머니 × floatCapitalRatio 를 종목 수로 나눠 시가총액 균등
const CAP_PER_STOCK = (CFG.seedMoney * PLAYERS * CFG.floatCapitalRatio) / STOCK_COUNT;
for (const s of STOCKS) {
  s.float = Math.round(CAP_PER_STOCK / s.init / CFG.lotSize) * CFG.lotSize;
  s.issued = Math.floor(s.float * Math.pow(1 + CFG.maxBonusRate, SALARY_TICKS));
  s.changePct = (s.last / s.open - 1) * 100;      // 시초가 대비
  s.vsFairPct = (s.last / s.fair - 1) * 100;      // 적정가 대비 괴리율
}

/* ---------- 무결성 검사 — 어긋나면 생성 자체를 멈춘다 ------------------ */
const problems = [];
for (const s of STOCKS) {
  for (const [k, v] of Object.entries({ open: s.open, last: s.last, high: s.high, low: s.low })) {
    if (!onTick(v)) problems.push(`${s.name} ${k}=${v} 가 호가단위(${tickSize(v)}원) 배수가 아님`);
  }
  if (s.high < Math.max(s.open, s.last)) problems.push(`${s.name} 고가 < max(시초,현재)`);
  if (s.low > Math.min(s.open, s.last)) problems.push(`${s.name} 저가 > min(시초,현재)`);
  if (s.volume % CFG.lotSize !== 0) problems.push(`${s.name} 거래량이 lotSize 배수가 아님`);
}

/* ---------- "나"의 원장 (서버 규칙 그대로) ----------------------------- */
const fee = (amount) => Math.round(amount * CFG.feeRate);
const bonusStep = (qty) => Math.floor(qty * (1 + CFG.maxBonusRate));

const tape = [];        // 원장 기록
let cash = CFG.seedMoney;
let salaryTotal = 0, realized = 0, feePaid = 0;
const hold = {};        // code -> qty
const boughtQty = {};   // code -> 직접 사들인 수량 (무상증자 제외)
let lastBonus = [];     // 마지막 정산에서 배정된 무상증자
const cost = {};        // code -> 수수료 포함 매입원가

const rec = (t, what, delta) => { tape.push({ t, what, delta, cash }); };
rec('00:00', '시작 자금', 0);

// 개장 공모 배정: 서울대 120주 @ 시초가 1,240
{
  const qty = 120, price = 1240, amt = qty * price, f = fee(amt);
  cash -= amt + f; feePaid += f; hold.SNU = qty; boughtQty.SNU = qty; cost.SNU = amt + f;
  rec('00:00', `개장 공모 배정 · 서울대 ${qty}주 @ ${price}`, -(amt + f));
}
for (let m = 1; m <= SALARY_TICKS; m++) {
  cash += CFG.salaryAmount; salaryTotal += CFG.salaryAmount;
  const gained = [];
  lastBonus = [];
  for (const code of Object.keys(hold)) {
    const before = hold[code];
    hold[code] = bonusStep(before);
    if (hold[code] > before) {
      gained.push(`${code} +${hold[code] - before}`);
      lastBonus.push({ code, add: hold[code] - before });
    }
  }
  rec(`0${m}:00`, `월급 +${CFG.salaryAmount.toLocaleString()} / 무상증자 ${CFG.maxBonusRate * 100}%${gained.length ? ' (' + gained.join(', ') + ')' : ''}`, CFG.salaryAmount);

  if (m === 1) {   // 1:20 매수 → 1:50 매도 (증자 사이에 끝난다)
    const q = 100, bp = 950, ba = q * bp, bf = fee(ba);
    cash -= ba + bf; feePaid += bf;
    rec('01:20', `동국대 ${q}주 @ ${bp} 매수`, -(ba + bf));
    const sp = 920, sa = q * sp, sf = fee(sa);
    cash += sa - sf; feePaid += sf;
    const r = (sa - sf) - (ba + bf);
    realized += r;
    rec('01:50', `동국대 ${q}주 @ ${sp} 매도 (실현 ${r.toLocaleString()})`, sa - sf);
  }
  if (m === 3) {   // 3:30 한양대 매수
    const q = 80, p = 1900, a = q * p, f = fee(a);
    cash -= a + f; feePaid += f; hold.HYU = q; boughtQty.HYU = q; cost.HYU = a + f;
    rec('03:30', `한양대 ${q}주 @ ${p} 매수`, -(a + f));
  }
}
// 한양대 100주 @ 2,800 매수 주문 → 40주 즉시 체결(filled), 60주는 호가창에 잔류(resting)
const ORDER = { code: 'HYU', name: '한양대', side: 'buy', price: 2800, qty: 100, filled: 40, id: 'o812' };
{
  const fa = ORDER.filled * ORDER.price, ff = fee(fa);
  cash -= fa + ff; feePaid += ff;
  hold.HYU += ORDER.filled; boughtQty.HYU += ORDER.filled; cost.HYU += fa + ff;
  rec('08:02', `한양대 ${ORDER.filled}주 @ ${ORDER.price} 매수 체결`, -(fa + ff));
}
const OPEN_ORDER = { ...ORDER, qty: ORDER.qty - ORDER.filled };
const lockedCash = OPEN_ORDER.price * OPEN_ORDER.qty;
cash -= lockedCash;
rec('08:02', `한양대 ${OPEN_ORDER.qty}주 미체결 · 증거금 예치`, -lockedCash);

const byCode = Object.fromEntries(STOCKS.map((s) => [s.code, s]));
const holdings = Object.keys(hold).map((code) => {
  const s = byCode[code], qty = hold[code], evalAmount = qty * s.last;
  return {
    code, name: s.name, qty, locked: 0, avgPrice: Math.round(cost[code] / qty),
    last: s.last, evalAmount, pnl: evalAmount - cost[code],
    pnlPct: (evalAmount / cost[code] - 1) * 100,
  };
});
const evalTotal = holdings.reduce((a, h) => a + h.evalAmount, 0);
const ME = {
  name: '앨리스', cash, lockedCash, nav: cash + lockedCash + evalTotal,
  invested: CFG.seedMoney + salaryTotal, salaryTotal, realized, feePaid,
  holdings, evalTotal,
};
ME.pnl = ME.nav - ME.invested;
ME.pnlPct = ME.nav / ME.invested * 100 - 100;

// 검산: 총자산 = 현금 + 묶인현금 + 평가액,  손익 = 평가손익합 + 실현손익
{
  const pnlSum = holdings.reduce((a, h) => a + h.pnl, 0) + realized;
  if (Math.abs(pnlSum - ME.pnl) > 1) problems.push(`손익 불일치: 평가+실현 ${pnlSum} vs nav-invested ${ME.pnl}`);
}

/* ---------- 사람 순위 (invested 는 전원 동일) -------------------------- */
const RANKING = [
  { name: '차트왕', nav: 2_410_000 },
  { name: '학교사랑', nav: 2_180_000 },
  { name: ME.name, nav: ME.nav, me: true },
  { name: '눈물의손절', nav: 1_935_000 },
  { name: '뒷북러', nav: 1_842_000 },
  { name: '가만히있기', nav: ME.invested },     // 청약도 매매도 안 한 사람 = 정확히 0%
].map((p, i) => ({
  ...p, rank: i + 1,
  pnl: p.nav - ME.invested,
  pnlPct: p.nav / ME.invested * 100 - 100,
}));

/* ---------- 포맷 ---------- */
const n = (v) => Math.round(v).toLocaleString('en-US');
const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
const pct1 = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
const signed = (v) => (v >= 0 ? '+' : '−') + n(Math.abs(v));
const col = (v) => (v >= 0 ? T.up : T.down);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const BUBBLE_AT = 5;   // 괴리율이 이 이상이면 거품 경고색
const fairCol = (v) => (v >= BUBBLE_AT ? T.warn : T.dim);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function page({ w, h, body }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap">
  <style>
    body { margin: 0; background: ${T.bg}; color: ${T.text}; font-family: ${T.sans}; -webkit-font-smoothing: antialiased; }
    a { color: ${T.accent}; text-decoration: none; }
    a:hover { color: #DCFF8A; }
    .m { font-family: ${T.mono}; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  </style>
</helmet>
${body}
</x-dc>
<script data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {}
</script>
</body>
</html>
`;
}

/* ---------- icons ---------- */
const ico = (d, size = 20, stroke = T.dim, sw = 1.6) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"></path></svg>`;
const icoBack = (c = T.text) => ico('M15 5l-7 7 7 7', 22, c, 1.8);
const icoMinus = (c) => ico('M5 12h14', 18, c, 2);
const icoPlus = (c) => ico('M12 5v14M5 12h14', 18, c, 2);
const icoPulse = (c) => ico('M3 12h4l3-8 4 16 3-8h4', 20, c, 1.7);
const icoWallet = (c, s = 20) => ico('M3 8a2 2 0 012-2h13a1 1 0 011 1v2M3 8v9a2 2 0 002 2h14a1 1 0 001-1v-3M3 8h17M21 11h-4a2 2 0 000 4h4', s, c, 1.5);
const icoInfo = (c, s = 20) => ico('M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 7.6v.2', s, c, 1.5);
const icoBolt = (c, s = 20) => ico('M13 3L5 14h6l-1 7 8-11h-6l1-7z', s, c, 1.5);
const icoCopy = (c, s = 20) => ico('M9 9V5a1 1 0 011-1h9a1 1 0 011 1v9a1 1 0 01-1 1h-4M5 9h9a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1z', s, c, 1.5);
const icoGift = (c, s = 20) => ico('M20 12v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8M3 8h18v4H3V8zM12 21V8M12 8H7.5a2.5 2.5 0 010-5C11 3 12 8 12 8zM12 8h4.5a2.5 2.5 0 000-5C13 3 12 8 12 8z', s, c, 1.5);
const icoCheck = (c, s = 20) => ico('M4 12.5l5 5L20 6.5', s, c, 2);
const icoTrophy = (c, s = 20) => ico('M7 4h10v5a5 5 0 01-10 0V4zM7 6H4v1a3 3 0 003 3M17 6h3v1a3 3 0 01-3 3M9 20h6M12 14v6', s, c, 1.5);

/* ---------- 공용 컴포넌트 ---------- */
const label = (t) =>
  `<div style="font-size:12px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;margin-bottom:9px;">${t}</div>`;

function segmented(items, activeIdx) {
  return `<div style="display:flex;gap:4px;padding:4px;background:${T.surf};border:1px solid ${T.line};border-radius:12px;">
      ${items.map((s, i) => {
        const on = i === activeIdx;
        return `<div style="flex-grow:1;height:44px;display:flex;align-items:center;justify-content:center;border-radius:9px;background:${on ? T.accent : 'transparent'};color:${on ? T.ink : T.dim};font-size:14px;font-weight:${on ? 700 : 500};">${s}</div>`;
      }).join('\n      ')}
    </div>`;
}

const hint = (t, c = T.dim2) => `<div style="display:flex;align-items:flex-start;gap:6px;margin-top:9px;">
        <div style="flex-shrink:0;margin-top:-1px;">${icoInfo(c)}</div>
        <div style="font-size:11px;color:${c};line-height:1.5;">${t}</div>
      </div>`;

const stepperRow = (name, value, sub) => `<div style="display:flex;align-items:center;gap:12px;height:${sub ? 64 : 56}px;">
        <div style="flex-grow:1;">
          <div style="font-size:14px;font-weight:500;color:${T.text};">${name}</div>
          ${sub ? `<div style="font-size:11px;color:${T.dim2};margin-top:2px;">${sub}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:${T.surf3};">${icoMinus(T.dim)}</div>
          <div style="min-width:74px;text-align:center;font-size:16px;font-weight:700;" class="m">${value}</div>
          <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:${T.surf3};">${icoPlus(T.text)}</div>
        </div>
      </div>`;

/** 서버가 주는 대학 색은 어두운 교색이라 다크 배경에서 안 보인다.
    색상(hue)은 유지한 채 흰색과 섞어 밝힌다. */
function lighten(hex, amt) {
  const v = parseInt(hex.slice(1), 16);
  const r = Math.round((v >> 16 & 255) + (255 - (v >> 16 & 255)) * amt);
  const g = Math.round((v >> 8 & 255) + (255 - (v >> 8 & 255)) * amt);
  const b = Math.round((v & 255) + (255 - (v & 255)) * amt);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** 종목 색 점 — 서버가 종목마다 color 를 준다 */
const dot = (c, s = 8) => `<div style="width:${s}px;height:${s}px;border-radius:${s / 2}px;background:${lighten(c, 0.45)};flex-shrink:0;"></div>`;

/** 적정가 대비 괴리율 배지 */
const fairBadge = (v) => `<div style="display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:5px;background:${v >= BUBBLE_AT ? warnTint : T.surf3};color:${fairCol(v)};font-size:10px;font-weight:700;" class="m">${v >= BUBBLE_AT ? '거품 ' : ''}${pct1(v)}</div>`;

const gameHeader = (title, right) => `<div style="height:56px;display:flex;align-items:center;gap:6px;padding:0 16px 0 4px;border-bottom:1px solid ${T.line};">
    <div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;">${icoBack()}</div>
    <div style="font-size:17px;font-weight:600;flex-grow:1;">${title}</div>
    ${right || ''}
  </div>`;

const timerChip = () => `<div style="display:flex;align-items:center;gap:5px;">
      <div style="width:6px;height:6px;border-radius:3px;background:${T.accent};"></div>
      <div style="font-size:14px;font-weight:700;color:${T.accent};" class="m">${clock(REMAIN)}</div>
    </div>`;


/* =======================================================================
   1) 방 만들기 — Room.dc.html
   ======================================================================= */
const ROOM_H = 1420;
// 세그먼트 선택 위치는 CFG 에서 파생시킨다 — 손으로 박으면 설정만 바꿨을 때 조용히 어긋난다
const DUR_OPTS = [5, 10, 15];
const IPO_OPTS = [0, 30, 45];
const SEED_OPTS = [500_000, 1_000_000, 5_000_000];
if (DUR_OPTS.indexOf(CFG.durationMin) < 0) problems.push(`정규장 세그먼트에 ${CFG.durationMin}분 없음`);
if (IPO_OPTS.indexOf(CFG.ipoSec) < 0) problems.push(`공모 세그먼트에 ${CFG.ipoSec}초 없음`);
if (SEED_OPTS.indexOf(CFG.seedMoney) < 0) problems.push(`시드 세그먼트에 ${CFG.seedMoney} 없음`);

const stockChip = (s, on) => `<div style="display:flex;align-items:center;gap:7px;height:42px;padding:0 12px;border-radius:10px;border:1px solid ${on ? T.accent : T.line};background:${on ? accTint : 'transparent'};">
        ${dot(s.color, 8)}
        <div style="font-size:13px;font-weight:${on ? 600 : 500};color:${on ? T.text : T.dim};">${s.name}</div>
        <div style="font-size:11px;color:${T.dim2};" class="m">${n(s.init)}</div>
      </div>`;

const roomBody = `<div style="width:390px;min-height:${ROOM_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  ${gameHeader('방 만들기', `<div style="font-size:12px;color:${T.dim2};" class="m">1 / 1</div>`)}

  <div style="flex-grow:1;display:flex;flex-direction:column;gap:22px;padding:20px 16px 16px;">

    <div>
      ${label('방 이름')}
      <div style="height:52px;display:flex;align-items:center;gap:10px;padding:0 14px;background:${T.surf};border:1px solid ${T.line2};border-radius:12px;">
        <div style="flex-grow:1;font-size:16px;font-weight:500;color:${T.text};">동문회 챌린지</div>
        <div style="font-size:12px;color:${T.dim2};" class="m">7/20</div>
      </div>
    </div>

    <div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:9px;">
        <div style="font-size:12px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;flex-grow:1;">거래 종목</div>
        <div style="font-size:12px;color:${T.accent};font-weight:600;" class="m">${STOCK_COUNT} / ${STOCK_COUNT} 선택</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
      ${STOCKS.map((s) => stockChip(s, true)).join('\n      ')}
      </div>
      ${hint('2개 이상 골라야 합니다. 목록과 초기가는 서버 <span style="color:' + T.dim + ';">GET /api/meta</span> 의 stockPool 을 그대로 씁니다 — 화면에 하드코딩하지 않습니다.')}
    </div>

    <div>
      ${label('진행')}
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <div style="font-size:11px;color:${T.dim2};margin-bottom:6px;">정규장 길이</div>
          ${segmented(DUR_OPTS.map((m) => m + '분'), DUR_OPTS.indexOf(CFG.durationMin))}
        </div>
        <div>
          <div style="font-size:11px;color:${T.dim2};margin-bottom:6px;">개장 공모</div>
          ${segmented(IPO_OPTS.map((v) => (v ? v + '초' : '없음')), IPO_OPTS.indexOf(CFG.ipoSec))}
        </div>
      </div>
      ${hint('공모를 켜면 전원이 주식 0주로 시작해 청약으로 시초가를 만듭니다. 끄면 바로 정규장입니다.')}
    </div>

    <div>
      ${label('자산')}
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <div style="font-size:11px;color:${T.dim2};margin-bottom:6px;">1인당 시작 현금</div>
          ${segmented(SEED_OPTS.map((v) => v / 10000 + '만'), SEED_OPTS.indexOf(CFG.seedMoney))}
        </div>
        <div style="display:flex;flex-direction:column;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:2px 14px;">
          ${stepperRow('월급', n(CFG.salaryAmount), `매 ${CFG.salaryIntervalSec}초 · 전원 동일`)}
        </div>
      </div>
    </div>

    <div>
      ${label('참가')}
      <div style="display:flex;flex-direction:column;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:2px 14px;">
        ${stepperRow('봇 수', String(CFG.botCount), '사람과 완전히 같은 조건으로 참가 · 시상 제외')}
      </div>
      ${hint('사람 수는 정하지 않습니다. 초대코드로 들어온 만큼 참가합니다.')}
    </div>

    <div>
      ${label('고급 설정')}
      <div style="display:flex;align-items:center;gap:12px;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:14px 16px;">
        <div style="flex-grow:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:${T.text};">기본값 사용 중</div>
          <div style="font-size:11px;color:${T.dim2};margin-top:3px;line-height:1.5;">인플레 ${CFG.inflationPerMin * 100}%/분 · 무상증자 최대 ${CFG.maxBonusRate * 100}% · ${CFG.lotSize}주 단위 · 수수료 ${(CFG.feeRate * 100).toFixed(2)}% · 봇 성향 배합</div>
        </div>
        <div style="transform:rotate(180deg);flex-shrink:0;">${icoBack(T.dim2)}</div>
      </div>
    </div>

  </div>

  <div style="padding:12px 16px 20px;border-top:1px solid ${T.line};background:${T.bg};">
    <div style="height:56px;display:flex;align-items:center;justify-content:center;border-radius:14px;background:${T.accent};color:${T.ink};font-size:16px;font-weight:700;">방 만들고 참가코드 받기</div>
    <div style="text-align:center;font-size:11px;color:${T.dim2};margin-top:10px;">POST /api/rooms → 6자리 참가코드와 방장 토큰이 발급됩니다</div>
  </div>

</div>`;
fs.writeFileSync(`${OUT}/Room.dc.html`, page({ w: 390, h: ROOM_H, body: roomBody }));

/* =======================================================================
   2) 대기실 — Lobby.dc.html
   ======================================================================= */
const LOBBY_H = 1110;
const LOBBY_PLAYERS = [
  { name: '앨리스', host: true }, { name: '차트왕' }, { name: '학교사랑' },
  { name: '눈물의손절' }, { name: '뒷북러' }, { name: '가만히있기' },
];

const lobbyBody = `<div style="width:390px;min-height:${LOBBY_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  ${gameHeader('동문회 챌린지', `<div style="height:22px;padding:0 8px;border-radius:6px;background:${T.surf3};color:${T.dim};font-size:11px;font-weight:600;display:flex;align-items:center;">대기 중</div>`)}

  <div style="flex-grow:1;display:flex;flex-direction:column;gap:22px;padding:20px 16px 16px;">

    <div style="background:${T.surf};border:1px solid ${T.line2};border-radius:16px;padding:20px;text-align:center;">
      <div style="font-size:12px;color:${T.dim2};font-weight:600;letter-spacing:0.04em;">참가코드</div>
      <div style="font-size:42px;font-weight:700;color:${T.accent};letter-spacing:0.12em;margin-top:8px;" class="m">SC6NSN</div>
      <div style="display:flex;gap:10px;margin-top:18px;">
        <div style="flex-grow:1;height:48px;display:flex;align-items:center;justify-content:center;gap:7px;border-radius:12px;border:1px solid ${T.line2};color:${T.text};font-size:14px;font-weight:600;">${icoCopy(T.dim)}코드 복사</div>
        <div style="flex-grow:1;height:48px;display:flex;align-items:center;justify-content:center;border-radius:12px;border:1px solid ${T.line2};color:${T.text};font-size:14px;font-weight:600;">링크 공유</div>
      </div>
    </div>

    <div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:9px;">
        <div style="font-size:12px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;flex-grow:1;">참가자</div>
        <div style="font-size:12px;color:${T.text};font-weight:600;" class="m">사람 ${HUMANS} · 봇 ${CFG.botCount}</div>
      </div>
      <div style="background:${T.surf};border:1px solid ${T.line};border-radius:12px;overflow:hidden;">
        ${LOBBY_PLAYERS.map((p, i) => `<div style="display:flex;align-items:center;gap:10px;height:52px;padding:0 14px;${i ? `border-top:1px solid ${T.line};` : ''}">
          <div style="width:28px;height:28px;border-radius:9px;background:${T.surf3};color:${T.dim};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;" class="m">${i + 1}</div>
          <div style="flex-grow:1;font-size:14px;font-weight:${p.host ? 700 : 500};color:${T.text};">${p.name}</div>
          ${p.host ? `<div style="height:20px;padding:0 7px;border-radius:5px;background:${T.accent};color:${T.ink};font-size:10px;font-weight:700;display:flex;align-items:center;">방장</div>` : ''}
        </div>`).join('\n        ')}
      </div>
    </div>

    <div>
      ${label('거래 종목 ' + STOCK_COUNT)}
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
      ${STOCKS.map((s) => `<div style="display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;background:${T.surf};border:1px solid ${T.line};">
          ${dot(s.color, 7)}<div style="font-size:12px;color:${T.dim};">${s.name}</div>
        </div>`).join('\n      ')}
      </div>
    </div>

    <div>
      ${label('규칙')}
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
      ${[`정규장 ${CFG.durationMin}분`, `개장 공모 ${CFG.ipoSec}초`, `시드 ${n(CFG.seedMoney)}`, `월급 ${n(CFG.salaryAmount)}/분`, `인플레 ${CFG.inflationPerMin * 100}%/분`, `무상증자 ${CFG.maxBonusRate * 100}%`, `${CFG.lotSize}주 단위`, `수수료 ${(CFG.feeRate * 100).toFixed(2)}%`]
        .map((t) => `<div style="height:28px;padding:0 10px;display:flex;align-items:center;border-radius:8px;background:${T.surf2};color:${T.dim};font-size:11px;font-weight:500;" class="m">${t}</div>`).join('\n      ')}
      </div>
    </div>

  </div>

  <div style="padding:12px 16px 20px;border-top:1px solid ${T.line};background:${T.bg};">
    <div style="height:56px;display:flex;align-items:center;justify-content:center;border-radius:14px;background:${T.accent};color:${T.ink};font-size:16px;font-weight:700;">게임 시작</div>
    <div style="text-align:center;font-size:11px;color:${T.warn};margin-top:10px;">시작하면 더 이상 참가할 수 없습니다 (409 ALREADY_STARTED)</div>
  </div>

</div>`;
fs.writeFileSync(`${OUT}/Lobby.dc.html`, page({ w: 390, h: LOBBY_H, body: lobbyBody }));

/* =======================================================================
   3) 개장 공모 — Ipo.dc.html
   ======================================================================= */
const IPO_H = 1390;
const IPO_REMAIN = 28;
const MY_BID = { code: 'SNU', price: 1300, qty: 120 };
const MY_RESERVED = MY_BID.price * MY_BID.qty;
const IPO_DEMAND = { SNU: 2760, YON: 1340, KOR: 980, HYU: 1980, DGU: 3640, KKU: 1420, HON: 620, KHU: 2240, KGU: 1080, SSU: 760 };

const ipoRow = (s) => {
  const demand = IPO_DEMAND[s.code];
  const rate = demand / s.float;
  const mine = s.code === MY_BID.code;
  return `<div style="display:flex;align-items:center;gap:10px;height:64px;padding:0 16px;border-bottom:1px solid ${T.line};background:${mine ? accTint : 'transparent'};">
      ${dot(s.color, 9)}
      <div style="flex-grow:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="font-size:15px;font-weight:600;color:${T.text};">${s.name}</div>
          ${mine ? `<div style="height:18px;padding:0 5px;border-radius:4px;background:${T.accent};color:${T.ink};font-size:9px;font-weight:700;display:flex;align-items:center;" class="m">내 ${MY_BID.qty}주</div>` : ''}
        </div>
        <div style="font-size:11px;color:${T.dim2};margin-top:2px;" class="m">초기가 ${n(s.init)} · 발행 ${n(s.float)}주</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:14px;font-weight:600;color:${T.text};" class="m">${n(demand)}주</div>
        <div style="font-size:11px;font-weight:600;color:${rate >= 1 ? T.up : T.dim2};margin-top:2px;" class="m">청약률 ${rate.toFixed(1)}배</div>
      </div>
    </div>`;
};

const ipoBody = `<div style="width:390px;min-height:${IPO_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  <div style="padding:16px 16px 0;border-bottom:1px solid ${T.line};">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="flex-grow:1;font-size:15px;font-weight:600;color:${T.text};">동문회 챌린지</div>
      <div style="height:24px;padding:0 9px;border-radius:6px;background:${warnTint};color:${T.warn};font-size:10px;font-weight:700;letter-spacing:0.06em;display:flex;align-items:center;">개장 공모</div>
    </div>
    <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px;">
      <div style="font-size:40px;font-weight:700;color:${T.warn};letter-spacing:-0.02em;" class="m">${IPO_REMAIN}</div>
      <div style="font-size:14px;color:${T.dim};">초 뒤 마감</div>
      <div style="flex-grow:1;"></div>
      <div style="font-size:12px;color:${T.dim2};">단일가 배정</div>
    </div>
    <div style="height:3px;border-radius:2px;background:${T.surf3};margin:12px 0 16px;display:flex;">
      <div style="width:${Math.round((CFG.ipoSec - IPO_REMAIN) / CFG.ipoSec * 100)}%;background:${T.warn};border-radius:2px;"></div>
    </div>
  </div>

  <div style="padding:16px 16px 0;">
    <div style="display:flex;gap:10px;background:${warnTint};border:1px solid rgba(245,165,36,0.35);border-radius:14px;padding:14px 16px;">
      <div style="flex-shrink:0;margin-top:1px;">${icoBolt(T.warn, 20)}</div>
      <div>
        <div style="font-size:14px;font-weight:700;color:${T.warn};">청약하지 않으면 주식 0주로 시작합니다</div>
        <div style="font-size:12px;color:${T.dim};line-height:1.6;margin-top:5px;">전원 현금만 들고 시작합니다. 주식이 없으면 매분 들어오는 <b style="color:${T.text};">무상증자를 한 주도 받지 못하고</b>, 인플레로 오르는 값도 못 탑니다. 아무것도 안 하면 수익률이 정확히 0%가 되어 최하위로 갑니다.</div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:8px;padding:22px 16px 10px;">
    <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">종목별 청약 현황</div>
    <div style="font-size:11px;color:${T.dim2};" class="m">400ms 갱신</div>
  </div>

  <div style="border-top:1px solid ${T.line};">
    ${STOCKS.map(ipoRow).join('\n    ')}
  </div>

  <div style="flex-grow:1;"></div>

  <div style="border-top:1px solid ${T.line};background:${T.surf};padding:14px 16px 18px;margin-top:16px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      ${dot(byCode.SNU.color, 9)}
      <div style="font-size:15px;font-weight:700;color:${T.text};flex-grow:1;">서울대 청약</div>
      <div style="font-size:11px;color:${T.dim2};" class="m">호가 ${tickSize(MY_BID.price)}원 · ${CFG.lotSize}주 단위</div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;height:48px;padding:0 6px 0 14px;background:${T.bg};border:1px solid ${T.line2};border-radius:11px;">
      <div style="font-size:11px;color:${T.dim2};width:44px;">가격</div>
      <div style="flex-grow:1;text-align:right;font-size:17px;font-weight:700;" class="m">${n(MY_BID.price)}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoMinus(T.dim)}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoPlus(T.text)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;height:48px;padding:0 6px 0 14px;background:${T.bg};border:1px solid ${T.line2};border-radius:11px;margin-top:8px;">
      <div style="font-size:11px;color:${T.dim2};width:44px;">수량</div>
      <div style="flex-grow:1;text-align:right;font-size:17px;font-weight:700;" class="m">${MY_BID.qty}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoMinus(T.dim)}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoPlus(T.text)}</div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin:14px 2px 8px;">
      <div style="font-size:12px;color:${T.dim2};flex-grow:1;">예치 증거금</div>
      <div style="font-size:14px;font-weight:700;" class="m">${n(MY_RESERVED)}원</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:0 2px 14px;">
      <div style="font-size:12px;color:${T.dim2};flex-grow:1;">남는 현금</div>
      <div style="font-size:12px;color:${T.dim};" class="m">${n(CFG.seedMoney - MY_RESERVED)}원</div>
    </div>

    <div style="height:54px;display:flex;align-items:center;justify-content:center;border-radius:13px;background:${T.accent};color:${T.ink};font-size:16px;font-weight:700;">청약하기</div>
    ${hint('마감되면 단일가로 배정되고, 낙찰 차액과 미배정분은 자동 환불됩니다. 한 종목에 여러 번 낼 수 있습니다.')}
  </div>

</div>`;
fs.writeFileSync(`${OUT}/Ipo.dc.html`, page({ w: 390, h: IPO_H, body: ipoBody }));

/* =======================================================================
   4) 전체 시황 — Main.dc.html
   ======================================================================= */
const MARKET_H = 1790;

const bonusQty = Object.keys(hold).reduce((a, c) => a + (hold[c] - boughtQty[c]), 0);

const marketRow = (s) => `<div style="display:flex;align-items:center;gap:10px;height:66px;padding:0 16px;border-bottom:1px solid ${T.line};">
      ${dot(s.color, 9)}
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:15px;font-weight:600;color:${T.text};">${s.name}</div>
        <div style="font-size:11px;color:${T.dim2};margin-top:3px;" class="m">적정 ${n(s.fair)}</div>
      </div>
      <div style="margin-right:2px;">${fairBadge(s.vsFairPct)}</div>
      <div style="width:84px;text-align:right;">
        <div style="font-size:16px;font-weight:700;color:${T.text};" class="m">${n(s.last)}</div>
        <div style="font-size:12px;font-weight:600;color:${col(s.changePct)};margin-top:3px;" class="m">${pct(s.changePct)}</div>
      </div>
    </div>`;

const rankRow = (p) => `<div style="display:flex;align-items:center;gap:12px;height:56px;padding:0 16px 0 ${p.me ? '14px' : '16px'};background:${p.me ? accTint : 'transparent'};border-left:${p.me ? `2px solid ${T.accent}` : 'none'};border-bottom:1px solid ${T.line};">
      <div style="width:26px;height:26px;border-radius:8px;background:${p.rank === 1 ? T.accent : T.surf3};color:${p.rank === 1 ? T.ink : (p.rank <= 3 ? T.dim : T.dim2)};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;" class="m">${p.rank}</div>
      <div style="flex-grow:1;display:flex;align-items:center;gap:7px;min-width:0;">
        <div style="font-size:14px;font-weight:${p.me ? 700 : 500};color:${T.text};">${p.name}</div>
        ${p.me ? `<div style="height:19px;padding:0 6px;border-radius:5px;background:${T.accent};color:${T.ink};font-size:10px;font-weight:700;display:flex;align-items:center;">나</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:14px;font-weight:600;color:${T.text};" class="m">${n(p.nav)}</div>
        <div style="font-size:11px;font-weight:600;color:${p.pnlPct === 0 ? T.dim2 : col(p.pnlPct)};margin-top:1px;" class="m">${pct(p.pnlPct)}</div>
      </div>
    </div>`;

const navItem = (icon, text, on) => `<div style="flex-grow:1;height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;">
        ${icon}
        <div style="font-size:10px;font-weight:${on ? 700 : 500};color:${on ? T.accent : T.dim2};">${text}</div>
      </div>`;

const sortChip = (t, on) => `<div style="height:28px;padding:0 10px;border-radius:8px;background:${on ? T.surf3 : 'transparent'};border:1px solid ${on ? T.line2 : T.line};color:${on ? T.text : T.dim2};font-size:11px;font-weight:${on ? 600 : 500};display:flex;align-items:center;">${t}</div>`;

const sortedStocks = [...STOCKS].sort((a, b) => b.changePct - a.changePct);

const assetCard = `<div style="background:${T.surf};border:1px solid ${T.line};border-radius:14px;padding:14px 16px 0;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="flex-grow:1;font-size:12px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;">내 총자산</div>
        <div style="height:22px;padding:0 8px;border-radius:6px;background:${accTint};color:${T.accent};font-size:11px;font-weight:700;display:flex;align-items:center;" class="m">${RANKING.find((p) => p.me).rank}위 / ${HUMANS}명</div>
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:6px;">
        <div style="font-size:28px;font-weight:700;color:${T.text};letter-spacing:-0.02em;" class="m">${n(ME.nav)}</div>
        <div style="font-size:14px;color:${T.dim};">원</div>
      </div>
      <div style="display:flex;align-items:baseline;gap:7px;margin-top:3px;">
        <div style="font-size:13px;font-weight:600;color:${col(ME.pnl)};" class="m">${signed(ME.pnl)} (${pct(ME.pnlPct)})</div>
        <div style="font-size:11px;color:${T.dim2};">누적 투입 ${n(ME.invested)} 대비</div>
      </div>

      <div style="height:1px;background:${T.line};margin-top:14px;"></div>
      <div style="display:flex;flex-wrap:wrap;">
        ${[['현금', n(ME.cash), T.text], ['묶인 현금', n(ME.lockedCash), T.dim], ['평가금액', n(ME.evalTotal), T.text], ['실현손익', signed(ME.realized), col(ME.realized)]]
          .map(([k, v, c]) => `<div style="width:50%;padding:11px 0;">
          <div style="font-size:11px;color:${T.dim2};">${k}</div>
          <div style="font-size:13px;font-weight:600;color:${c};margin-top:3px;" class="m">${v}</div>
        </div>`).join('\n        ')}
      </div>

      <div style="height:1px;background:${T.line};"></div>
      <div style="display:flex;align-items:center;gap:8px;padding:12px 0 10px;">
        <div style="flex-grow:1;font-size:11px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;">분당 정산 · ${SALARY_TICKS}회</div>
        <div style="height:20px;padding:0 7px;border-radius:5px;background:${T.surf3};color:${T.dim};font-size:10px;font-weight:600;display:flex;align-items:center;" class="m">다음 ${mmss(NEXT_TICK_IN)}</div>
      </div>
      <div style="display:flex;gap:8px;padding-bottom:14px;">
        <div style="flex-grow:1;background:${accTint};border-radius:10px;padding:10px 12px;">
          <div style="font-size:11px;color:${T.dim2};">월급 · ${n(CFG.salaryAmount)}/분</div>
          <div style="font-size:14px;font-weight:700;color:${T.accent};margin-top:3px;" class="m">${signed(ME.salaryTotal)}</div>
        </div>
        <div style="flex-grow:1;background:${accTint};border-radius:10px;padding:10px 12px;">
          <div style="font-size:11px;color:${T.dim2};">무상증자 · 최대 ${CFG.maxBonusRate * 100}%</div>
          <div style="font-size:14px;font-weight:700;color:${T.accent};margin-top:3px;" class="m">+${bonusQty}주</div>
        </div>
      </div>
    </div>`;

const marketBody = `<div style="width:390px;min-height:${MARKET_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  <div style="padding:14px 16px 0;border-bottom:1px solid ${T.line};">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="flex-grow:1;font-size:15px;font-weight:600;color:${T.text};">동문회 챌린지</div>
      <div style="display:flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:6px;background:${upTint};">
        <div style="width:6px;height:6px;border-radius:3px;background:${T.up};"></div>
        <div style="font-size:10px;font-weight:700;color:${T.up};letter-spacing:0.06em;">LIVE</div>
      </div>
      <div style="font-size:11px;color:${T.dim2};" class="m">SSE 400ms</div>
    </div>
    <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px;">
      <div style="font-size:34px;font-weight:700;color:${T.text};letter-spacing:-0.02em;" class="m">${clock(REMAIN)}</div>
      <div style="font-size:13px;color:${T.dim};">남음</div>
      <div style="flex-grow:1;"></div>
      <div style="font-size:12px;color:${T.dim2};">${CFG.durationMin}분 판 · 사람 ${HUMANS} + 봇 ${CFG.botCount}</div>
    </div>
    <div style="height:3px;border-radius:2px;background:${T.surf3};margin:12px 0 14px;display:flex;">
      <div style="width:${Math.round(ELAPSED / (CFG.durationMin * 60) * 100)}%;background:${T.accent};border-radius:2px;"></div>
    </div>
  </div>

  <div style="padding:14px 16px 0;">${assetCard}</div>

  <div style="padding:22px 16px 10px;">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">전체 종목 <span style="color:${T.dim2};font-weight:500;">${STOCK_COUNT}</span></div>
      <div style="display:flex;gap:6px;">
        ${sortChip('등락률순', true)}
        ${sortChip('괴리율순', false)}
      </div>
    </div>
    ${hint(`인플레로 적정가가 분당 ${CFG.inflationPerMin * 100}%씩 오릅니다. <b style="color:${T.dim};">전 종목이 상승이라 등락률만으로는 판단이 안 됩니다</b> — 적정가 대비 괴리율을 같이 보세요.`)}
  </div>

  <div style="border-top:1px solid ${T.line};">
    ${sortedStocks.map(marketRow).join('\n    ')}
  </div>

  <div style="display:flex;align-items:center;gap:8px;padding:22px 16px 10px;">
    <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">사람 순위 <span style="color:${T.dim2};font-weight:500;font-size:11px;">봇 제외 · 누적 투입 대비</span></div>
  </div>

  <div style="border-top:1px solid ${T.line};">
    ${RANKING.map(rankRow).join('\n    ')}
  </div>

  <div style="flex-grow:1;"></div>

  <div style="display:flex;border-top:1px solid ${T.line};background:${T.surf};padding:4px 0 8px;">
      ${navItem(icoPulse(T.accent), '시황', true)}
      ${navItem(icoWallet(T.dim2), '내 자산', false)}
      ${navItem(icoInfo(T.dim2), '방 정보', false)}
  </div>

</div>`;
fs.writeFileSync(`${OUT}/Main.dc.html`, page({ w: 390, h: MARKET_H, body: marketBody }));

/* =======================================================================
   5·6) 개별 종목 — 호가 탭 / 차트 탭
   ======================================================================= */
const FOCUS = byCode.HYU;
const ORDER_PRICE = 2800, ORDER_QTY_INPUT = 100;
const maxBuyQty = Math.floor(ME.cash / (FOCUS.last * (1 + CFG.feeRate)) / CFG.lotSize) * CFG.lotSize;
const orderAmount = ORDER_QTY_INPUT * FOCUS.last;
const orderFee = fee(orderAmount);

// 서버 depth 배열 — 값이 없는 호가는 아예 오지 않는다(= 사다리에 빈 칸이 생긴다)
const DEPTH = {
  asks: [{ p: 2860, q: 120 }, { p: 2870, q: 80 }, { p: 2890, q: 240 }, { p: 2900, q: 60 }, { p: 2930, q: 310 }, { p: 2940, q: 90 }, { p: 2950, q: 150 }],
  bids: [{ p: 2850, q: 180 }, { p: 2840, q: 260 }, { p: 2830, q: 90 }, { p: 2810, q: 410 }, { p: 2800, q: 120, mine: 60 }, { p: 2790, q: 70 }, { p: 2780, q: 330 }, { p: 2760, q: 150 }],
};
const askTotal = DEPTH.asks.reduce((a, x) => a + x.q, 0);
const bidTotal = DEPTH.bids.reduce((a, x) => a + x.q, 0);
const maxQ = Math.max(...DEPTH.asks.map((x) => x.q), ...DEPTH.bids.map((x) => x.q));
for (const x of [...DEPTH.asks, ...DEPTH.bids]) {
  if (!onTick(x.p)) problems.push(`호가 ${x.p} 가 호가단위 배수가 아님`);
  if (x.q % CFG.lotSize !== 0) problems.push(`잔량 ${x.q} 가 lotSize 배수가 아님`);
}
if (DEPTH.bids[0].p !== FOCUS.last) problems.push('최우선 매수호가와 현재가가 다름');

const QTY_W = 127;          // 좌우 잔량 셀 폭 — 같아야 막대 길이를 비교할 수 있다
const LADDER_STEP = tickSize(FOCUS.last);
const askLadder = Array.from({ length: 10 }, (_, i) => FOCUS.last + (10 - i) * LADDER_STEP);
const bidLadder = Array.from({ length: 10 }, (_, i) => FOCUS.last - i * LADDER_STEP);
const findQ = (arr, p) => arr.find((x) => x.p === p);

const priceCell = (p, side, best) => `<div style="width:104px;height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${best ? upTint : T.surf};border-left:1px solid ${best ? T.up : T.line};border-right:1px solid ${T.line};">
          <div style="font-size:14px;font-weight:${best ? 700 : 600};color:${side === 'ask' ? T.down : T.up};" class="m">${n(p)}</div>
          <div style="font-size:9px;color:${T.dim2};" class="m">${pct((p / FOCUS.open - 1) * 100)}</div>
        </div>`;

const askRow = (p) => {
  const e = findQ(DEPTH.asks, p);
  const w = e ? e.q / maxQ * 100 : 0;
  return `<div style="display:flex;align-items:center;height:44px;border-bottom:1px solid ${T.line};">
        <div style="width:${QTY_W}px;height:44px;position:relative;display:flex;align-items:center;justify-content:flex-end;padding-right:12px;box-sizing:border-box;">
          ${e ? `<div style="position:absolute;right:0;top:6px;height:32px;width:${w.toFixed(1)}%;background:${downTint};border-radius:3px 0 0 3px;"></div>
          <div style="position:relative;font-size:13px;color:${T.dim};" class="m">${n(e.q)}</div>` : ''}
        </div>
        ${priceCell(p, 'ask', false)}
        <div style="flex-grow:1;"></div>
      </div>`;
};

const bidRow = (p, i) => {
  const e = findQ(DEPTH.bids, p);
  const w = e ? e.q / maxQ * 100 : 0;
  return `<div style="display:flex;align-items:center;height:44px;border-bottom:1px solid ${T.line};">
        <div style="width:${QTY_W}px;"></div>
        ${priceCell(p, 'bid', i === 0)}
        <div style="width:${QTY_W}px;height:44px;position:relative;display:flex;align-items:center;gap:7px;padding-left:12px;box-sizing:border-box;">
          ${e ? `<div style="position:absolute;left:0;top:6px;height:32px;width:${w.toFixed(1)}%;background:${upTint};border-radius:0 3px 3px 0;"></div>
          <div style="position:relative;font-size:13px;color:${T.dim};" class="m">${n(e.q)}</div>
          ${e.mine ? `<div style="position:relative;display:flex;align-items:center;height:20px;padding:0 6px;border-radius:5px;background:${T.accent};color:${T.ink};font-size:10px;font-weight:700;" class="m">내 ${e.mine}</div>` : ''}` : ''}
        </div>
      </div>`;
};

const stockHeader = (activeTab) => `${gameHeader(`<span style="display:inline-flex;align-items:center;gap:7px;">${dot(FOCUS.color, 9)}${FOCUS.name}</span>`, timerChip())}

  <div style="display:flex;align-items:flex-end;gap:12px;padding:16px 16px 14px;">
    <div style="flex-grow:1;">
      <div style="display:flex;align-items:baseline;gap:6px;">
        <div style="font-size:32px;font-weight:700;color:${col(FOCUS.changePct)};letter-spacing:-0.02em;" class="m">${n(FOCUS.last)}</div>
        <div style="font-size:14px;color:${T.dim};">원</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:5px;">
        <div style="font-size:14px;font-weight:600;color:${col(FOCUS.changePct)};" class="m">${signed(FOCUS.last - FOCUS.open)}</div>
        <div style="font-size:14px;font-weight:600;color:${col(FOCUS.changePct)};" class="m">${pct(FOCUS.changePct)}</div>
        <div style="font-size:11px;color:${T.dim2};">시초 ${n(FOCUS.open)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:7px;margin-top:8px;">
        ${fairBadge(FOCUS.vsFairPct)}
        <div style="font-size:11px;color:${T.dim2};" class="m">적정가 ${n(FOCUS.fair)}</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${[['고가', n(FOCUS.high), T.up], ['저가', n(FOCUS.low), T.down], ['거래량', n(FOCUS.volume) + '주', T.text]]
        .map(([k, v, c]) => `<div style="text-align:right;">
          <div style="font-size:10px;color:${T.dim2};">${k}</div>
          <div style="font-size:12px;font-weight:600;color:${c};margin-top:2px;" class="m">${v}</div>
        </div>`).join('\n      ')}
    </div>
  </div>

  <div style="display:flex;gap:4px;margin:0 16px 4px;padding:4px;background:${T.surf};border:1px solid ${T.line};border-radius:12px;">
    ${['호가', '차트', '체결'].map((t) => `<div style="flex-grow:1;height:40px;display:flex;align-items:center;justify-content:center;border-radius:9px;background:${t === activeTab ? T.surf3 : 'transparent'};color:${t === activeTab ? T.text : T.dim2};font-size:14px;font-weight:${t === activeTab ? 700 : 500};">${t}</div>`).join('\n    ')}
  </div>`;

const positionCard = `<div style="padding:12px 16px 0;">
    <div style="display:flex;align-items:center;gap:12px;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:14px 16px;">
      <div>
        <div style="font-size:11px;color:${T.dim2};">내 보유</div>
        <div style="font-size:14px;font-weight:600;margin-top:3px;" class="m">${n(ME.holdings[1].qty)}주 · 평단 ${n(ME.holdings[1].avgPrice)}</div>
      </div>
      <div style="flex-grow:1;"></div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:${T.dim2};">평가손익</div>
        <div style="font-size:14px;font-weight:700;color:${col(ME.holdings[1].pnl)};margin-top:3px;" class="m">${signed(ME.holdings[1].pnl)} (${pct(ME.holdings[1].pnlPct)})</div>
      </div>
    </div>
  </div>`;

const openOrderCard = `<div style="padding:10px 16px 0;">
    <div style="display:flex;align-items:center;gap:12px;background:${T.surf};border:1px solid ${T.line2};border-radius:12px;padding:12px 12px 12px 16px;">
      <div style="flex-grow:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="height:18px;padding:0 6px;border-radius:4px;background:${upTint};color:${T.up};font-size:10px;font-weight:700;display:flex;align-items:center;">매수</div>
          <div style="font-size:13px;font-weight:600;color:${T.text};" class="m">${n(OPEN_ORDER.price)} × ${OPEN_ORDER.qty}주</div>
        </div>
        <div style="font-size:11px;color:${T.dim2};margin-top:3px;" class="m">100주 중 ${ORDER.filled}주 체결 · ${OPEN_ORDER.qty}주 미체결 · 묶인 현금 ${n(ME.lockedCash)}</div>
      </div>
      <div style="height:40px;padding:0 14px;display:flex;align-items:center;border-radius:10px;border:1px solid ${T.line2};color:${T.dim};font-size:13px;font-weight:600;flex-shrink:0;">취소</div>
    </div>
  </div>`;

const orderPanel = `<div style="border-top:1px solid ${T.line};background:${T.surf};padding:12px 16px 18px;margin-top:14px;">
    <div style="display:flex;gap:4px;padding:4px;background:${T.bg};border:1px solid ${T.line};border-radius:11px;margin-bottom:12px;">
      <div style="flex-grow:1;height:38px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};color:${T.text};font-size:13px;font-weight:700;">지정가</div>
      <div style="flex-grow:1;height:38px;display:flex;align-items:center;justify-content:center;border-radius:8px;color:${T.dim2};font-size:13px;font-weight:500;">시장가</div>
    </div>

    ${[['가격', n(FOCUS.last)], ['수량', String(ORDER_QTY_INPUT)]].map(([k, v], i) => `<div style="display:flex;align-items:center;gap:8px;height:48px;padding:0 6px 0 14px;background:${T.bg};border:1px solid ${T.line2};border-radius:11px;${i ? 'margin-top:8px;' : ''}">
      <div style="font-size:11px;color:${T.dim2};width:32px;">${k}</div>
      <div style="flex-grow:1;text-align:right;font-size:17px;font-weight:700;" class="m">${v}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoMinus(T.dim)}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoPlus(T.text)}</div>
    </div>`).join('\n    ')}

    <div style="display:flex;gap:6px;margin-top:8px;">
      ${['10%', '25%', '50%', `최대 ${maxBuyQty}주`].map((t) => `<div style="height:32px;flex-grow:1;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid ${T.line};color:${T.dim};font-size:11px;font-weight:600;" class="m">${t}</div>`).join('\n      ')}
    </div>

    ${[['주문금액', n(orderAmount) + '원'], ['수수료 ' + (CFG.feeRate * 100).toFixed(2) + '%', n(orderFee) + '원'], ['주문가능', `현금 ${n(ME.cash)}원 · 최대 ${maxBuyQty}주`]]
      .map(([k, v], i) => `<div style="display:flex;align-items:center;gap:8px;margin:${i === 0 ? '14px' : '0'} 2px ${i === 2 ? '14px' : '8px'};">
      <div style="font-size:12px;color:${T.dim2};flex-grow:1;">${k}</div>
      <div style="font-size:${i === 2 ? 12 : 14}px;font-weight:${i === 2 ? 500 : 700};color:${i === 2 ? T.dim : T.text};" class="m">${v}</div>
    </div>`).join('\n    ')}

    <div style="display:flex;gap:10px;">
      <div style="flex-grow:1;height:54px;display:flex;align-items:center;justify-content:center;border-radius:13px;background:${downTint};border:1px solid ${T.down};color:${T.down};font-size:16px;font-weight:700;">매도</div>
      <div style="flex-grow:1;height:54px;display:flex;align-items:center;justify-content:center;border-radius:13px;background:${T.up};color:#FFFFFF;font-size:16px;font-weight:700;">매수</div>
    </div>
    ${hint(`시장가는 반대 호가가 없으면 <span style="color:${T.warn};">NO_COUNTERPARTY</span> 로 실패합니다. 자주 일어나므로 지정가 입력을 항상 옆에 둡니다.`)}
  </div>`;

const STOCK_H = 2010;
const stockBody = `<div style="width:390px;min-height:${STOCK_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">
  ${stockHeader('호가')}

  <div style="display:flex;align-items:center;height:34px;padding:8px 16px 0;">
    <div style="width:${QTY_W - 12}px;text-align:right;font-size:10px;color:${T.dim2};font-weight:600;">매도 잔량</div>
    <div style="width:104px;text-align:center;font-size:10px;color:${T.dim2};font-weight:600;">호가 10단계</div>
    <div style="width:${QTY_W}px;padding-left:12px;box-sizing:border-box;font-size:10px;color:${T.dim2};font-weight:600;">매수 잔량</div>
  </div>

  <div style="padding:0 16px;border-top:1px solid ${T.line};">
      ${askLadder.map(askRow).join('\n      ')}
      <div style="display:flex;align-items:center;justify-content:center;gap:8px;height:28px;background:${T.surf2};border-bottom:1px solid ${T.line};">
        <div style="font-size:10px;color:${T.dim2};">스프레드</div>
        <div style="font-size:11px;font-weight:600;color:${T.dim};" class="m">${DEPTH.asks[0].p - DEPTH.bids[0].p}원 (${((DEPTH.asks[0].p - DEPTH.bids[0].p) / FOCUS.last * 100).toFixed(2)}%)</div>
      </div>
      ${bidLadder.map(bidRow).join('\n      ')}
      <div style="display:flex;align-items:center;height:40px;">
        <div style="width:${QTY_W}px;text-align:right;padding-right:12px;box-sizing:border-box;font-size:12px;font-weight:600;color:${T.down};" class="m">${n(askTotal)}</div>
        <div style="width:104px;text-align:center;font-size:10px;color:${T.dim2};">총잔량</div>
        <div style="width:${QTY_W}px;padding-left:12px;box-sizing:border-box;font-size:12px;font-weight:600;color:${T.up};" class="m">${n(bidTotal)}</div>
      </div>
  </div>

  <div style="padding:0 16px;">${hint('빈 칸은 그 가격에 주문이 없다는 뜻입니다. 서버 depth 는 값이 있는 호가만 보내고, 매도 호가는 전체 시간의 약 20% 동안 비어 있습니다 — 정상입니다.')}</div>

  ${openOrderCard}
  ${positionCard}
  <div style="flex-grow:1;"></div>
  ${orderPanel}
</div>`;
fs.writeFileSync(`${OUT}/Stock.dc.html`, page({ w: 390, h: STOCK_H, body: stockBody }));

/* ---- 차트 탭 ---- */
const CW = 358, CHH = 200;
const rndc = mulberry32(77031);
const pts = [];
const anchors = [[0, 1865], [90, 1980], [170, 2120], [240, 2050], [310, 2380], [380, 2620], [430, 2900], [482, FOCUS.last]];
for (let t = 0; t <= ELAPSED; t += 4) {
  let a = anchors[0], b = anchors[anchors.length - 1];
  for (let k = 0; k < anchors.length - 1; k++) if (t >= anchors[k][0] && t <= anchors[k + 1][0]) { a = anchors[k]; b = anchors[k + 1]; break; }
  const u = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  let v = a[1] + (b[1] - a[1]) * u;
  if (t !== 0 && t < ELAPSED) v += (rndc() - 0.5) * v * 0.016;
  pts.push({ t, price: Math.min(FOCUS.high, Math.max(FOCUS.low, Math.round(v / 10) * 10)) });
}
pts[pts.length - 1] = { t: ELAPSED, price: FOCUS.last };
const fairAt = (t) => FOCUS.init * Math.pow(FOCUS.fair / FOCUS.init, t / ELAPSED);
const yLo = Math.min(FOCUS.low, FOCUS.init) * 0.99, yHi = Math.max(FOCUS.high, FOCUS.fair) * 1.01;
const px = (t) => (t / ELAPSED) * CW;
const py = (v) => (yHi - v) / (yHi - yLo) * CHH;
const linePts = pts.map((p) => `${px(p.t).toFixed(1)},${py(p.price).toFixed(1)}`).join(' ');
const fairPts = pts.map((p) => `${px(p.t).toFixed(1)},${py(fairAt(p.t)).toFixed(1)}`).join(' ');

const CHART_H = 1465;
const chartBody = `<div style="width:390px;min-height:${CHART_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">
  ${stockHeader('차트')}

  <div style="padding:14px 16px 0;">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:6px;"><div style="width:14px;height:2px;background:${T.up};"></div><div style="font-size:11px;color:${T.dim};">체결가</div></div>
      <div style="display:flex;align-items:center;gap:6px;"><div style="width:14px;height:0;border-top:2px dashed ${T.warn};"></div><div style="font-size:11px;color:${T.dim};">적정가 (인플레 ${CFG.inflationPerMin * 100}%/분)</div></div>
      <div style="flex-grow:1;"></div>
      <div style="font-size:10px;color:${T.dim2};" class="m">1초 1점</div>
    </div>
    <div style="position:relative;width:${CW}px;height:${CHH + 22}px;">
      <svg width="${CW}" height="${CHH}" viewBox="0 0 ${CW} ${CHH}" fill="none" style="position:absolute;left:0;top:0;">
        <line x1="0" y1="${py(FOCUS.open).toFixed(1)}" x2="${CW}" y2="${py(FOCUS.open).toFixed(1)}" stroke="${T.line2}" stroke-width="1"></line>
        <polyline points="${fairPts}" stroke="${T.warn}" stroke-width="1.6" stroke-dasharray="5 4" stroke-linejoin="round"></polyline>
        <polyline points="${linePts}" stroke="${T.up}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"></polyline>
      </svg>
      <div style="position:absolute;left:0;top:${(py(FOCUS.open) - 14).toFixed(1)}px;font-size:10px;color:${T.dim2};background:${T.bg};padding:0 3px;" class="m">시초 ${n(FOCUS.open)}</div>
      <div style="position:absolute;right:0;top:${(py(FOCUS.last) - 9).toFixed(1)}px;height:18px;padding:0 5px;border-radius:4px;background:${T.up};color:#FFFFFF;font-size:10px;font-weight:700;display:flex;align-items:center;" class="m">${n(FOCUS.last)}</div>
      <div style="position:absolute;right:0;top:${(py(FOCUS.fair) - 9).toFixed(1)}px;height:18px;padding:0 5px;border-radius:4px;background:${T.warn};color:${T.ink};font-size:10px;font-weight:700;display:flex;align-items:center;" class="m">${n(FOCUS.fair)}</div>
      ${[0, 120, 240, 360, 480].map((t, i, arr) => {
        const lastOne = i === arr.length - 1;
        return `<div style="position:absolute;${lastOne ? 'right:0' : `left:${px(t).toFixed(1)}px`};top:${CHH + 6}px;font-size:9px;color:${T.dim2};" class="m">+${mmss(t)}</div>`;
      }).join('\n      ')}
    </div>
    ${hint(`체결가가 적정가 아래면 저평가, 위면 거품입니다. 지금은 적정가보다 ${pct1(FOCUS.vsFairPct)} 입니다.`)}
  </div>

  <div style="display:flex;align-items:center;gap:8px;padding:20px 16px 8px;">
    <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">최근 체결</div>
    <div style="font-size:11px;color:${T.dim2};" class="m">최대 40건</div>
  </div>
  <div style="border-top:1px solid ${T.line};">
    ${[[482, 2850, 40, 'buy'], [479, 2850, 20, 'buy'], [476, 2840, 60, 'sell'], [471, 2840, 10, 'sell'], [468, 2850, 90, 'buy'], [463, 2860, 30, 'buy'], [459, 2850, 50, 'sell'], [452, 2840, 20, 'sell']]
      .map(([t, p, q, side]) => `<div style="display:flex;align-items:center;gap:12px;height:40px;padding:0 16px;border-bottom:1px solid ${T.line};">
      <div style="width:52px;font-size:11px;color:${T.dim2};" class="m">+${mmss(t)}</div>
      <div style="flex-grow:1;font-size:13px;font-weight:600;color:${side === 'buy' ? T.up : T.down};" class="m">${n(p)}</div>
      <div style="width:70px;text-align:right;font-size:12px;color:${T.dim};" class="m">${q}주</div>
      <div style="width:34px;text-align:right;font-size:11px;font-weight:600;color:${side === 'buy' ? T.up : T.down};">${side === 'buy' ? '매수' : '매도'}</div>
    </div>`).join('\n    ')}
  </div>
  <div style="padding:0 16px;">${hint('side 는 체결을 일으킨 쪽입니다. 매수면 상승 체결.')}</div>

  <div style="flex-grow:1;"></div>
  ${orderPanel}
</div>`;
fs.writeFileSync(`${OUT}/Chart.dc.html`, page({ w: 390, h: CHART_H, body: chartBody }));

/* =======================================================================
   7) 월급·무상증자 + 체결 팝업 — Notice.dc.html  (개별 종목 위 오버레이)
   ======================================================================= */
const BONUS_AT_LAST_TICK = lastBonus.map((b) => ({ name: byCode[b.code].name, add: b.add }));
const FILL = { qty: ORDER.filled, price: ORDER.price, amount: ORDER.filled * ORDER.price };
FILL.fee = fee(FILL.amount);

const toast = (bottom, accentBorder, inner) => `<div style="position:absolute;left:16px;bottom:${bottom}px;width:358px;box-sizing:border-box;background:${T.surf2};border:1px solid ${accentBorder};border-radius:16px;padding:14px 16px;box-shadow:0 18px 44px rgba(0,0,0,0.55);">${inner}</div>`;

const fillToast = toast(455, 'rgba(255,77,94,0.35)', `
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:34px;height:34px;flex-shrink:0;border-radius:10px;background:${upTint};display:flex;align-items:center;justify-content:center;">${icoCheck(T.up, 18)}</div>
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:14px;font-weight:700;color:${T.text};">매수 체결 · ${FOCUS.name}</div>
        <div style="font-size:11px;color:${T.dim2};margin-top:2px;" class="m">${n(FILL.price)} × ${FILL.qty}주 · 수수료 ${n(FILL.fee)} · 잔여 ${OPEN_ORDER.qty}주 미체결</div>
      </div>
      <div style="font-size:17px;font-weight:700;color:${T.up};" class="m">${signed(-(FILL.amount + FILL.fee))}</div>
    </div>`);

const salaryToast = toast(537, 'rgba(198,242,78,0.35)', `
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:34px;height:34px;flex-shrink:0;border-radius:10px;background:${accTint};display:flex;align-items:center;justify-content:center;">${icoWallet(T.accent, 19)}</div>
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:14px;font-weight:700;color:${T.text};">월급 입금 · ${SALARY_TICKS}분차</div>
        <div style="font-size:11px;color:${T.dim2};margin-top:2px;">다음 지급까지 ${mmss(NEXT_TICK_IN)}</div>
      </div>
      <div style="font-size:19px;font-weight:700;color:${T.accent};" class="m">${signed(CFG.salaryAmount)}</div>
    </div>
    <div style="height:1px;background:${T.line};margin:12px 0 10px;"></div>
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="flex-shrink:0;">${icoGift(T.accent, 16)}</div>
      <div style="flex-grow:1;font-size:11px;color:${T.dim2};">무상증자 ${CFG.maxBonusRate * 100}%</div>
      <div style="font-size:13px;font-weight:700;color:${T.accent};white-space:nowrap;" class="m">${BONUS_AT_LAST_TICK.map((b) => `${b.name} +${b.add}`).join(' · ')}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:7px;">
      <div style="flex-grow:1;font-size:11px;color:${T.dim2};">인플레는 현금을 깎지 않습니다 — 적정가가 ${CFG.inflationPerMin * 100}% 올랐습니다</div>
    </div>
    <div style="height:3px;border-radius:2px;background:${T.surf3};margin-top:12px;display:flex;">
      <div style="width:38%;background:${T.accent};border-radius:2px;"></div>
    </div>`);

fs.writeFileSync(`${OUT}/Notice.dc.html`, page({
  w: 390, h: STOCK_H,
  body: `<div style="position:relative;width:390px;height:${STOCK_H}px;overflow:hidden;">
  ${stockBody}
  ${salaryToast}
  ${fillToast}
</div>`,
}));

/* =======================================================================
   8) 돌발 뉴스 팝업 — News.dc.html  (전체 시황 위 오버레이)
   ======================================================================= */
const NEWS_STOCK = byCode.KHU;
const newsModal = `<div style="position:absolute;left:0;top:0;width:390px;height:${MARKET_H}px;background:rgba(4,6,9,0.80);"></div>
  <div style="position:absolute;left:16px;top:210px;width:358px;box-sizing:border-box;background:${T.surf};border:1px solid ${T.line2};border-radius:20px;padding:20px;box-shadow:0 28px 70px rgba(0,0,0,0.65);">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="display:flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border-radius:7px;background:${upTint};">
        ${icoBolt(T.up, 14)}
        <div style="font-size:11px;font-weight:700;color:${T.up};letter-spacing:0.04em;">돌발 뉴스</div>
      </div>
      <div style="flex-grow:1;"></div>
      <div style="font-size:11px;color:${T.dim2};" class="m">${clock(REMAIN)} 남음</div>
    </div>

    <div style="font-size:20px;font-weight:700;color:${T.text};line-height:1.4;margin-top:14px;letter-spacing:-0.01em;text-wrap:pretty;">${NEWS_STOCK.name}, 내년 신입생 정원 대폭 확대 확정</div>

    <div style="display:flex;align-items:center;gap:12px;margin-top:16px;padding:12px 14px;background:${T.bg};border:1px solid ${T.line};border-radius:12px;">
      ${dot(NEWS_STOCK.color, 9)}
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:14px;font-weight:600;color:${T.text};">${NEWS_STOCK.name}</div>
        <div style="margin-top:4px;">${fairBadge(NEWS_STOCK.vsFairPct)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:16px;font-weight:700;color:${T.text};" class="m">${n(NEWS_STOCK.last)}</div>
        <div style="font-size:12px;font-weight:600;color:${col(NEWS_STOCK.changePct)};margin-top:2px;" class="m">${pct(NEWS_STOCK.changePct)}</div>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-top:16px;">
      <div style="width:90px;height:50px;display:flex;align-items:center;justify-content:center;border-radius:13px;border:1px solid ${T.line2};color:${T.dim};font-size:15px;font-weight:600;">닫기</div>
      <div style="flex-grow:1;height:50px;display:flex;align-items:center;justify-content:center;border-radius:13px;background:${T.accent};color:${T.ink};font-size:15px;font-weight:700;">${NEWS_STOCK.name} 보러가기</div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin-top:14px;">
      <div style="flex-grow:1;height:3px;border-radius:2px;background:${T.surf3};display:flex;">
        <div style="width:62%;background:${T.dim2};border-radius:2px;"></div>
      </div>
      <div style="font-size:10px;color:${T.dim2};" class="m">3초 후 닫힘</div>
    </div>
  </div>`;

fs.writeFileSync(`${OUT}/News.dc.html`, page({
  w: 390, h: MARKET_H,
  body: `<div style="position:relative;width:390px;height:${MARKET_H}px;overflow:hidden;">
  ${marketBody}
  ${newsModal}
</div>`,
}));

/* =======================================================================
   9) 결과 — Result.dc.html
   ======================================================================= */
const RESULT_H = 1620;
const feesCollected = Math.round(STOCKS.reduce((a, s) => a + s.volume * (s.open + s.last) / 2, 0) * CFG.feeRate * 2);
const winner = RANKING[0];

const resultBody = `<div style="width:390px;min-height:${RESULT_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  ${gameHeader('게임 종료', `<div style="font-size:12px;color:${T.dim2};" class="m">${CFG.durationMin}분 · 사람 ${HUMANS} + 봇 ${CFG.botCount}</div>`)}

  <div style="padding:20px 16px 0;">
    <div style="background:${T.surf};border:1px solid ${T.accent};border-radius:18px;padding:22px 20px;text-align:center;">
      <div style="display:flex;justify-content:center;">${icoTrophy(T.accent, 32)}</div>
      <div style="font-size:12px;color:${T.dim2};font-weight:600;letter-spacing:0.04em;margin-top:10px;">우승</div>
      <div style="font-size:26px;font-weight:700;color:${T.text};margin-top:4px;">${winner.name}</div>
      <div style="display:flex;align-items:baseline;justify-content:center;gap:8px;margin-top:8px;">
        <div style="font-size:20px;font-weight:700;color:${T.text};" class="m">${n(winner.nav)}원</div>
        <div style="font-size:15px;font-weight:700;color:${col(winner.pnlPct)};" class="m">${pct(winner.pnlPct)}</div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:8px;padding:22px 16px 10px;">
    <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">사람 순위</div>
    <div style="font-size:11px;color:${T.dim2};">humanRanking · 봇 제외</div>
  </div>
  <div style="border-top:1px solid ${T.line};">
    ${RANKING.map((p) => `<div style="display:flex;align-items:center;gap:12px;height:60px;padding:0 16px 0 ${p.me ? '14px' : '16px'};background:${p.me ? accTint : 'transparent'};border-left:${p.me ? `2px solid ${T.accent}` : 'none'};border-bottom:1px solid ${T.line};">
      <div style="width:28px;height:28px;border-radius:9px;background:${p.rank === 1 ? T.accent : T.surf3};color:${p.rank === 1 ? T.ink : T.dim};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;" class="m">${p.rank}</div>
      <div style="flex-grow:1;display:flex;align-items:center;gap:7px;min-width:0;">
        <div style="font-size:15px;font-weight:${p.me ? 700 : 500};color:${T.text};">${p.name}</div>
        ${p.me ? `<div style="height:19px;padding:0 6px;border-radius:5px;background:${T.accent};color:${T.ink};font-size:10px;font-weight:700;display:flex;align-items:center;">나</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:15px;font-weight:600;color:${T.text};" class="m">${n(p.nav)}</div>
        <div style="font-size:11px;font-weight:600;color:${p.pnlPct === 0 ? T.dim2 : col(p.pnlPct)};margin-top:2px;" class="m">${signed(p.pnl)} · ${pct(p.pnlPct)}</div>
      </div>
    </div>`).join('\n    ')}
  </div>
  <div style="padding:0 16px;">${hint(`전원 누적 투입 ${n(ME.invested)}원(시드 ${n(CFG.seedMoney)} + 월급 ${SALARY_TICKS}회) 기준입니다. 최하위는 청약도 매매도 하지 않아 정확히 0%입니다 — 인플레가 현금을 깎지 않으므로 손실은 없지만, 오른 값도 못 탑니다.`)}</div>

  <div style="display:flex;align-items:center;gap:8px;padding:22px 16px 10px;">
    <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">종목 결과</div>
  </div>
  <div style="border-top:1px solid ${T.line};">
    ${[...STOCKS].sort((a, b) => b.changePct - a.changePct).map((s) => `<div style="display:flex;align-items:center;gap:10px;height:64px;padding:0 16px;border-bottom:1px solid ${T.line};">
      ${dot(s.color, 9)}
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:14px;font-weight:600;color:${T.text};">${s.name}</div>
        <div style="font-size:10px;color:${T.dim2};margin-top:3px;white-space:nowrap;" class="m">시초 ${n(s.open)} · 고 ${n(s.high)} · 저 ${n(s.low)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:14px;font-weight:700;color:${T.text};" class="m">${n(s.last)}</div>
        <div style="font-size:11px;font-weight:600;color:${col(s.changePct)};margin-top:2px;" class="m">${pct(s.changePct)}</div>
      </div>
      <div style="width:72px;text-align:right;">
        <div style="font-size:10px;color:${T.dim2};" class="m">거래 ${n(s.volume)}</div>
        <div style="font-size:10px;color:${T.dim2};margin-top:4px;" class="m">발행 ${n(s.issued)}</div>
      </div>
    </div>`).join('\n    ')}
  </div>

  <div style="display:flex;align-items:center;gap:8px;padding:16px 16px 0;">
    <div style="flex-grow:1;font-size:12px;color:${T.dim2};">거둬진 수수료 합계</div>
    <div style="font-size:13px;font-weight:600;color:${T.dim};" class="m">${n(feesCollected)}원</div>
  </div>

  <div style="flex-grow:1;"></div>

  <div style="padding:12px 16px 20px;border-top:1px solid ${T.line};background:${T.bg};display:flex;gap:10px;">
    <div style="width:120px;height:54px;display:flex;align-items:center;justify-content:center;border-radius:14px;border:1px solid ${T.line2};color:${T.dim};font-size:15px;font-weight:600;">나가기</div>
    <div style="flex-grow:1;height:54px;display:flex;align-items:center;justify-content:center;border-radius:14px;background:${T.accent};color:${T.ink};font-size:16px;font-weight:700;">같은 설정으로 다시</div>
  </div>

</div>`;
fs.writeFileSync(`${OUT}/Result.dc.html`, page({ w: 390, h: RESULT_H, body: resultBody }));

/* =======================================================================
   canvas.json
   ======================================================================= */
const R1 = 0, R2 = 1700, R3 = 4000;
const canvas = {
  artboards: [
    { file: 'Room.dc.html', title: '1 · 방 만들기', x: 0, y: R1, w: 390, h: ROOM_H },
    { file: 'Lobby.dc.html', title: '2 · 대기실', x: 510, y: R1, w: 390, h: LOBBY_H },
    { file: 'Ipo.dc.html', title: '3 · 개장 공모', x: 1020, y: R1, w: 390, h: IPO_H },
    { file: 'Main.dc.html', title: '4 · 전체 시황', x: 0, y: R2, w: 390, h: MARKET_H },
    { file: 'Stock.dc.html', title: '5 · 개별 종목 · 호가', x: 510, y: R2, w: 390, h: STOCK_H },
    { file: 'Chart.dc.html', title: '6 · 개별 종목 · 차트', x: 1020, y: R2, w: 390, h: CHART_H },
    { file: 'Notice.dc.html', title: '7 · 월급·증자·체결 팝업', x: 0, y: R3, w: 390, h: STOCK_H },
    { file: 'News.dc.html', title: '8 · 돌발 뉴스 팝업', x: 510, y: R3, w: 390, h: MARKET_H },
    { file: 'Result.dc.html', title: '9 · 결과', x: 1020, y: R3, w: 390, h: RESULT_H },
  ],
  annotations: [
    { id: 'note-flow1', x: 0, y: R1 - 200, w: 390, text: '방장이 10개 대학 중 참여 종목과 규칙을 정한다.\n종목 목록은 GET /api/meta 의 stockPool 을 그대로 쓴다 — 화면에 하드코딩하지 않는다.' },
    { id: 'note-flow2', x: 510, y: R1 - 200, w: 390, text: '참가코드 6자로 사람이 들어온다. 시작하면 난입 불가(409 ALREADY_STARTED).\n봇은 방을 만들 때 정한 수만큼 자동으로 참가한다.' },
    { id: 'note-flow3', x: 1020, y: R1 - 200, w: 390, text: '전원 주식 0주로 시작한다. 45초 안에 청약하지 않으면 끝까지 0주.\n무상증자를 한 주도 못 받아 수익률이 정확히 0%로 고정된다 — 이 화면의 경고가 게임의 승패를 가른다.' },
    { id: 'note-flow4', x: 0, y: R2 - 200, w: 390, text: '인플레가 적정가를 분당 5% 올리므로 전 종목이 상승한다.\n등락률만으로는 판단이 안 되고, 적정가 대비 괴리율(vsFairPct)이 실제 신호다.' },
    { id: 'note-flow5', x: 510, y: R2 - 200, w: 390, text: '호가 10단계. 서버 depth 는 값이 있는 호가만 보내므로 사다리에 빈 칸이 생긴다.\n매도 호가는 전체 시간의 약 20% 동안 비어 있다 — 빈 상태가 정상이다.' },
    { id: 'note-flow6', x: 1020, y: R2 - 200, w: 390, text: 'GET /chart 의 history 를 체결가·적정가 두 선으로 그린다.\n두 선의 간격이 곧 거품의 크기다.' },
    { id: 'note-flow7', x: 0, y: R3 - 200, w: 390, text: '토스트는 아래에서 쌓인다. 위가 오래된 것(월급·증자), 아래가 최신(체결).\n둘 다 딤 없이 거래를 막지 않는다. me.newFills 는 직전 전송 이후 신규분만 오므로 그대로 띄우면 중복이 없다.' },
    { id: 'note-flow8', x: 510, y: R3 - 200, w: 390, text: '돌발 뉴스만 딤 + 모달로 화면을 막는다. 판당 2~3회뿐이고 즉시 반응해야 하므로.\n※ 서버에 아직 없는 기능이다 — notices 에 news kind 와 해당 종목 fair 충격 이벤트가 필요하다.' },
    { id: 'note-flow9', x: 1020, y: R3 - 200, w: 390, text: '시상은 humanRanking(봇 제외)으로 한다.\n최하위가 정확히 0%인 것이 이 게임의 성질이다 — 인플레가 현금을 깎지 않으므로 잃지는 않지만, 아무것도 안 하면 전원에게 뒤처진다.' },
  ],
  launch: { view: 'canvas' },
};
fs.writeFileSync(`${OUT}/canvas.json`, JSON.stringify(canvas, null, 2));

/* ---------- 화면 간 인원수 일치 ---------- */
if (LOBBY_PLAYERS.length !== HUMANS) problems.push(`대기실 참가자 ${LOBBY_PLAYERS.length}명 ≠ HUMANS ${HUMANS}`);
if (RANKING.length !== HUMANS) problems.push(`순위 ${RANKING.length}명 ≠ HUMANS ${HUMANS}`);
if (STOCK_COUNT !== Object.keys(IPO_DEMAND).length) problems.push('공모 수요 종목 수가 STOCKS 와 다름');

/* ---------- 결과 보고 ---------- */
if (problems.length) {
  console.error('무결성 실패:');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}
console.log('artboards:', fs.readdirSync(OUT).filter((f) => f.endsWith('.dc.html')).join(', '));
console.log(`나: 현금 ${n(ME.cash)} + 묶임 ${n(ME.lockedCash)} + 평가 ${n(ME.evalTotal)} = ${n(ME.nav)} / 투입 ${n(ME.invested)} → ${signed(ME.pnl)} ${pct(ME.pnlPct)}`);
console.log(`남은 ${clock(REMAIN)} · 월급 ${SALARY_TICKS}회 · 다음 ${mmss(NEXT_TICK_IN)} · 최대매수 ${maxBuyQty}주 · 수수료합 ${n(feesCollected)}`);
