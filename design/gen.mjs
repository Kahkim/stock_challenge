import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 아트보드 소스를 생성한다.  실행:  node design/gen.mjs
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artboards');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- design tokens ---------- */
const T = {
  bg: '#0A0C10', surf: '#12151B', surf2: '#191D25', surf3: '#20252E',
  line: '#242A34', line2: '#2E3540',
  text: '#EDEFF3', dim: '#8B93A1', dim2: '#5C6472',
  up: '#FF4D5E', down: '#4C8DFF', accent: '#C6F24E', ink: '#0A0C10',
  sans: "'IBM Plex Sans KR', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
};
const upTint = 'rgba(255,77,94,0.13)';
const downTint = 'rgba(76,141,255,0.13)';
const accTint = 'rgba(198,242,78,0.10)';

/* ---------- 게임 상수 · 원장 -------------------------------------------
   화면에 찍히는 모든 금액은 여기서 계산된다. 손으로 적은 숫자는 없다.        */
const START_CASH = 10_000_000;
const SALARY = 300_000;          // 매 1분 지급
const INFL_RATE = 0.03;          // 매 1분 현금 잔액 차감률
const ROUND_SEC = 420;           // 7분 판
const ELAPSED = 182;             // 경과 3분 2초
const REMAIN = ROUND_SEC - ELAPSED;
const TICKS = Math.floor(ELAPSED / 60);
const NEXT_TICK_IN = 60 - (ELAPSED % 60);
const BAR_SEC = 5;
const N_BARS = Math.ceil(ELAPSED / BAR_SEC);   // 36 완성봉 + 진행봉 1개

const HOLD_QTY = 1200, HOLD_AVG = 6180, LAST_PRICE = 6720, BASE_PRICE = 5980;
const REALIZED = -178_000;

const ledger = (() => {
  let cash = START_CASH - HOLD_QTY * HOLD_AVG;
  let salaryTotal = 0, inflTotal = 0, lastInfl = 0;
  for (let m = 1; m <= TICKS; m++) {
    if (m === 3) cash += REALIZED;
    cash += SALARY; salaryTotal += SALARY;
    const cut = Math.floor(cash * INFL_RATE);
    cash -= cut; inflTotal += cut; lastInfl = cut;
  }
  const evalAmt = HOLD_QTY * LAST_PRICE;
  const invested = START_CASH + salaryTotal;
  return {
    cash, evalAmt, total: cash + evalAmt, salaryTotal, inflTotal, lastInfl,
    invested, perf: cash + evalAmt - invested,
    holdPnl: (LAST_PRICE - HOLD_AVG) * HOLD_QTY,
    holdPnlPct: (LAST_PRICE - HOLD_AVG) / HOLD_AVG * 100,
    maxBuyQty: Math.floor(cash / LAST_PRICE),
  };
})();
const perfPct = ledger.perf / ledger.invested * 100;

/* ---------- helpers ---------- */
const n = (v) => v.toLocaleString('en-US');
const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
const signed = (v) => (v >= 0 ? '+' : '−') + n(Math.abs(v));
const col = (v) => (v >= 0 ? T.up : T.down);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

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
const icoInfo = (c) => ico('M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 7.6v.2', 20, c, 1.5);
const icoBolt = (c, s = 20) => ico('M13 3L5 14h6l-1 7 8-11h-6l1-7z', s, c, 1.5);

/* ---------- shared bits ---------- */
const label = (t) =>
  `<div style="font-size:12px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;margin-bottom:9px;">${t}</div>`;

function segmented(items, activeIdx) {
  const segs = items.map((s, i) => {
    const on = i === activeIdx;
    return `<div style="flex-grow:1;height:44px;display:flex;align-items:center;justify-content:center;border-radius:9px;background:${on ? T.accent : 'transparent'};color:${on ? T.ink : T.dim};font-size:14px;font-weight:${on ? 700 : 500};">${s}</div>`;
  }).join('\n      ');
  return `<div style="display:flex;gap:4px;padding:4px;background:${T.surf};border:1px solid ${T.line};border-radius:12px;">
      ${segs}
    </div>`;
}

const chipEl = (t, on) =>
  `<div style="height:40px;display:flex;align-items:center;padding:0 13px;border-radius:10px;border:1px solid ${on ? T.accent : T.line};background:${on ? accTint : 'transparent'};color:${on ? T.text : T.dim};font-size:13px;font-weight:${on ? 600 : 500};">${t}</div>`;

const toggle = (on) =>
  `<div style="width:52px;height:32px;border-radius:16px;background:${on ? T.accent : T.surf3};border:1px solid ${on ? T.accent : T.line2};display:flex;align-items:center;justify-content:${on ? 'flex-end' : 'flex-start'};padding:3px;box-sizing:border-box;">
        <div style="width:24px;height:24px;border-radius:12px;background:${on ? T.ink : T.dim2};"></div>
      </div>`;

const stepperRow = (name, value) => `<div style="display:flex;align-items:center;gap:12px;height:56px;">
        <div style="flex-grow:1;font-size:14px;font-weight:500;color:${T.text};">${name}</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:${T.surf3};">${icoMinus(T.dim)}</div>
          <div style="min-width:76px;text-align:center;font-size:16px;font-weight:700;" class="m">${value}</div>
          <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:${T.surf3};">${icoPlus(T.text)}</div>
        </div>
      </div>`;

const hint = (t) => `<div style="display:flex;align-items:flex-start;gap:6px;margin-top:9px;">
        <div style="flex-shrink:0;margin-top:-1px;">${icoInfo(T.dim2)}</div>
        <div style="font-size:11px;color:${T.dim2};line-height:1.5;">${t}</div>
      </div>`;

