# 모의주식 챌린지 — 서버 API 명세

화면(프론트엔드)이 서버와 주고받는 모든 계약을 정리한 문서입니다.
서버는 외부 의존성 없이 Node 내장 모듈만 사용합니다. `npm start` 로 실행합니다 (기본 포트 3000).

```
node server.js                 # PORT=3000
PORT=8080 node server.js
```

---

## 1. 전체 흐름

```
  방장                                    참가자
   │                                        │
   ├─ POST /api/rooms ──────────────────────┤   참가코드(6자) + 방장토큰 발급
   │                                        │
   │                        참가코드 공유 ──►│
   │                                        ├─ POST /api/rooms/{code}/join
   │                                        │     → 참가자토큰 발급
   ├─ POST /api/rooms/{code}/start ─────────┤
   │                                        │
   │        ┌──────── phase: "ipo" ─────────┴─────┐  개장 공모 (기본 45초)
   │        │  POST /api/rooms/{code}/ipo-bids    │  가격+수량 청약 → 단일가로 시초가 결정
   │        └─────────────────────────────────────┘
   │        ┌──────── phase: "trading" ───────────┐  정규장 (기본 15분)
   │        │  POST /api/rooms/{code}/orders      │
   │        │  POST /api/rooms/{code}/orders/cancel│
   │        └─────────────────────────────────────┘
   │        ┌──────── phase: "ended" ─────────────┐
   │        │  GET /api/rooms/{code}/result       │
   │        └─────────────────────────────────────┘
   │
   └─ 모든 단계에서 GET /api/rooms/{code}/stream (SSE) 로 실시간 상태 수신
```

`phase` 는 `lobby` → `ipo` → `trading` → `ended` 순으로만 바뀝니다.
`ipoSec: 0` 으로 방을 만들면 `ipo` 를 건너뛰고 바로 `trading` 으로 갑니다.

---

## 2. 인증

토큰은 두 종류입니다. 서버가 발급하고, 클라이언트는 보관만 하면 됩니다.

| 토큰 | 발급 시점 | 전달 방법 | 용도 |
|---|---|---|---|
| `hostToken` | 방 생성 응답 | 헤더 `X-Host-Token` 또는 쿼리 `?hostToken=` | 게임 시작 |
| `playerToken` | 참가 응답 | 헤더 `X-Player-Token` 또는 쿼리 `?token=` | 주문, 내 잔고 조회 |

> SSE(`EventSource`)는 헤더를 못 붙이므로 **쿼리스트링**을 쓰세요: `/api/rooms/ABC123/stream?token=...`

토큰이 없으면 **관전 모드**로 동작합니다 — 공개 정보(시세·호가·순위)만 받고 개인 잔고는 오지 않습니다. 프로젝터에 띄우는 전체 현황판은 토큰 없이 연결하면 됩니다.

---

## 3. 엔드포인트

### `GET /api/health`
```json
{ "ok": true, "rooms": 3, "uptimeSec": 412 }
```

### `GET /api/meta`
방 만들기 화면에 필요한 모든 선택지를 줍니다. **화면에 종목 목록을 하드코딩하지 마세요.**

```json
{
  "stockPool": [
    { "code": "SNU", "name": "서울대", "initialPrice": 1200, "color": "#1b3f7a" },
    { "code": "YON", "name": "연세대", "initialPrice": 2500, "color": "#0a2d5e" }
  ],
  "defaults": { "botCount": 30, "durationMin": 15, "lotSize": 10 },
  "tickSizeTable": [
    { "under": 2000, "tick": 5 }, { "under": 5000, "tick": 10 }, { "under": null, "tick": 25 }
  ],
  "botTypes": {
    "trend":  "오른 종목에 올라탄다 — 시장에 모멘텀을 만든다",
    "contra": "내린 종목을 줍는다 — 버블이 무한히 커지지 않게 잡는다",
    "value":  "적정가 대비 싼 종목을 산다 — 인플레이션을 체결가로 전달한다",
    "noise":  "봇마다 고정된 무작위 취향",
    "maker":  "종목 견해 없이 양방향 호가를 낸다 — 호가창이 한쪽만 차는 걸 막는다"
  }
}
```

`stockPool` 은 10종목(서울대·연세대·고려대·한양대·동국대·건국대·홍익대·경희대·경기대·숭실대) 전체입니다.
방 만들기 화면에서 **체크박스로 2개 이상** 고르게 하면 됩니다.

---

### `POST /api/rooms` — 방 만들기

