'use strict';

/**
 * 모의주식 챌린지 — 서버.
 *
 * 외부 의존성 없이 Node 내장 모듈만 사용한다.
 * 실시간 푸시는 SSE(Server-Sent Events)로 한다. 브라우저 기본 지원이고,
 * WebSocket 라이브러리 없이 동작하며, 이 게임은 서버→클라이언트 푸시가 대부분이라 잘 맞는다.
 * 주문 같은 클라이언트→서버 동작은 평범한 POST 로 보낸다.
 *
 * API 전체 명세는 docs/API.md 참고.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { RoomStore, ROOM_IDLE_MS, sweepIntervalMs } = require('./src/rooms');
const { Limiter } = require('./src/ratelimit');
const { Room } = require('./src/rooms');
const persist = require('./src/persist');
const { STOCK_POOL, DEFAULTS, tickSize } = require('./src/config');
const { PHASE } = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUSH_MS = Number(process.env.PUSH_MS) || 400;   // SSE 푸시 주기
const MAX_BODY = 256 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new RoomStore();
// 끝난 방과 버려진 방을 걷어낸다. 기준은 ROOM_IDLE_MS (기본 4시간).
const SWEEP_MS = sweepIntervalMs();
setInterval(() => store.sweep(), SWEEP_MS).unref();

/** 기동 로그에 쓰는 사람이 읽기 쉬운 시간 */
const humanMs = (ms) => ms >= 3600000 ? `${+(ms / 3600000).toFixed(1)}시간`
  : ms >= 60000 ? `${+(ms / 60000).toFixed(1)}분` : `${Math.round(ms / 1000)}초`;

// ── 영속성 ──────────────────────────────────────────────────────
// 행사 중 서버가 죽어도 진행 중인 게임을 이어갈 수 있게 주기적으로 저장한다.
// PERSIST_DIR 를 빈 문자열로 두면 저장하지 않는다(테스트용).
const PERSIST_DIR = process.env.PERSIST_DIR === '' ? null
  : (process.env.PERSIST_DIR || path.join(__dirname, '.data'));
const PERSIST_MS = Number(process.env.PERSIST_MS) || 10000;