/* =======================================================================
   1) 방 만들기
   ======================================================================= */
const ROOM_H = 1400;

const optionRow = (title, sub, on) => `<div style="display:flex;align-items:center;gap:12px;height:56px;">
        <div style="flex-grow:1;">
          <div style="font-size:14px;font-weight:600;color:${T.text};">${title}</div>
          <div style="font-size:11px;color:${T.dim2};margin-top:2px;">${sub}</div>
        </div>
        ${toggle(on)}
      </div>`;

// TODO: 요구자가 제안한 10개 종목으로 교체 예정. 아래는 자리표시용 가상 종목이다.
const TICKERS = [
  ['서진해운', 1], ['누리에너지', 1], ['한빛전자', 1], ['블루칩소프트', 1],
  ['정우물산', 1], ['대성바이오', 1], ['태산중공업', 1], ['케이팝엔터', 1],
  ['미래로보틱스', 0], ['삼우화학', 0],
];
const roomChips = TICKERS.map(([t, on]) => chipEl(t, !!on)).join('\n      ');

const roomBody = `<div style="width:390px;min-height:${ROOM_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  <div style="height:56px;display:flex;align-items:center;gap:4px;padding:0 12px 0 4px;border-bottom:1px solid ${T.line};">
    <div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;">${icoBack()}</div>
    <div style="font-size:17px;font-weight:600;flex-grow:1;">방 만들기</div>
    <div style="font-size:12px;color:${T.dim2};" class="m">1 / 1</div>
  </div>

  <div style="flex-grow:1;display:flex;flex-direction:column;gap:22px;padding:20px 16px 16px;">

    <div>
      ${label('방 이름')}
      <div style="height:52px;display:flex;align-items:center;gap:10px;padding:0 14px;background:${T.surf};border:1px solid ${T.line2};border-radius:12px;">
        <div style="flex-grow:1;font-size:16px;font-weight:500;color:${T.text};">점심값 걸고 한판</div>
        <div style="font-size:12px;color:${T.dim2};" class="m">9/20</div>
      </div>
    </div>

    <div>
      ${label('한 판 시간')}
      ${segmented(['5분', '7분', '10분'], 1)}
    </div>

    <div>
      ${label('시작 자금 (1인)')}
      ${segmented(['100만', '1,000만', '1억'], 1)}
    </div>

    <div>
      ${label('분당 정산')}
      <div style="display:flex;flex-direction:column;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:2px 14px;">
        ${stepperRow('월급 (매 1분)', n(SALARY))}
        <div style="height:1px;background:${T.line};"></div>
        ${stepperRow('인플레 (현금 차감)', (INFL_RATE * 100).toFixed(0) + '%')}
      </div>
      ${hint(`현금을 100% 들고 있으면 월급 ${n(SALARY)}원과 인플레 ${(INFL_RATE * 100).toFixed(0)}%(${n(START_CASH * INFL_RATE)}원)가 정확히 상쇄돼요. 주식에 넣어야 앞섭니다.`)}
    </div>

    <div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:9px;">
        <div style="font-size:12px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;flex-grow:1;">거래 종목</div>
        <div style="font-size:12px;color:${T.accent};font-weight:600;" class="m">8 / ${TICKERS.length} 선택</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
      ${roomChips}
      </div>
    </div>

    <div>
      ${label('시장 변동성')}
      ${segmented(['잔잔', '보통', '폭풍'], 1)}
      ${hint('봇이 얼마나 공격적으로 호가를 대는지, 돌발 뉴스가 몇 번 뜨는지를 한 번에 정합니다.')}
    </div>

    <div>
      ${label('규칙')}
      <div style="display:flex;flex-direction:column;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:2px 14px;">
        ${optionRow('돌발 뉴스', '팝업으로 알려주고 가격이 크게 튑니다', true)}
      </div>
    </div>

    <div>
      ${label('봇 트레이더')}
      <div style="display:flex;flex-direction:column;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:2px 14px;">
        ${stepperRow('봇 수', '8')}
      </div>
      ${hint('호가를 채우고 사람 주문의 반대편에서 거래해요 · 0~20')}
    </div>

  </div>

  <div style="padding:12px 16px 20px;border-top:1px solid ${T.line};background:${T.bg};">
    <div style="height:56px;display:flex;align-items:center;justify-content:center;border-radius:14px;background:${T.accent};color:${T.ink};font-size:16px;font-weight:700;">방 만들고 초대코드 받기</div>
    <div style="text-align:center;font-size:11px;color:${T.dim2};margin-top:10px;">만들면 6자리 초대코드가 생기고, 방장이 시작을 눌러야 장이 열려요</div>
  </div>

</div>`;

fs.writeFileSync(`${OUT}/Room.dc.html`, page({ w: 390, h: ROOM_H, body: roomBody }));

/* =======================================================================
   2) 전체 시황
   ======================================================================= */
const MARKET_H = 1470;

const stocks = [
  { name: '서진해운', sector: '해운', base: BASE_PRICE, price: LAST_PRICE },
  { name: '누리에너지', sector: '2차전지', base: 129000, price: 138500 },
  { name: '한빛전자', sector: '반도체', base: 71800, price: 74300 },
  { name: '블루칩소프트', sector: '소프트웨어', base: 45300, price: 45600 },
  { name: '정우물산', sector: '유통', base: 12330, price: 12300 },
  { name: '대성바이오', sector: '제약', base: 22370, price: 21950 },
  { name: '태산중공업', sector: '조선', base: 10250, price: 9840 },
  { name: '케이팝엔터', sector: '엔터', base: 93800, price: 88100 },
].map((s) => ({ ...s, diff: s.price - s.base, pct: (s.price - s.base) / s.base * 100 }));