```jsonc
{
  "title": "동문회 챌린지",
  "config": {
    "stockCodes": ["SNU", "YON", "KOR", "HYU", "DGU", "KKU"],  // 2개 이상 필수
    "botCount": 30,
    "durationMin": 15,
    "ipoSec": 45
    // 나머지는 생략하면 기본값
  }
}
```

**201** 응답:
```json
{
  "roomCode": "SC6NSN",
  "hostToken": "5a75c22adcba8d9da699bdfef5a5522a",
  "title": "동문회 챌린지",
  "config": { "...정리된 전체 설정..." },
  "lobby": { "...아래 GET /api/rooms/{code} 와 동일..." }
}
```

값이 범위를 벗어나면 **거절하지 않고 안전한 범위로 잘라서** 돌려줍니다(`botCount: 99999` → `500`).
응답의 `config` 가 실제 적용된 값이므로 그걸 화면에 다시 표시하세요.
종목을 1개 이하로 고르면 `400 TOO_FEW_STOCKS` 로 거절됩니다.

<details><summary><b>설정 항목 전체</b> (모두 선택 사항)</summary>

| 키 | 기본값 | 범위 | 설명 |
|---|---|---|---|
| `stockCodes` | 6종목 | 2개 이상 | 참여 종목 |
| `seedMoney` | 1,000,000 | 1만~10억 | 1인당 시작 현금 |
| `initialShares` | **0** | 0~10만 | 1인당 종목별 시작 주식. **0(현금만)이 권장값** |
| `salaryAmount` | 100,000 | 0~10억 | 월급 |
| `salaryIntervalSec` | 60 | 5~3600 | 월급 주기 |
| `bonusShares` | true | — | 무상증자 사용 여부 |
| `maxBonusRate` | 0.05 | 0~5 | 1회 증자 상한 |
| `inflationPerMin` | 0.005 | 0~1 | 분당 적정가 상승률. 밸런스가 아니라 괴리율 표시의 기준선을 정한다 |
| `idioVolatility` | 0.30 | 0~3 | 종목 개별 변동성 |
| `durationMin` | 15 | 1~180 | 정규장 길이(분) |
| `ipoSec` | 45 | 0~600 | 개장 공모 시간. 0이면 생략 |
| `tickMs` | 250 | 100~2000 | 서버 틱 주기 |
| `lotSize` | 10 | 1~1000 | 최소 거래 단위(주) |
| `feeRate` | 0.0015 | 0~0.05 | 편도 수수료 |
| `floatCapitalRatio` | 0.60 | 0.05~5 | 전체 시드머니 대비 발행 시가총액 |
| `botCount` | 30 | 0~500 | NPC 참가자 수 |
| `botExcludeFromRanking` | true | — | 시상 순위에서 봇 제외 |
| `botActionRate` | 0.035 | 0.001~0.5 | 봇이 1틱에 주문할 확률 |
| `botCashBiasSpread` | 0.30 | 0~0.9 | 봇별 목표 현금비중 편차 |
| `botSharpness` | 30 | 0~60 | 봇이 한 종목에 쏠리는 정도 |
| `makerSpread` | 0.006 | 0.0005~0.1 | 호가제시형 봇이 한 단계마다 벌리는 폭 |
| `makerLevels` | 4 | 1~10 | 호가제시형 봇이 몇 단계에 걸쳐 호가를 까는가 |
| `ipoBidRatio` | 0.30 | 0.02~0.35 | 봇이 공모에 현금의 몇 %부터 지르는가. 시장에 풀리는 주식량을 정한다 |
| `lookbackSec` | 120 | 3~600 | 봇이 추세를 보는 창(초) |
| `botMix` | trend .60 / maker .20 / noise .15 / contra .03 / value .02 | — | 봇 성향 구성비 |

</details>

---

### `GET /api/rooms/{code}` — 로비
```json
{
  "code": "SC6NSN", "title": "동문회 챌린지", "phase": "lobby",
  "players": [ { "id": "p1_6ze7", "name": "앨리스" } ],
  "humanCount": 1,
  "config": { "..." },
  "stocks": [ { "code": "SNU", "name": "서울대", "color": "#1b3f7a", "initialPrice": 1200 } ]
}
```

### `POST /api/rooms/{code}/join` — 참가
요청 `{ "name": "앨리스" }` (이름은 12자로 잘립니다. 비우면 자동 생성)
```json
{ "roomCode": "SC6NSN", "playerId": "p1_6ze7", "playerToken": "...", "name": "앨리스" }
```
`phase` 가 `lobby` 가 아니면 **409 ALREADY_STARTED**. 게임 시작 후 난입은 막혀 있습니다.