if (PERSIST_DIR) {
  const restored = persist.loadAll(store, PERSIST_DIR, Room);
  if (restored) console.log(`저장된 방 ${restored}개를 복구했습니다`);
  // 비동기로 저장한다. 동기 I/O 는 이벤트 루프를 막아 게임 틱과 SSE 전송이 그만큼 밀린다.
  let saving = false;
  setInterval(async () => {
    if (saving) return;                      // 저장이 겹치지 않게
    saving = true;
    try { await persist.saveAllAsync(store, PERSIST_DIR); }
    catch (e) { console.error('[persist]', e.message); }
    finally { saving = false; }
  }, PERSIST_MS).unref();
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (PERSIST_DIR) {
    const n = persist.saveAll(store, PERSIST_DIR);
    console.log(`\n${signal}: 방 ${n}개를 저장하고 종료합니다`);
  }
  for (const r of store.rooms.values()) r.stopTimer();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── 요청 제한 ───────────────────────────────────────────────────
// 참가자 토큰 기준이 실질적인 보호선이다. 사람이 낼 수 있는 속도를 훨씬 웃도는
// 값이라 정상 플레이는 절대 걸리지 않고, 폭주하는 스크립트만 막는다.
const LIMITS = {
  order: new Limiter(Number(process.env.RL_ORDER_BURST) || 25,
                     Number(process.env.RL_ORDER_RATE) || 12),     // 참가자당 주문
  ip:    new Limiter(Number(process.env.RL_IP_BURST) || 1200,
                     Number(process.env.RL_IP_RATE) || 600),        // IP당 전체 요청 (50명이 한 IP를 공유한다)
  // IP당 방 생성. 리허설하며 방을 여러 개 만드는 건 정상이므로 버스트를 넉넉히 둔다.
  create: new Limiter(Number(process.env.RL_CREATE_BURST) || 40,
                      Number(process.env.RL_CREATE_RATE) || 0.02),  // 회복 시간당 72개
};
setInterval(() => { for (const l of Object.values(LIMITS)) l.sweep(); }, 60 * 1000).unref();

const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 제한에 걸리면 429 를 보내고 true 를 반환한다 */
function limited(res, limiter, key) {
  const r = limiter.take(key);
  if (r.ok) return false;
  send(res, 429, { error: { code: 'RATE_LIMITED', message: '요청이 너무 잦습니다. 잠시 후 다시 시도하세요' } },
       { 'Retry-After': Math.ceil(r.retryAfterMs / 1000) });
  return true;
}

// ── 유틸 ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function send(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}
function fail(res, status, code, message) {
  send(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) { reject(Object.assign(new Error('요청이 너무 큽니다'), { code: 'BODY_TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(Object.assign(new Error('JSON 형식이 올바르지 않습니다'), { code: 'BAD_JSON' })); }
    });
    req.on('error', reject);
  });
}

const headerOrQuery = (req, url, header, qs) =>
  req.headers[header] || url.searchParams.get(qs) || null;

function requireRoom(res, code) {
  const room = store.get(code);
  if (!room) { fail(res, 404, 'ROOM_NOT_FOUND', '참가코드에 해당하는 방이 없습니다'); return null; }
  return room;
}
function requirePlayer(res, room, req, url) {
  const t = headerOrQuery(req, url, 'x-player-token', 'token');
  const pid = t && room.playerIdOf(t);
  if (!pid) { fail(res, 401, 'INVALID_TOKEN', '참가자 토큰이 올바르지 않습니다'); return null; }
  return pid;
}
function requireHost(res, room, req, url) {
  const t = headerOrQuery(req, url, 'x-host-token', 'hostToken');
  if (!t || t !== room.hostToken) { fail(res, 403, 'NOT_HOST', '방장만 할 수 있습니다'); return false; }
  return true;
}

// ── 정적 파일 ───────────────────────────────────────────────────
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return fail(res, 403, 'FORBIDDEN', '접근할 수 없는 경로입니다');

  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) {
      // 화면은 별도로 개발 중일 수 있다. API 는 그대로 동작한다는 걸 알려준다.
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;line-height:1.7">' +
        '<h2>모의주식 챌린지 서버</h2>' +
        '<p>화면 파일(<code>public/' + rel.replace(/^\//, '') + '</code>)이 아직 없습니다. API 는 정상 동작 중입니다.</p>' +
        '<p>API 명세: <code>docs/API.md</code> · 상태 확인: <a href="/api/health">/api/health</a></p></body>');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ── SSE ─────────────────────────────────────────────────────────
function openStream(req, res, room, pid) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  room.game.connections++;          // 방장 화면이 "몇 명이 붙어 있나" 를 볼 수 있게
  let lastFillSeq = 0;
  let closed = false;
  const push = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tickOnce = () => {
    const payload = { snapshot: room.game.snapshot() };
    if (pid) {
      const me = room.game.playerView(pid, lastFillSeq);
      if (me) { lastFillSeq = me.fillSeq; payload.me = me; }
    }
    push('state', payload);
  };

  tickOnce();
  const iv = setInterval(tickOnce, PUSH_MS);
  const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, 15000);
  const stop = () => {
    if (closed) return;
    closed = true;
    room.game.connections = Math.max(0, room.game.connections - 1);
    clearInterval(iv); clearInterval(hb);
  };
  req.on('close', stop);
  req.on('error', stop);
  res.on('error', stop);
}