const NEWS_STOCK = stocks.find((s) => s.name === '블루칩소프트');

function sparkline(seed, pctv) {
  const rnd = mulberry32(seed);
  const W = 58, H = 26, N = 24;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    pts.push(t * pctv + (rnd() - 0.5) * Math.max(0.5, Math.abs(pctv) * 0.32));
  }
  pts[0] = 0; pts[N - 1] = pctv;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = Math.max(0.4, max - min);
  const str = pts.map((v, i) => {
    const x = (i / (N - 1)) * (W - 2) + 1;
    const y = H - 3 - ((v - min) / span) * (H - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none"><polyline points="${str}" stroke="${col(pctv)}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>`;
}

const stockRows = stocks.map((s, i) => `<div style="display:flex;align-items:center;gap:12px;height:62px;padding:0 16px;border-bottom:1px solid ${T.line};">
      <div style="width:16px;font-size:12px;color:${T.dim2};" class="m">${i + 1}</div>
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:15px;font-weight:600;color:${T.text};">${s.name}</div>
        <div style="font-size:11px;color:${T.dim2};margin-top:2px;">${s.sector}</div>
      </div>
      ${sparkline(101 + i * 7, s.pct)}
      <div style="width:88px;text-align:right;">
        <div style="font-size:15px;font-weight:600;color:${T.text};" class="m">${n(s.price)}</div>
        <div style="font-size:12px;font-weight:600;color:${col(s.pct)};margin-top:2px;" class="m">${pct(s.pct)}</div>
      </div>
    </div>`).join('\n    ');

const players = [
  { rank: 1, name: '존버왕', asset: 13_940_000 },
  { rank: 2, name: '개미핥기', asset: 12_180_000 },
  { rank: 3, name: '물타기장인', asset: ledger.total, me: true },
  { rank: 4, name: '눈물의손절', asset: 10_604_000 },
  { rank: 5, name: '추격매수봇', asset: 9_972_000 },
  { rank: 6, name: '상투잡이', asset: 9_118_000 },
].map((p) => ({ ...p, pct: (p.asset - ledger.invested) / ledger.invested * 100 }));

const playerRows = players.map((p) => {
  const badgeBg = p.rank === 1 ? T.accent : T.surf3;
  const badgeFg = p.rank === 1 ? T.ink : (p.rank <= 3 ? T.dim : T.dim2);
  return `<div style="display:flex;align-items:center;gap:12px;height:56px;padding:0 16px 0 ${p.me ? '14px' : '16px'};background:${p.me ? accTint : 'transparent'};border-left:${p.me ? `2px solid ${T.accent}` : 'none'};border-bottom:1px solid ${T.line};">
      <div style="width:26px;height:26px;border-radius:8px;background:${badgeBg};color:${badgeFg};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;" class="m">${p.rank}</div>
      <div style="flex-grow:1;display:flex;align-items:center;gap:7px;min-width:0;">
        <div style="font-size:14px;font-weight:${p.me ? 700 : 500};color:${T.text};">${p.name}</div>
        ${p.me ? `<div style="height:19px;padding:0 6px;border-radius:5px;background:${T.accent};color:${T.ink};font-size:10px;font-weight:700;display:flex;align-items:center;">나</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:14px;font-weight:600;color:${T.text};" class="m">${n(p.asset)}</div>
        <div style="font-size:11px;font-weight:600;color:${col(p.pct)};margin-top:1px;" class="m">${pct(p.pct)}</div>
      </div>
    </div>`;
}).join('\n    ');

const navItem = (icon, text, on) => `<div style="flex-grow:1;height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;">
        ${icon}
        <div style="font-size:10px;font-weight:${on ? 700 : 500};color:${on ? T.accent : T.dim2};">${text}</div>
      </div>`;

const marketBody = `<div style="width:390px;min-height:${MARKET_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  <div style="padding:14px 16px 0;border-bottom:1px solid ${T.line};">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="flex-grow:1;font-size:15px;font-weight:600;color:${T.text};">점심값 걸고 한판</div>
      <div style="display:flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:6px;background:${upTint};">
        <div style="width:6px;height:6px;border-radius:3px;background:${T.up};"></div>
        <div style="font-size:10px;font-weight:700;color:${T.up};letter-spacing:0.06em;">LIVE</div>
      </div>
      <div style="font-size:11px;color:${T.dim2};" class="m">1초 갱신</div>
    </div>
    <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px;">
      <div style="font-size:34px;font-weight:700;color:${T.text};letter-spacing:-0.02em;" class="m">${clock(REMAIN)}</div>
      <div style="font-size:13px;color:${T.dim};">남음</div>
      <div style="flex-grow:1;"></div>
      <div style="font-size:12px;color:${T.dim2};">7분 판 · 6명 + 봇 8</div>
    </div>
    <div style="height:3px;border-radius:2px;background:${T.surf3};margin:12px 0 14px;display:flex;">
      <div style="width:${(ELAPSED / ROUND_SEC * 100).toFixed(0)}%;background:${T.accent};border-radius:2px;"></div>
    </div>
  </div>

  <div style="padding:14px 16px 0;">
    <div style="background:${T.surf};border:1px solid ${T.line};border-radius:14px;padding:14px 16px 0;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="flex-grow:1;font-size:12px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;">내 총자산</div>
        <div style="height:22px;padding:0 8px;border-radius:6px;background:${accTint};color:${T.accent};font-size:11px;font-weight:700;display:flex;align-items:center;" class="m">3위 / 6명</div>
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:6px;">
        <div style="font-size:28px;font-weight:700;color:${T.text};letter-spacing:-0.02em;" class="m">${n(ledger.total)}</div>
        <div style="font-size:14px;color:${T.dim};">원</div>
      </div>
      <div style="display:flex;align-items:baseline;gap:7px;margin-top:3px;">
        <div style="font-size:13px;font-weight:600;color:${col(ledger.perf)};" class="m">${signed(ledger.perf)} (${pct(perfPct)})</div>
        <div style="font-size:11px;color:${T.dim2};">누적 투입 ${n(ledger.invested)} 대비</div>
      </div>

      <div style="height:1px;background:${T.line};margin-top:14px;"></div>
      <div style="display:flex;">
        <div style="flex-grow:1;padding:12px 0;">
          <div style="font-size:11px;color:${T.dim2};">현금</div>
          <div style="font-size:13px;font-weight:600;margin-top:3px;" class="m">${n(ledger.cash)}</div>
        </div>
        <div style="flex-grow:1;padding:12px 0;">
          <div style="font-size:11px;color:${T.dim2};">평가금액</div>
          <div style="font-size:13px;font-weight:600;margin-top:3px;" class="m">${n(ledger.evalAmt)}</div>
        </div>
        <div style="flex-grow:1;padding:12px 0;">
          <div style="font-size:11px;color:${T.dim2};">실현손익</div>
          <div style="font-size:13px;font-weight:600;color:${col(REALIZED)};margin-top:3px;" class="m">${signed(REALIZED)}</div>
        </div>
      </div>

      <div style="height:1px;background:${T.line};"></div>
      <div style="display:flex;align-items:center;gap:8px;padding:12px 0 10px;">
        <div style="flex-grow:1;font-size:11px;font-weight:600;color:${T.dim2};letter-spacing:0.04em;">분당 정산 · ${TICKS}회 지급됨</div>
        <div style="height:20px;padding:0 7px;border-radius:5px;background:${T.surf3};color:${T.dim};font-size:10px;font-weight:600;display:flex;align-items:center;" class="m">다음 ${mmss(NEXT_TICK_IN)}</div>
      </div>
      <div style="display:flex;gap:8px;padding-bottom:14px;">
        <div style="flex-grow:1;background:${accTint};border-radius:10px;padding:10px 12px;">
          <div style="font-size:11px;color:${T.dim2};">월급 · ${n(SALARY)}/분</div>
          <div style="font-size:14px;font-weight:700;color:${T.accent};margin-top:3px;" class="m">${signed(ledger.salaryTotal)}</div>
        </div>
        <div style="flex-grow:1;background:${downTint};border-radius:10px;padding:10px 12px;">
          <div style="font-size:11px;color:${T.dim2};">인플레 · 현금의 ${(INFL_RATE * 100).toFixed(0)}%/분</div>
          <div style="font-size:14px;font-weight:700;color:${T.down};margin-top:3px;" class="m">${signed(-ledger.inflTotal)}</div>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:8px;padding:22px 16px 10px;">
    <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">전체 종목 <span style="color:${T.dim2};font-weight:500;">8</span></div>
    <div style="display:flex;gap:6px;">
      <div style="height:28px;padding:0 10px;border-radius:8px;background:${T.surf3};color:${T.text};font-size:11px;font-weight:600;display:flex;align-items:center;">등락률순</div>
      <div style="height:28px;padding:0 10px;border-radius:8px;border:1px solid ${T.line};color:${T.dim2};font-size:11px;font-weight:500;display:flex;align-items:center;">거래대금순</div>
    </div>
  </div>

  <div style="border-top:1px solid ${T.line};">
    ${stockRows}
  </div>

  <div style="display:flex;align-items:center;gap:8px;padding:22px 16px 10px;">
    <div style="font-size:14px;font-weight:700;color:${T.text};flex-grow:1;">자산 순위 <span style="color:${T.dim2};font-weight:500;font-size:11px;">누적 투입 대비</span></div>
    <div style="font-size:11px;color:${T.dim2};" class="m">2초 갱신</div>
  </div>

  <div style="border-top:1px solid ${T.line};">
    ${playerRows}
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
   3) 개별 종목
   ======================================================================= */
const STOCK_H = 1550;

const anchors = [[0, 5980], [6, 5950], [11, 6180], [17, 6120], [22, 6420], [28, 6650], [31, 6890], [34, 6740], [N_BARS - 1, LAST_PRICE]];
const rnd = mulberry32(20260912);
const round10 = (v) => Math.round(v / 10) * 10;

const closes = [];
for (let i = 0; i < N_BARS; i++) {
  let a = anchors[0], b = anchors[anchors.length - 1];
  for (let k = 0; k < anchors.length - 1; k++) {
    if (i >= anchors[k][0] && i <= anchors[k + 1][0]) { a = anchors[k]; b = anchors[k + 1]; break; }
  }
  const t = b[0] === a[0] ? 0 : (i - a[0]) / (b[0] - a[0]);
  let v = a[1] + (b[1] - a[1]) * t;
  if (i !== 0 && i !== N_BARS - 1) v += (rnd() - 0.5) * v * 0.0055;
  closes.push(round10(v));
}
closes[N_BARS - 1] = LAST_PRICE;

const candles = [];
for (let i = 0; i < N_BARS; i++) {
  const open = i === 0 ? BASE_PRICE : closes[i - 1];
  const close = closes[i];
  const body = Math.abs(close - open);
  const hi = round10(Math.max(open, close) + body * 0.45 + rnd() * 18);
  const lo = round10(Math.min(open, close) - body * 0.45 - rnd() * 18);
  const vol = Math.round((520 + body * 3.4 + rnd() * 620) / 10) * 10;
  candles.push({ open, close, hi, lo, vol, upBar: close >= open });
}
const dayHi = Math.max(...candles.map((c) => c.hi));
const dayLo = Math.min(...candles.map((c) => c.lo));
const dayVol = candles.reduce((s, c) => s + c.vol, 0);
const maxVol = Math.max(...candles.map((c) => c.vol));

const CW = 358, PH = 150, VH = 30, GAP = 8;
const CH = PH + GAP + VH;
const slot = CW / N_BARS;
const bodyW = Math.min(5.2, slot - 3.2);
const padTop = dayHi + (dayHi - dayLo) * 0.06;
const padBot = dayLo - (dayHi - dayLo) * 0.06;
const y = (p) => (padTop - p) / (padTop - padBot) * PH;
const clampY = (v) => Math.min(Math.max(v, 0), PH - 12);

const candleEls = candles.map((c, i) => {
  const cx = i * slot + slot / 2;
  const color = c.upBar ? T.up : T.down;
  const yHi = y(c.hi), yLo = y(c.lo), yO = y(c.open), yC = y(c.close);
  const top = Math.min(yO, yC);
  const hgt = Math.max(1.5, Math.abs(yC - yO));
  const vh = Math.max(1.5, c.vol / maxVol * VH);
  return `<div style="position:absolute;left:${(cx - 0.6).toFixed(2)}px;top:${yHi.toFixed(2)}px;width:1.2px;height:${(yLo - yHi).toFixed(2)}px;background:${color};opacity:0.75;"></div>
      <div style="position:absolute;left:${(cx - bodyW / 2).toFixed(2)}px;top:${top.toFixed(2)}px;width:${bodyW.toFixed(2)}px;height:${hgt.toFixed(2)}px;background:${color};border-radius:1px;"></div>
      <div style="position:absolute;left:${(cx - bodyW / 2).toFixed(2)}px;top:${(PH + GAP + (VH - vh)).toFixed(2)}px;width:${bodyW.toFixed(2)}px;height:${vh.toFixed(2)}px;background:${color};opacity:0.34;border-radius:1px;"></div>`;
}).join('\n        ');

const gridEls = [dayHi, BASE_PRICE, dayLo].map((p, i) => {
  const yy = y(p);
  const isBase = i === 1;
  return `<div style="position:absolute;left:0;top:${yy.toFixed(2)}px;width:${CW}px;height:1px;background:${isBase ? T.line2 : T.line};opacity:${isBase ? '0.9' : '0.55'};"></div>
      <div style="position:absolute;${isBase ? 'left:0' : 'right:0'};top:${clampY(yy - 14).toFixed(2)}px;font-size:10px;color:${isBase ? T.dim : T.dim2};background:${T.bg};padding:0 3px;" class="m">${isBase ? '기준 ' : ''}${n(p)}</div>`;
}).join('\n        ');

const nowLine = `<div style="position:absolute;left:0;top:${y(LAST_PRICE).toFixed(2)}px;width:${CW}px;height:1px;background:${T.up};opacity:0.45;"></div>
      <div style="position:absolute;right:0;top:${clampY(y(LAST_PRICE) - 9).toFixed(2)}px;height:18px;padding:0 5px;border-radius:4px;background:${T.up};color:#FFFFFF;font-size:10px;font-weight:700;display:flex;align-items:center;" class="m">${n(LAST_PRICE)}</div>`;

const xLabels = [0, 12, 24, 36].filter((i) => i < N_BARS).map((i) =>
  `<div style="position:absolute;left:${(i * slot).toFixed(2)}px;top:${(CH + 6).toFixed(2)}px;font-size:9px;color:${T.dim2};" class="m">+${mmss(i * BAR_SEC)}</div>`
).join('\n        ');

const asks = [{ p: 6770, q: 1240 }, { p: 6760, q: 860 }, { p: 6750, q: 2105 }, { p: 6740, q: 430 }, { p: 6730, q: 980 }];
const bids = [{ p: 6720, q: 1510 }, { p: 6710, q: 2340 }, { p: 6700, q: 3780, mine: 200 }, { p: 6690, q: 1120 }, { p: 6680, q: 640 }];
const maxQ = Math.max(...asks.map((a) => a.q), ...bids.map((b) => b.q));
const askTotal = asks.reduce((s, a) => s + a.q, 0);
const bidTotal = bids.reduce((s, b) => s + b.q, 0);

const askRows = asks.map((a) => {
  const w = a.q / maxQ * 100;
  return `<div style="display:flex;align-items:center;height:44px;border-bottom:1px solid ${T.line};">
        <div style="width:143px;height:44px;position:relative;display:flex;align-items:center;justify-content:flex-end;padding-right:12px;box-sizing:border-box;">
          <div style="position:absolute;right:0;top:6px;height:32px;width:${w.toFixed(1)}%;background:${downTint};border-radius:3px 0 0 3px;"></div>
          <div style="position:relative;font-size:13px;color:${T.dim};" class="m">${n(a.q)}</div>
        </div>
        <div style="width:104px;height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${T.surf};border-left:1px solid ${T.line};border-right:1px solid ${T.line};">
          <div style="font-size:14px;font-weight:600;color:${T.down};" class="m">${n(a.p)}</div>
          <div style="font-size:9px;color:${T.dim2};" class="m">${pct((a.p - BASE_PRICE) / BASE_PRICE * 100)}</div>
        </div>
        <div style="flex-grow:1;"></div>
      </div>`;
}).join('\n      ');

const bidRows = bids.map((b, i) => {
  const w = b.q / maxQ * 100;
  const isBest = i === 0;
  return `<div style="display:flex;align-items:center;height:44px;border-bottom:1px solid ${T.line};">
        <div style="width:143px;"></div>
        <div style="width:104px;height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${isBest ? upTint : T.surf};border-left:1px solid ${isBest ? T.up : T.line};border-right:1px solid ${T.line};">
          <div style="font-size:14px;font-weight:${isBest ? 700 : 600};color:${T.up};" class="m">${n(b.p)}</div>
          <div style="font-size:9px;color:${T.dim2};" class="m">${pct((b.p - BASE_PRICE) / BASE_PRICE * 100)}</div>
        </div>
        <div style="flex-grow:1;height:44px;position:relative;display:flex;align-items:center;gap:7px;padding-left:12px;box-sizing:border-box;">
          <div style="position:absolute;left:0;top:6px;height:32px;width:${w.toFixed(1)}%;background:${upTint};border-radius:0 3px 3px 0;"></div>
          <div style="position:relative;font-size:13px;color:${T.dim};" class="m">${n(b.q)}</div>
          ${b.mine ? `<div style="position:relative;display:flex;align-items:center;height:20px;padding:0 6px;border-radius:5px;background:${T.accent};color:${T.ink};font-size:10px;font-weight:700;" class="m">내 ${b.mine}</div>` : ''}
        </div>
      </div>`;
}).join('\n      ');

const miniStat = (k, v, c) => `<div style="text-align:right;">
          <div style="font-size:10px;color:${T.dim2};">${k}</div>
          <div style="font-size:12px;font-weight:600;color:${c || T.text};margin-top:2px;" class="m">${v}</div>
        </div>`;
const tf = (t, on) => `<div style="height:34px;padding:0 14px;display:flex;align-items:center;border-radius:9px;background:${on ? T.surf3 : 'transparent'};border:1px solid ${on ? T.line2 : 'transparent'};color:${on ? T.text : T.dim2};font-size:12px;font-weight:${on ? 700 : 500};" class="m">${t}</div>`;
const qtyChip = (t) => `<div style="height:32px;flex-grow:1;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid ${T.line};color:${T.dim};font-size:11px;font-weight:600;" class="m">${t}</div>`;

const ORDER_QTY = 100;
const stockBody = `<div style="width:390px;min-height:${STOCK_H}px;box-sizing:border-box;background:${T.bg};display:flex;flex-direction:column;">

  <div style="height:56px;display:flex;align-items:center;gap:6px;padding:0 16px 0 4px;border-bottom:1px solid ${T.line};">
    <div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;">${icoBack()}</div>
    <div style="font-size:17px;font-weight:600;">서진해운</div>
    <div style="height:20px;padding:0 7px;border-radius:5px;background:${T.surf3};color:${T.dim};font-size:10px;font-weight:600;display:flex;align-items:center;">해운</div>
    <div style="flex-grow:1;"></div>
    <div style="display:flex;align-items:center;gap:5px;">
      <div style="width:6px;height:6px;border-radius:3px;background:${T.accent};"></div>
      <div style="font-size:14px;font-weight:700;color:${T.accent};" class="m">${clock(REMAIN)}</div>
    </div>
  </div>

  <div style="display:flex;align-items:flex-end;gap:12px;padding:16px 16px 14px;">
    <div style="flex-grow:1;">
      <div style="display:flex;align-items:baseline;gap:6px;">
        <div style="font-size:32px;font-weight:700;color:${T.up};letter-spacing:-0.02em;" class="m">${n(LAST_PRICE)}</div>
        <div style="font-size:14px;color:${T.dim};">원</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
        <div style="font-size:14px;font-weight:600;color:${T.up};" class="m">${signed(LAST_PRICE - BASE_PRICE)}</div>
        <div style="font-size:14px;font-weight:600;color:${T.up};" class="m">${pct((LAST_PRICE - BASE_PRICE) / BASE_PRICE * 100)}</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${miniStat('고가', n(dayHi), T.up)}
      ${miniStat('저가', n(dayLo), T.down)}
      ${miniStat('거래량', n(dayVol) + '주')}
    </div>
  </div>

  <div style="padding:0 16px;">
    <div style="display:flex;gap:6px;margin-bottom:10px;">
      ${tf('1초', false)}
      ${tf('5초', true)}
      ${tf('30초', false)}
      ${tf('전체', false)}
    </div>
    <div style="position:relative;width:${CW}px;height:${CH + 20}px;">
        ${gridEls}
        ${candleEls}
        ${nowLine}
        ${xLabels}
    </div>
  </div>

  <div style="height:8px;background:${T.surf};margin-top:16px;border-top:1px solid ${T.line};border-bottom:1px solid ${T.line};"></div>

  <div style="display:flex;align-items:center;height:34px;padding:0 16px;">
    <div style="width:131px;text-align:right;font-size:10px;color:${T.dim2};font-weight:600;">매도 잔량</div>
    <div style="width:104px;text-align:center;font-size:10px;color:${T.dim2};font-weight:600;">호가</div>
    <div style="flex-grow:1;padding-left:12px;font-size:10px;color:${T.dim2};font-weight:600;">매수 잔량</div>
  </div>

  <div style="padding:0 16px;border-top:1px solid ${T.line};">
      ${askRows}
      <div style="display:flex;align-items:center;justify-content:center;gap:8px;height:28px;background:${T.surf2};border-bottom:1px solid ${T.line};">
        <div style="font-size:10px;color:${T.dim2};">스프레드</div>
        <div style="font-size:11px;font-weight:600;color:${T.dim};" class="m">10원 (0.15%)</div>
      </div>
      ${bidRows}
      <div style="display:flex;align-items:center;height:40px;">
        <div style="width:143px;text-align:right;padding-right:12px;box-sizing:border-box;font-size:12px;font-weight:600;color:${T.down};" class="m">${n(askTotal)}</div>
        <div style="width:104px;text-align:center;font-size:10px;color:${T.dim2};">총잔량</div>
        <div style="flex-grow:1;padding-left:12px;font-size:12px;font-weight:600;color:${T.up};" class="m">${n(bidTotal)}</div>
      </div>
  </div>

  <div style="padding:6px 16px 0;">
    <div style="display:flex;align-items:center;gap:12px;background:${T.surf};border:1px solid ${T.line};border-radius:12px;padding:14px 16px;">
      <div>
        <div style="font-size:11px;color:${T.dim2};">내 보유</div>
        <div style="font-size:14px;font-weight:600;margin-top:3px;" class="m">${n(HOLD_QTY)}주 · 평단 ${n(HOLD_AVG)}</div>
      </div>
      <div style="flex-grow:1;"></div>
      <div style="text-align:right;">
        <div style="font-size:11px;color:${T.dim2};">평가손익</div>
        <div style="font-size:14px;font-weight:700;color:${T.up};margin-top:3px;" class="m">${signed(ledger.holdPnl)} (${pct(ledger.holdPnlPct)})</div>
      </div>
    </div>
  </div>

  <div style="flex-grow:1;"></div>

  <div style="border-top:1px solid ${T.line};background:${T.surf};padding:12px 16px 18px;margin-top:16px;">
    <div style="display:flex;gap:4px;padding:4px;background:${T.bg};border:1px solid ${T.line};border-radius:11px;margin-bottom:12px;">
      <div style="flex-grow:1;height:38px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};color:${T.text};font-size:13px;font-weight:700;">지정가</div>
      <div style="flex-grow:1;height:38px;display:flex;align-items:center;justify-content:center;border-radius:8px;color:${T.dim2};font-size:13px;font-weight:500;">시장가</div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;height:48px;padding:0 6px 0 14px;background:${T.bg};border:1px solid ${T.line2};border-radius:11px;">
      <div style="font-size:11px;color:${T.dim2};width:32px;">가격</div>
      <div style="flex-grow:1;text-align:right;font-size:17px;font-weight:700;" class="m">${n(LAST_PRICE)}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoMinus(T.dim)}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoPlus(T.text)}</div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;height:48px;padding:0 6px 0 14px;background:${T.bg};border:1px solid ${T.line2};border-radius:11px;margin-top:8px;">
      <div style="font-size:11px;color:${T.dim2};width:32px;">수량</div>
      <div style="flex-grow:1;text-align:right;font-size:17px;font-weight:700;" class="m">${ORDER_QTY}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoMinus(T.dim)}</div>
      <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:${T.surf3};">${icoPlus(T.text)}</div>
    </div>

    <div style="display:flex;gap:6px;margin-top:8px;">
      ${qtyChip('10%')}
      ${qtyChip('25%')}
      ${qtyChip('50%')}
      ${qtyChip('최대 ' + ledger.maxBuyQty + '주')}
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin:14px 2px 12px;">
      <div style="font-size:12px;color:${T.dim2};flex-grow:1;">주문금액</div>
      <div style="font-size:14px;font-weight:700;" class="m">${n(ORDER_QTY * LAST_PRICE)}원</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:0 2px 14px;">
      <div style="font-size:12px;color:${T.dim2};flex-grow:1;">주문가능</div>
      <div style="font-size:12px;color:${T.dim};" class="m">현금 ${n(ledger.cash)}원 · 최대 ${ledger.maxBuyQty}주</div>
    </div>

    <div style="display:flex;gap:10px;">
      <div style="flex-grow:1;height:54px;display:flex;align-items:center;justify-content:center;border-radius:13px;background:${downTint};border:1px solid ${T.down};color:${T.down};font-size:16px;font-weight:700;">매도</div>
      <div style="flex-grow:1;height:54px;display:flex;align-items:center;justify-content:center;border-radius:13px;background:${T.up};color:#FFFFFF;font-size:16px;font-weight:700;">매수</div>
    </div>
  </div>