### `POST /api/rooms/{code}/start` — 시작 *(방장)*
헤더 `X-Host-Token` 필요. 응답은 아래 **Snapshot** 과 동일합니다.

### `POST /api/rooms/{code}/ipo-bids` — 개장 공모 청약 *(참가자)*
`phase === "ipo"` 일 때만. 한 종목에 여러 번 낼 수 있습니다.
```jsonc
{ "code": "SNU", "price": 1300, "qty": 500 }   // price 는 호가단위로, qty 는 lotSize 단위로 자동 반올림
```
```json
{ "code": "SNU", "price": 1300, "qty": 500, "reserved": 650000 }
```
청약 즉시 `price × qty` 만큼 **증거금이 예치**되어 `cash` 에서 빠집니다.
공모 마감 시 단일가로 배정되고, 낙찰 차액과 미배정분은 자동 환불됩니다.

### `POST /api/rooms/{code}/orders` — 주문 *(참가자)*
```jsonc
{ "code": "YON", "side": "buy", "price": 2480, "qty": 100 }   // 지정가
{ "code": "YON", "side": "sell", "price": "market", "qty": 50 } // 시장가 (price 생략도 동일)
```
```json
{ "filled": 40, "resting": 60, "orderId": "o812", "price": 2480, "qty": 100, "market": false }
```
- `filled` 즉시 체결된 수량, `resting` 호가창에 남은 수량
- **시장가는 IOC 입니다** — 즉시 체결되고 남은 물량은 자동 취소됩니다(`resting` 항상 0). 그래서 시장가는 `orderId` 가 `null` 입니다.
- 시장가인데 반대 호가가 없으면 **400 NO_COUNTERPARTY**. 화면에서 "지금은 지정가로 주문하세요"로 안내하면 됩니다. 정상적으로 자주 발생합니다.
- 자기 주문끼리는 체결되지 않습니다.

### `POST /api/rooms/{code}/orders/cancel` — 주문 취소 *(참가자)*
```jsonc
{ "code": "YON", "orderId": "o812" }
```
```json
{ "cancelled": 60 }
```

### `GET /api/rooms/{code}/me` — 내 상태 *(참가자)*
`?sinceFill=<숫자>` 를 붙이면 그 이후의 체결만 `newFills` 로 받습니다. 아래 **PlayerView** 참고.

### `GET /api/rooms/{code}/state` — 폴링 폴백
SSE 를 못 쓰는 환경용. `{ "snapshot": {...}, "me": {...} }`. 토큰이 없으면 `me` 가 없습니다.

### `GET /api/rooms/{code}/chart?code=SNU` — 가격 이력
```json
{ "stocks": [ { "code": "SNU", "name": "서울대", "color": "#1b3f7a",
  "history": [ { "t": 0, "price": 1240, "fair": 1200 }, { "t": 1, "price": 1245, "fair": 1201 } ] } ] }
```
`t` 는 게임 시작으로부터의 초. **1초에 한 점**씩 쌓이고 최대 1800점입니다.
`code` 를 빼면 전 종목이 옵니다. `fair`(적정가)를 체결가와 함께 그리면 버블 정도가 한눈에 보입니다.

### `GET /api/rooms/{code}/result` — 최종 결과
```json
{
  "phase": "ended", "endedAt": 1789201076969,
  "ranking":      [ { "rank": 1, "id": "b7", "name": "차트왕", "isBot": true, "nav": 4120000, "pnl": 1620000, "pnlPct": 64.8 } ],
  "humanRanking": [ { "rank": 1, "id": "p1_6ze7", "name": "앨리스", "isBot": false, "nav": 3688125, "pnl": 688125, "pnlPct": 22.9 } ],
  "stocks": [ { "code": "SNU", "name": "서울대", "open": 1240, "last": 1105, "fair": 1396,
                "high": 1310, "low": 1080, "volume": 13100, "issued": 7371, "changePct": -10.9 } ],
  "feesCollected": 41200,
  "newsLog": [ { "id": "n412_a1b", "code": "SNU", "name": "서울대", "sign": 1,
                 "headline": "서울대 대량 매수 유입 — 매도 호가 공백",
                 "impactPct": 8.4, "atSec": 103, "priceAt": 1240 } ]
}
```
`ranking` 은 봇 포함 전체, `humanRanking` 은 사람만. **시상은 `humanRanking` 으로 하세요.**
`newsLog` 는 게임 중 터진 뉴스 전체입니다. 결과 화면에서 차트 위에 표시하면 좋습니다.

