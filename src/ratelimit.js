'use strict';

/**
 * 토큰 버킷 요청 제한.
 *
 * 행사장에서는 참가자 50명이 전부 같은 공인 IP(WiFi 공유기)를 쓴다.
 * 그래서 IP 기준으로 빡빡하게 걸면 정상 참가자가 막힌다.
 * 실질적인 보호는 참가자 토큰 기준으로 걸고, IP 기준은 폭주만 막을 만큼 느슨하게 둔다.
 */

class Limiter {
  /**
   * @param {number} capacity     버스트 허용량 (한 번에 몰아 쓸 수 있는 요청 수)
   * @param {number} refillPerSec 초당 회복량 (지속 가능한 속도)
   * @param {number} maxKeys      기억할 키 수 상한 (메모리 폭주 방지)
   */
  constructor(capacity, refillPerSec, maxKeys = 20000) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.maxKeys = maxKeys;
    this.buckets = new Map();   // key -> { tokens, at }
  }

  /** @returns {{ok: boolean, retryAfterMs: number}} */
  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      b = { tokens: this.capacity, at: now };
      this.buckets.set(key, b);
    }
    const dt = Math.max(0, now - b.at) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + dt * this.refill);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterMs: 0 };
    }
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / this.refill * 1000) };
  }

  /** 가득 찬(=한동안 안 쓴) 버킷을 버린다 */
  sweep(now = Date.now()) {
    for (const [k, b] of this.buckets) {
      const dt = Math.max(0, now - b.at) / 1000;
      if (b.tokens + dt * this.refill >= this.capacity) this.buckets.delete(k);
    }
    // 그래도 넘치면 오래된 것부터 버린다
    if (this.buckets.size >= this.maxKeys) {
      const drop = [...this.buckets.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, Math.ceil(this.maxKeys / 4));
      for (const [k] of drop) this.buckets.delete(k);
    }
  }

  reset() { this.buckets.clear(); }
}

module.exports = { Limiter };