</div>`;

fs.writeFileSync(`${OUT}/Stock.dc.html`, page({ w: 390, h: STOCK_H, body: stockBody }));

/* =======================================================================
   4) 돌발 뉴스 팝업  (전체 시황 위 오버레이 · 딤 있음)
   ======================================================================= */
const newsModal = `<div style="position:absolute;left:0;top:0;width:390px;height:${MARKET_H}px;background:rgba(4,6,9,0.80);"></div>
  <div style="position:absolute;left:16px;top:188px;width:358px;box-sizing:border-box;background:${T.surf};border:1px solid ${T.line2};border-radius:20px;padding:20px;box-shadow:0 28px 70px rgba(0,0,0,0.65);">
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="display:flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border-radius:7px;background:${upTint};">
        ${icoBolt(T.up, 14)}
        <div style="font-size:11px;font-weight:700;color:${T.up};letter-spacing:0.04em;">돌발 뉴스</div>
      </div>
      <div style="flex-grow:1;"></div>
      <div style="font-size:11px;color:${T.dim2};" class="m">${clock(REMAIN)} 남음</div>
    </div>

    <div style="font-size:20px;font-weight:700;color:${T.text};line-height:1.4;margin-top:14px;letter-spacing:-0.01em;text-wrap:pretty;">${NEWS_STOCK.name}, 최대 고객사가 계약 해지를 검토 중</div>

    <div style="display:flex;align-items:center;gap:12px;margin-top:16px;padding:12px 14px;background:${T.bg};border:1px solid ${T.line};border-radius:12px;">
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:14px;font-weight:600;color:${T.text};">${NEWS_STOCK.name}</div>
        <div style="font-size:11px;color:${T.dim2};margin-top:2px;">${NEWS_STOCK.sector}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:15px;font-weight:700;color:${T.text};" class="m">${n(NEWS_STOCK.price)}</div>
        <div style="font-size:12px;font-weight:600;color:${col(NEWS_STOCK.pct)};margin-top:2px;" class="m">${pct(NEWS_STOCK.pct)}</div>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-top:16px;">
      <div style="width:96px;height:50px;display:flex;align-items:center;justify-content:center;border-radius:13px;border:1px solid ${T.line2};color:${T.dim};font-size:15px;font-weight:600;">닫기</div>
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
   5) 월급 입금 팝업  (개별 종목 위 오버레이 · 딤 없음, 거래를 막지 않는다)
   ======================================================================= */