---

## 4. SSE — `GET /api/rooms/{code}/stream`

```js
const es = new EventSource(`/api/rooms/${code}/stream?token=${playerToken}`);
es.addEventListener('state', (e) => {
  const { snapshot, me } = JSON.parse(e.data);
  render(snapshot, me);
});
```

- `state` 이벤트가 **400ms 마다** 옵니다 (`PUSH_MS` 환경변수로 조절).
- `token` 을 붙이면 `me` 가 함께 오고, 없으면 `snapshot` 만 옵니다.
- 15초마다 주석 하트비트(`: hb`)가 나가 연결이 유지됩니다. `EventSource` 는 끊겨도 자동 재연결합니다.
- **`me.newFills` 는 직전 전송 이후의 신규 체결만 담깁니다.** 그대로 체결 팝업으로 띄우면 중복 없이 한 번씩 뜹니다.

---

## 5. 데이터 모델

### Snapshot (공개 정보)

```jsonc
{
  "phase": "trading",            // lobby | ipo | trading | ended
  "tickNo": 1840,
  "elapsedSec": 460,
  "ipoRemainSec": 0,             // phase==="ipo" 일 때 남은 청약 시간
  "remainSec": 585,              // 정규장 남은 시간 — 화면 카운트다운
  "playerCount": 32,             // 봇 포함
  "humanCount": 2,
  "feesCollected": 41200,
  "config": { "lotSize": 10, "feeRate": 0.0015, "seedMoney": 1000000,
              "salaryAmount": 100000, "salaryIntervalSec": 60,
              "inflationPerMin": 0.05, "durationMin": 15, "ipoSec": 45 },

  "stocks": [{
    "code": "SNU", "name": "서울대", "color": "#1b3f7a",
    "last": 1105,                // 최종 체결가 — 체결로만 움직인다
    "fair": 1396,                // 적정가 — 인플레이션과 개별 실적이 반영된 이론가(공개 정보)
    "open": 1110, "high": 1110, "low": 1100,
    "volume": 1310,
    "float": 4000,               // 최초 발행 계획 수량
    "issued": 7371,              // 실제 유통 주식 수(무상증자로 늘어난다)
    "changePct": -0.45,          // 시초가 대비 등락률
    "vsFairPct": -20.83,         // 적정가 대비 괴리율 — 양수면 거품, 음수면 저평가
    "depth": {                   // 호가창 (최대 10단계, 가격 우선 정렬)
      "bids": [ { "price": 1100, "qty": 1460 }, { "price": 1095, "qty": 820 } ],
      "asks": [ { "price": 1105, "qty": 90 },   { "price": 1110, "qty": 490 } ]
    },
    "ipoDemand": 12400           // phase==="ipo" 일 때만. 현재까지 청약된 총 수량
  }],

  "news": [{                     // 지금 효력이 살아 있는 돌발뉴스 (없으면 빈 배열)
    "id": "n1366_jq3m", "code": "HYU", "name": "한양대", "sign": -1,
    "headline": "한양대 차익실현 매물 출회",
    "impactPct": -6.9,           // 적정가에 준 충격
    "ageSec": 12, "lifeSec": 90  // 뜬 지 12초, 총 90초간 유효
  }],

  "ranking": [ { "rank": 1, "id": "p1_6ze7", "name": "앨리스", "isBot": false,
                 "nav": 3688125, "pnl": 688125, "pnlPct": 22.94 } ],
  "notices": [ { "seq": 164, "ts": 1789201076966, "text": "무상증자 5% — 보유 주식 2,810주 추가 배정", "kind": "bonus" } ],
  "tape":    [ { "seq": 191, "code": "HYU", "price": 1765, "qty": 10, "side": "buy", "t": 128 } ]
}
```

- `ranking` 은 기본적으로 **사람만** 포함합니다(`botExcludeFromRanking: true`). 상위 50명까지.
- `notices[].kind`: `info` · `salary` · `bonus` · `ipo` · `open` · `close` · `news-up` · `news-down`. 종류별로 색을 다르게 주면 좋습니다. 뉴스는 배너나 토스트로 크게 띄우세요.
- `news` 는 **지금 효력이 살아 있는 뉴스만** 담습니다. 지나간 뉴스 전체는 `notices` 또는 결과 API 의 `newsLog` 에 있습니다.
- `tape` 는 최근 40건의 전체 체결 내역입니다. `side` 는 **체결을 일으킨 쪽**(공격자)이라 매수면 상승 체결입니다.
- `depth.bids/asks` 는 **비어 있을 수 있습니다.** 특히 매도 호가는 전체 시간의 약 20% 동안 빕니다. 빈 상태를 정상으로 그려주세요.