// ── 라우팅 ──────────────────────────────────────────────────────
async function route(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean);   // ['api','rooms',CODE,...]
  const method = req.method.toUpperCase();

  if (seg[1] === 'health') {
    return send(res, 200, {
      ok: true, rooms: store.rooms.size, uptimeSec: Math.round(process.uptime()),
      persist: PERSIST_DIR ? { dir: PERSIST_DIR, everyMs: PERSIST_MS } : null,
    });
  }

  // 방 만들기 화면이 필요로 하는 메타데이터
  if (seg[1] === 'meta') {
    return send(res, 200, {
      stockPool: STOCK_POOL,
      defaults: DEFAULTS,
      tickSizeTable: [
        { under: 2000, tick: tickSize(1000) },
        { under: 5000, tick: tickSize(3000) },
        { under: null, tick: tickSize(9000) },
      ],
      botTypes: {
        trend: '오른 종목에 올라탄다 — 시장에 모멘텀을 만든다',
        contra: '내린 종목을 줍는다 — 버블이 무한히 커지지 않게 잡는다',
        value: '적정가 대비 싼 종목을 산다 — 인플레이션을 체결가로 전달한다',
        noise: '봇마다 고정된 무작위 취향',
        maker: '종목 견해 없이 양방향 호가를 낸다 — 호가창이 한쪽만 차는 걸 막는다',
      },
    });
  }

  if (seg[1] !== 'rooms') return fail(res, 404, 'NOT_FOUND', '없는 경로입니다');

  // POST /api/rooms — 방 만들기
  if (seg.length === 2 && method === 'POST') {
    if (limited(res, LIMITS.create, clientIp(req))) return;
    if (store.rooms.size >= MAX_ROOMS) {
      return fail(res, 503, 'TOO_MANY_ROOMS', '방이 너무 많습니다. 잠시 후 다시 시도하세요');
    }
    const body = await readBody(req);
    let room;
    try { room = store.create(body.config || body, body.title); }
    catch (e) { return fail(res, 400, e.code || 'BAD_CONFIG', e.message); }
    return send(res, 201, {
      roomCode: room.code, hostToken: room.hostToken, seed: room.seed,
      title: room.title, config: room.config, lobby: room.lobbyInfo(),
    });
  }

  const code = seg[2];
  if (!code) return fail(res, 400, 'BAD_REQUEST', '참가코드가 필요합니다');
  const room = requireRoom(res, code);
  if (!room) return;
  room.lastActivity = Date.now();
  const g = room.game;
  const tail = seg[3];

  // GET /api/rooms/:code — 로비 정보
  if (!tail && method === 'GET') return send(res, 200, room.lobbyInfo());

  // POST /api/rooms/:code/join — 참가 (deviceId 를 같이 보내면 재접속 복구)
  if (tail === 'join' && method === 'POST') {
    const body = await readBody(req);
    try {
      return send(res, 200, Object.assign({ roomCode: room.code }, room.join(body.name, body.deviceId)));
    } catch (e) { return fail(res, 409, e.code || 'JOIN_FAILED', e.message); }
  }

  // POST /api/rooms/:code/resume — 보관해 둔 토큰이 아직 유효한지 확인
  if (tail === 'resume' && method === 'POST') {
    const body = await readBody(req);
    const t = body.playerToken || headerOrQuery(req, url, 'x-player-token', 'token');
    try { return send(res, 200, Object.assign({ roomCode: room.code }, room.resume(t))); }
    catch (e) { return fail(res, 401, e.code || 'INVALID_TOKEN', e.message); }
  }

  // POST /api/rooms/:code/start — 시작 (방장)
  if (tail === 'start' && method === 'POST') {
    if (!requireHost(res, room, req, url)) return;
    try { return send(res, 200, room.start()); }
    catch (e) { return fail(res, 409, e.code || 'START_FAILED', e.message); }
  }

  // POST /api/rooms/:code/config — 시작 전 설정 변경 (방장)
  if (tail === 'config' && method === 'POST') {
    if (!requireHost(res, room, req, url)) return;
    const body = await readBody(req);
    try { return send(res, 200, room.reconfigure(body.config || body)); }
    catch (e) { return fail(res, 409, e.code || 'RECONFIG_FAILED', e.message); }
  }

  // POST /api/rooms/:code/pause — 일시정지 (방장)
  if (tail === 'pause' && method === 'POST') {
    if (!requireHost(res, room, req, url)) return;
    try { return send(res, 200, room.pause()); }
    catch (e) { return fail(res, 409, e.code || 'PAUSE_FAILED', e.message); }
  }

  // POST /api/rooms/:code/resume-game — 재개 (방장)
  if (tail === 'resume-game' && method === 'POST') {
    if (!requireHost(res, room, req, url)) return;
    try { return send(res, 200, room.resumeGame()); }
    catch (e) { return fail(res, 409, e.code || 'RESUME_FAILED', e.message); }
  }

  // POST /api/rooms/:code/kick — 참가자 내보내기 (방장)
  if (tail === 'kick' && method === 'POST') {
    if (!requireHost(res, room, req, url)) return;
    const body = await readBody(req);
    try { return send(res, 200, room.kick(body.playerId)); }
    catch (e) { return fail(res, 400, e.code || 'KICK_FAILED', e.message); }
  }

  // POST /api/rooms/:code/end — 조기 마감 (방장)
  if (tail === 'end' && method === 'POST') {
    if (!requireHost(res, room, req, url)) return;
    try { return send(res, 200, room.forceEnd()); }
    catch (e) { return fail(res, 409, e.code || 'END_FAILED', e.message); }
  }

  // GET /api/rooms/:code/stream — 실시간 스트림 (토큰 없으면 관전/현황판 모드)
  if (tail === 'stream' && method === 'GET') {
    const t = headerOrQuery(req, url, 'x-player-token', 'token');
    return openStream(req, res, room, t ? room.playerIdOf(t) : null);
  }

  // GET /api/rooms/:code/state — SSE 못 쓰는 환경을 위한 폴링 폴백
  if (tail === 'state' && method === 'GET') {
    const t = headerOrQuery(req, url, 'x-player-token', 'token');
    const pid = t ? room.playerIdOf(t) : null;
    const out = { snapshot: g.snapshot() };
    if (pid) out.me = g.playerView(pid, Number(url.searchParams.get('sinceFill')) || 0);
    return send(res, 200, out);
  }

  // GET /api/rooms/:code/me — 내 잔고/보유/미체결
  if (tail === 'me' && method === 'GET') {
    const pid = requirePlayer(res, room, req, url);
    if (!pid) return;
    return send(res, 200, g.playerView(pid, Number(url.searchParams.get('sinceFill')) || 0));
  }

  // POST /api/rooms/:code/ipo-bids — 공모 청약
  if (tail === 'ipo-bids' && method === 'POST') {
    const pid = requirePlayer(res, room, req, url);
    if (!pid) return;
    if (limited(res, LIMITS.order, pid)) return;
    const b = await readBody(req);
    try { return send(res, 200, g.submitIpoBid(pid, b.code, b.price, b.qty)); }
    catch (e) { return fail(res, 400, e.code || 'IPO_FAILED', e.message); }
  }

  // POST /api/rooms/:code/orders — 주문 (price 를 빼거나 "market" 이면 시장가)
  if (tail === 'orders' && method === 'POST' && !seg[4]) {
    const pid = requirePlayer(res, room, req, url);
    if (!pid) return;
    if (limited(res, LIMITS.order, pid)) return;
    const b = await readBody(req);
    try { return send(res, 200, g.submitOrder(pid, b.code, b.side, b.price, b.qty)); }
    catch (e) { return fail(res, 400, e.code || 'ORDER_FAILED', e.message); }
  }

  // POST /api/rooms/:code/orders/cancel — 주문 취소
  if (tail === 'orders' && seg[4] === 'cancel' && method === 'POST') {
    const pid = requirePlayer(res, room, req, url);
    if (!pid) return;
    if (limited(res, LIMITS.order, pid)) return;
    const b = await readBody(req);
    try { return send(res, 200, g.cancelOrder(pid, b.code, b.orderId)); }
    catch (e) { return fail(res, 400, e.code || 'CANCEL_FAILED', e.message); }
  }

  // GET /api/rooms/:code/chart?code=SEC — 가격/적정가 이력
  if (tail === 'chart' && method === 'GET') {
    const want = url.searchParams.get('code');
    const rows = g.stocks
      .filter(s => !want || s.code === want)
      .map(s => ({ code: s.code, name: s.name, color: s.color, history: s.history }));
    return send(res, 200, { stocks: rows });
  }

  // GET /api/rooms/:code/result.csv?type=ranking|stocks — 시상·정산용 내려받기
  if (tail === 'result.csv' && method === 'GET') {
    const type = url.searchParams.get('type') || 'ranking';
    const q = (v) => {
      const t = String(v == null ? '' : v);
      return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const rows = [];
    if (type === 'stocks') {
      rows.push(['종목코드', '종목명', '시초가', '종가', '적정가', '고가', '저가', '거래량', '발행주식수', '등락률(%)']);
      for (const st of g.stocks) {
        rows.push([st.code, st.name, st.open, st.last, Math.round(st.fair), st.high, st.low,
                   st.volume, st.issued, (st.open ? (st.last / st.open - 1) * 100 : 0).toFixed(2)]);
      }
    } else {
      rows.push(['순위', '이름', '구분', '총자산', '투입액', '손익', '수익률(%)']);
      for (const row of g.ranking(true)) {
        const p = g.players.get(row.id);
        const invested = g.cfg.seedMoney + (p ? p.salaryTotal : 0);
        rows.push([row.rank, row.name, row.isBot ? '봇' : '사람', row.nav, invested,
                   row.nav - invested, row.pnlPct.toFixed(2)]);
      }
    }
    // 엑셀에서 한글이 깨지지 않도록 BOM 을 붙인다
    const csv = '\uFEFF' + rows.map(r2 => r2.map(q).join(',')).join('\r\n') + '\r\n';
    const buf = Buffer.from(csv, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': buf.length,
      'Content-Disposition': 'attachment; filename="' + room.code + '-' + type + '.csv"',
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  // GET /api/rooms/:code/result — 최종 결과
  if (tail === 'result' && method === 'GET') {
    return send(res, 200, {
      phase: g.phase,
      endedAt: g.endedAt,
      ranking: g.ranking(true),
      humanRanking: g.ranking(false),
      stocks: g.stocks.map(s => ({
        code: s.code, name: s.name, open: s.open, last: s.last,
        fair: Math.round(s.fair), high: s.high, low: s.low,
        volume: s.volume, issued: s.issued,
        changePct: s.open ? (s.last / s.open - 1) * 100 : 0,
      })),
      feesCollected: Math.round(g.feesCollected),
      newsLog: g.newsLog,
    });
  }

  return fail(res, 404, 'NOT_FOUND', '없는 경로입니다');
}

// ── 서버 ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 같은 오리진에서 서빙하는 게 기본이지만, 화면을 따로 띄워 개발할 수 있게 CORS 를 열어둔다.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Player-Token, X-Host-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  if (limited(res, LIMITS.ip, clientIp(req))) return;

  route(req, res, url).catch((e) => {
    if (res.headersSent) return;
    fail(res, e.code === 'BAD_JSON' || e.code === 'BODY_TOO_LARGE' ? 400 : 500,
         e.code || 'INTERNAL', e.message || '서버 오류');
  });
});