// 화면 하단(주문 패널 바로 위)에 띄운다. 상단에 두면 현재가를 가리는데,
// 그 화면에서 가장 중요한 숫자를 정보성 토스트가 가리면 안 된다.
const salaryToast = `<div style="position:absolute;left:16px;bottom:376px;width:358px;box-sizing:border-box;background:${T.surf2};border:1px solid rgba(198,242,78,0.35);border-radius:16px;padding:14px 16px;box-shadow:0 18px 44px rgba(0,0,0,0.55);">
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:34px;height:34px;flex-shrink:0;border-radius:10px;background:${accTint};display:flex;align-items:center;justify-content:center;">${icoWallet(T.accent, 19)}</div>
      <div style="flex-grow:1;min-width:0;">
        <div style="font-size:14px;font-weight:700;color:${T.text};">월급 입금 · ${TICKS}분차</div>
        <div style="font-size:11px;color:${T.dim2};margin-top:2px;">다음 지급까지 ${mmss(NEXT_TICK_IN)}</div>
      </div>
      <div style="font-size:19px;font-weight:700;color:${T.accent};" class="m">${signed(SALARY)}</div>
    </div>
    <div style="height:1px;background:${T.line};margin:12px 0 10px;"></div>
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="font-size:11px;color:${T.dim2};flex-grow:1;">인플레 차감 · 현금의 ${(INFL_RATE * 100).toFixed(0)}%</div>
      <div style="font-size:13px;font-weight:700;color:${T.down};" class="m">${signed(-ledger.lastInfl)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:7px;">
      <div style="font-size:11px;color:${T.dim2};flex-grow:1;">정산 후 현금</div>
      <div style="font-size:13px;font-weight:700;color:${T.text};" class="m">${n(ledger.cash)}원</div>
    </div>
    <div style="height:3px;border-radius:2px;background:${T.surf3};margin-top:12px;display:flex;">
      <div style="width:38%;background:${T.accent};border-radius:2px;"></div>
    </div>
  </div>`;