### PlayerView (개인 정보) — `me`

```jsonc
{
  "id": "p1_6ze7", "name": "앨리스", "isBot": false,
  "cash": 2445000,               // 즉시 쓸 수 있는 현금
  "lockedCash": 120000,          // 미체결 매수 주문에 묶인 현금
  "nav": 3688125,                // 총자산 = 현금 + 묶인현금 + 보유주식 평가액
  "invested": 3000000,           // 시드머니 + 지금까지 받은 월급 (수익률 기준선)
  "salaryTotal": 2000000,
  "realized": 41000,             // 실현손익

  "holdings": [{                 // 수량 0인 종목은 빠집니다
    "code": "SNU", "name": "서울대",
    "qty": 1125, "free": 1125, "locked": 0,   // locked = 미체결 매도 주문에 묶인 수량
    "avgPrice": 493, "last": 1105,
    "evalAmount": 1243125, "pnl": 688125, "pnlPct": 123.99
  }],

  "openOrders": [ { "id": "o812", "code": "YON", "name": "연세대",
                    "side": "buy", "price": 2480, "qty": 60 } ],

  "newFills": [ { "seq": 7, "ts": 1789201076966, "code": "SNU", "name": "서울대",
                  "side": "buy", "price": 1105, "qty": 100, "amount": 110500, "tag": null } ],
  "fillSeq": 7
}
```

- 수익률은 `nav / invested - 1` 로 계산하세요. 월급이 들어오면 `invested` 도 같이 커지므로 공평합니다.
- `avgPrice` 는 수수료 포함 매입원가 기준입니다. 무상증자를 받으면 수량만 늘어 **평균단가가 내려갑니다.**
- `tag` 가 `"공모"` 면 개장 공모 배정분입니다.

---

## 6. 에러

모든 오류는 같은 형식입니다.
```json
{ "error": { "code": "INSUFFICIENT_CASH", "message": "현금이 부족합니다" } }
```

| 코드 | HTTP | 언제 | 화면에서 할 일 |
|---|---|---|---|
| `ROOM_NOT_FOUND` | 404 | 참가코드가 없음 | "참가코드를 다시 확인하세요" |
| `TOO_FEW_STOCKS` | 400 | 종목을 2개 미만 선택 | 방 만들기 폼에서 막기 |
| `ALREADY_STARTED` | 409 | 시작된 방에 참가 시도 | "이미 시작된 게임입니다" |
| `NO_PLAYERS` | 409 | 참가자 0명인데 시작 | 시작 버튼 비활성화 |
| `NOT_HOST` | 403 | 방장 토큰 불일치 | — |
| `INVALID_TOKEN` | 401 | 참가자 토큰 불일치 | 재입장 유도 |
| `NOT_TRADING` | 400 | 거래 시간이 아님 | 주문 UI 잠그기 |
| `NOT_IPO` | 400 | 공모 시간이 아님 | 청약 UI 잠그기 |
| `NO_STOCK` | 400 | 없는 종목 코드 | — |
| `LOT_SIZE` | 400 | 최소 거래 단위 위반 | 수량 입력을 `lotSize` 배수로 제한 |
| `BAD_SIDE` / `BAD_PRICE` | 400 | 파라미터 오류 | — |
| `INSUFFICIENT_CASH` | 400 | 현금 부족 | 최대 매수 가능 수량 미리 계산해 표시 |
| `INSUFFICIENT_SHARES` | 400 | 보유 주식 부족 | 최대 매도 가능 수량 미리 표시 |
| `NO_COUNTERPARTY` | 400 | 시장가인데 반대 호가 없음 | **자주 발생.** "지정가로 주문하세요" 안내 |
| `ORDER_GONE` | 400 | 이미 체결·취소된 주문 | 주문 목록 새로고침 |
| `NOT_OWNER` | 400 | 남의 주문 취소 시도 | — |

---

## 7. 화면이 알아야 할 게임 규칙

**시작 자산은 현금뿐입니다.** 주식은 0주로 시작합니다(`initialShares: 0`).
개장 공모에 참여해야 주식을 얻습니다. **청약을 안 하면 주식이 0이고, 그러면 순위가 최하위로 갑니다.**
공모 화면에서 이 점을 강하게 안내해야 합니다.

