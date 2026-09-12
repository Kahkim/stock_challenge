'use strict';

/**
 * 연속경쟁매매 오더북 (가격 우선 → 시간 우선).
 *
 * 이 모듈은 현금/주식 정산을 하지 않는다. 호출자(게임 엔진)가 주문을 내기 전에
 * 매수는 지정가 × 수량만큼 현금을, 매도는 수량만큼 주식을 이미 예약해 둔 상태라고 가정한다.
 * 체결은 항상 지정가보다 같거나 유리한 가격에서만 일어나므로 예약분으로 항상 충당된다.
 */

let _seq = 0;

class Order {
  constructor(side, price, qty, owner) {
    this.id = 'o' + (++_seq);
    this.seq = _seq;
    this.side = side;      // 'buy' | 'sell'
    this.price = price;
    this.qty = qty;        // 남은 수량
    this.owner = owner;    // playerId
    this.ts = Date.now();
  }
}

class OrderBook {
  constructor(code) {
    this.code = code;
    this.bids = [];   // 가격 내림차순, 같은 가격이면 먼저 온 순
    this.asks = [];   // 가격 오름차순, 같은 가격이면 먼저 온 순
  }

  bestBid() { return this.bids.length ? this.bids[0].price : null; }
  bestAsk() { return this.asks.length ? this.asks[0].price : null; }

  _insert(arr, order, desc) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const o = arr[mid];
      // 가격이 유리한 쪽이 앞. 같은 가격이면 먼저 들어온(seq 작은) 쪽이 앞.
      const ahead = o.price === order.price ? o.seq < order.seq
                  : (desc ? o.price > order.price : o.price < order.price);
      if (ahead) lo = mid + 1; else hi = mid;
    }
    arr.splice(lo, 0, order);
  }

  /**
   * 지정가 주문을 넣는다. 체결 가능한 만큼 즉시 체결하고, 남으면 호가에 올린다.
   * @returns {{trades: Array<{price,qty,maker,taker,takerSide}>, rest: Order|null, filled: number}}
   */
  submit(side, price, qty, owner) {
    const want = qty;
    const trades = [];
    const opp = side === 'buy' ? this.asks : this.bids;

    let i = 0;
    while (qty > 0 && i < opp.length) {
      const top = opp[i];
      // 가격이 안 맞으면 뒤쪽은 더 불리하므로 종료
      if (side === 'buy' ? top.price > price : top.price < price) break;
      // 자기 주문과는 체결하지 않고 건너뛴다
      if (top.owner === owner) { i++; continue; }
      const take = Math.min(qty, top.qty);
      trades.push({ price: top.price, qty: take, maker: top.owner, taker: owner, takerSide: side });
      top.qty -= take;
      qty -= take;
      i++;
    }
    if (trades.length) {
      // 소진된 주문 제거 (앞쪽만 훑으면 되지만 안전하게 전체 필터)
      const keep = opp.filter(o => o.qty > 0);
      opp.length = 0;
      for (const o of keep) opp.push(o);
    }

    let rest = null;
    if (qty > 0) {
      rest = new Order(side, price, qty, owner);
      if (side === 'buy') this._insert(this.bids, rest, true);
      else this._insert(this.asks, rest, false);
    }
    return { trades, rest, filled: want - qty };
  }

  /** 주문 취소. 취소된 Order 를 반환(없으면 null) — 호출자가 예약분을 되돌려준다. */
  cancel(orderId) {
    for (const arr of [this.bids, this.asks]) {
      const i = arr.findIndex(o => o.id === orderId);
      if (i >= 0) return arr.splice(i, 1)[0];
    }
    return null;
  }

  /** 지정 시각보다 오래된 주문을 전부 걷어낸다. */
  expireBefore(ts) {
    const gone = [];
    for (const arr of [this.bids, this.asks]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].ts < ts) gone.push(arr.splice(i, 1)[0]);
      }
    }
    return gone;
  }

  /** 한 참가자의 미체결 주문 목록 */
  openOrders(owner) {
    return [...this.bids, ...this.asks]
      .filter(o => o.owner === owner)
      .map(o => ({ id: o.id, side: o.side, price: o.price, qty: o.qty, code: this.code }));
  }

  /** HTS 호가창용: 가격대별로 합산한 상위 N단계 */
  depth(levels = 10) {
    const agg = (arr) => {
      const out = [];
      for (const o of arr) {
        const last = out[out.length - 1];
        if (last && last.price === o.price) { last.qty += o.qty; continue; }
        if (out.length >= levels) break;
        out.push({ price: o.price, qty: o.qty });
      }
      return out;
    };
    return { bids: agg(this.bids), asks: agg(this.asks) };
  }
}

/**
 * 주문 번호 카운터를 끌어올린다. 저장된 상태를 복원할 때, 새로 나갈 주문 번호가
 * 복원된 주문 번호와 겹치지 않도록 맞춰 준다.
 */
function bumpSeq(n) { if (Number.isFinite(n) && n > _seq) _seq = Math.floor(n); }

/** 저장된 평면 객체에서 Order 를 되살린다 */
Order.from = function (o) {
  const x = Object.create(Order.prototype);
  x.id = o.id; x.seq = o.seq; x.side = o.side;
  x.price = o.price; x.qty = o.qty; x.owner = o.owner; x.ts = o.ts;
  bumpSeq(o.seq);
  return x;
};

module.exports = { OrderBook, Order, bumpSeq };