/**
 * 같은 WiFi 에 있는 참가자가 접속할 주소를 찾는다.
 * 행사장에서는 이 주소를 참가자에게 알려줘야 하는데, 매번 찾기 번거로우므로
 * 서버가 뜰 때 바로 보여준다.
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push({ name, address: ni.address });
    }
  }
  // 사설망(공유기 대역)을 앞으로 — 행사장에서 쓸 주소는 보통 이쪽이다
  const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return out.sort((a, b) => (isPrivate(b.address) ? 1 : 0) - (isPrivate(a.address) ? 1 : 0));
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const lan = lanAddresses();
    console.log('');
    console.log('  모의주식 챌린지 서버가 떴습니다');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  방장 화면    http://localhost:${PORT}`);
    if (lan.length) {
      console.log('');
      console.log('  참가자는 같은 WiFi 에서 아래 주소로 접속하세요');
      for (const { name, address } of lan) {
        console.log(`      http://${address}:${PORT}`.padEnd(38) + `(${name})`);
      }
    } else {
      console.log('');
      console.log('  ⚠ 외부에서 접속할 수 있는 네트워크를 찾지 못했습니다.');
      console.log('    WiFi 나 유선랜에 연결되어 있는지 확인하세요.');
    }
    console.log('  ─────────────────────────────────────────────');
    console.log(`  SSE 푸시 ${PUSH_MS}ms · 저장 ${PERSIST_DIR ? PERSIST_DIR + ' (' + PERSIST_MS + 'ms 주기)' : '끔'}`);
    console.log(`  방 정리 ${humanMs(ROOM_IDLE_MS)} (${humanMs(SWEEP_MS)}마다 확인) — 결과는 그때까지 받아갈 수 있습니다`);
    console.log('  Ctrl+C 로 종료하면 진행 중인 방을 저장합니다');
    console.log('');
  });
}

module.exports = { server, store, PHASE, LIMITS, persist, PERSIST_DIR, ROOM_IDLE_MS, SWEEP_MS };