**인플레이션과 적정가.** 매분 전 종목의 적정가가 조금씩 오릅니다(기본 0.5%). 현금은 액수가 줄지 않지만 상대 가치가 떨어집니다.
`fair`(적정가)와 `vsFairPct`(적정가 대비 괴리율)를 화면에 항상 노출하세요.
괴리율은 평균이 0 근처에서 종목마다 크게 흩어지도록(±30%p 수준) 맞춰져 있어서,
**"이 종목이 지금 거품인가 저평가인가"를 읽는 신호**로 쓸 수 있습니다. 양수면 거품, 음수면 저평가입니다.

**월급과 무상증자는 세트입니다.** 매분 월급(현금)이 들어오고, 동시에 주식 보유자에게만 무상증자가 배정됩니다.
현금이 늘어난 만큼 주식도 늘려야 호가창이 한쪽으로 무너지지 않기 때문입니다.
**주식이 없으면 증자도 0주**입니다 — 이게 "가만히 있으면 손해"의 핵심 장치입니다.

**봇은 사람과 완전히 동일한 조건입니다.** 같은 시드머니, 같은 월급, 같은 인플레이션을 받고,
사람 화면에 보이는 정보(현재가·적정가·최근 추세·자기 잔고)만 봅니다.
남의 미체결 주문이나 보유내역은 보지 않습니다. 순위표에는 기본적으로 표시되지 않지만
`isBot` 플래그가 있으므로 필요하면 구분해 보여줄 수 있습니다.

**호가 단위와 최소 거래 단위.** 가격은 2,000원 미만 5원 / 5,000원 미만 10원 / 그 이상 25원 단위입니다.
수량은 10주 단위입니다. 서버가 알아서 반올림하지만, 화면에서 미리 맞춰주면 사용자가 덜 헷갈립니다.

**시장가는 실패할 수 있습니다.** 반대 호가가 비어 있으면 `NO_COUNTERPARTY` 가 납니다.
시장가 버튼 옆에 항상 지정가 입력을 함께 두세요.

**돌발뉴스.** 평균 70초마다 종목별 호재/악재가 터집니다(15분에 약 12건, 호재:악재 ≈ 5:5).
뉴스는 적정가를 즉시 점프시키고, 봇들이 **시차를 두고** 동조합니다.
봇마다 뉴스를 인지하는 시점이 흩어져 있어서 동조가 서서히 번지고, 그래서 **먼저 반응한 사람이 이득을 봅니다.**

> **화면 설계상 가장 중요한 점**: 뉴스 팝업에는 반드시 **바로 체결되는 주문 버튼**을 두세요.
> 측정 결과 소극적 지정가(현재가)로 내면 즉시 체결률이 23%에 그쳐 현금이 호가에 묶이고,
> 그 상태로 인플레이션을 맞아 오히려 **가만히 있느니만 못한 결과**가 나왔습니다(15.1등 / 24명 중).
> 현재가보다 2% 높게 지르는 "즉시 매수" 버튼을 주면 체결률이 67%로 오르고 성적이 5.3등으로 뒤집힙니다.

---

## 8. HTS 화면 구성에 필요한 데이터 대응표

| 화면 요소 | 어디서 |
|---|---|
| 호가창 10단계 | `snapshot.stocks[].depth.bids / asks` |
| 현재가·등락률 | `stocks[].last`, `stocks[].changePct` |
| 시가/고가/저가/거래량 | `stocks[].open / high / low / volume` |
| 적정가 · 괴리율 배지 | `stocks[].fair`, `stocks[].vsFairPct` |
| 실시간 체결 틱 | `snapshot.tape` (최근 40건) |
| 분봉/틱 차트 | `GET /chart` 의 `history[]` (`price` 와 `fair` 두 선) |
| 잔고·평가손익 | `me.holdings[]` |
| 미체결 주문 | `me.openOrders[]` |
| 체결 팝업 | `me.newFills[]` (직전 전송 이후 신규분만) |
| 총자산·수익률 | `me.nav`, `me.nav / me.invested - 1` |
| 전체 종목 현황판 | `snapshot.stocks[]` 전체 |
| 순위표 | `snapshot.ranking[]` |
| 남은 시간 | `snapshot.remainSec` (공모 중에는 `ipoRemainSec`) |
| 공지 배너 | `snapshot.notices[]` |
| 돌발뉴스 배너 | `snapshot.news[]` (활성) + `notices[].kind === "news-up" / "news-down"` |