fs.writeFileSync(`${OUT}/Salary.dc.html`, page({
  w: 390, h: STOCK_H,
  body: `<div style="position:relative;width:390px;height:${STOCK_H}px;overflow:hidden;">
  ${stockBody}
  ${salaryToast}
</div>`,
}));

/* ---------- canvas.json ---------- */
const ROW2 = 1800;
const canvas = {
  artboards: [
    { file: 'Room.dc.html', title: '1 · 방 만들기', x: 0, y: 0, w: 390, h: ROOM_H },
    { file: 'Main.dc.html', title: '2 · 전체 시황', x: 510, y: 0, w: 390, h: MARKET_H },
    { file: 'Stock.dc.html', title: '3 · 개별 종목', x: 1020, y: 0, w: 390, h: STOCK_H },
    { file: 'News.dc.html', title: '4 · 돌발 뉴스 팝업', x: 510, y: ROW2, w: 390, h: MARKET_H },
    { file: 'Salary.dc.html', title: '5 · 월급 입금 팝업', x: 1020, y: ROW2, w: 390, h: STOCK_H },
  ],
  annotations: [
    { id: 'note-room', x: 0, y: -190, w: 390, text: '한 판 5~10분 · 내부 시뮬레이션 거래소 전제.\n방장이 종목·변동성·봇 수·분당 정산을 정하고, 사람은 초대코드로 들어온다.' },
    { id: 'note-market', x: 510, y: -190, w: 390, text: '갱신 주기 제안: 종목 등락 1초 / 자산 순위 2초.\n월급이 매분 들어오므로 수익률 기준은 시작자금이 아니라 누적 투입(시작자금+누적월급)이다.' },
    { id: 'note-stock', x: 1020, y: -190, w: 390, text: '호가·체결은 주기 갱신이 아니라 이벤트 푸시(250ms 스로틀).\n차트는 1초 틱 수집 + 5초봉 집계. 마지막 봉은 진행 중이다.' },
    { id: 'note-news', x: 510, y: ROW2 - 190, w: 390, text: '돌발 뉴스: 딤 + 모달. 판을 통틀어 2~3회뿐이고 즉시 반응해야 하므로 화면을 막는다.\n영향 종목의 현재가를 같이 보여주되 방향(↑↓)은 알려주지 않는다 — 판단은 플레이어 몫.' },
    { id: 'note-salary', x: 1020, y: ROW2 - 190, w: 390, text: '월급 입금: 딤 없는 토스트. 매분 반복되므로 거래를 막으면 안 된다.\n월급과 인플레는 같은 시점에 일어나므로 팝업 하나로 합쳤다.' },
  ],
  launch: { view: 'canvas' },
};
fs.writeFileSync(`${OUT}/canvas.json`, JSON.stringify(canvas, null, 2));

console.log('artboards:', fs.readdirSync(OUT).join(', '));
console.log('bars', N_BARS, 'hi', dayHi, 'lo', dayLo, 'vol', dayVol, 'last', candles[candles.length - 1].close);
console.log('cash', ledger.cash, 'total', ledger.total, 'perf', ledger.perf, perfPct.toFixed(2) + '%', 'maxQty', ledger.maxBuyQty);
