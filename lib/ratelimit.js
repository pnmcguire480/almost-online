'use strict';

// Token-bucket rate limiter for one connection's inbound frames.
// `capacity` frames may arrive in a burst, then `perSecond` frames are allowed each second.
//
// Time comes from a monotonic clock, never the wall clock. The wall clock can be stepped backwards (NTP, or a
// manual change), and a limiter that read it would see negative elapsed time and drop frames until the clock caught up.

const { performance } = require('node:perf_hooks');

// Milliseconds since an arbitrary fixed point. Unlike Date.now(), it never goes backwards.
function monotonicMs() {
  return performance.now();
}

class RateLimiter {
  constructor({ capacity, perSecond, now = monotonicMs }) {
    this.capacity = capacity;
    this.perMillisecond = perSecond / 1000;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  // Returns true when the frame may be processed, false when it must be dropped.
  take() {
    const current = this.now();
    // A reading earlier than the last one adds no tokens. Counting then restarts from that reading,
    // so the bucket refills normally again as soon as time moves forward.
    const elapsed = Math.max(0, current - this.last);
    this.last = current;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perMillisecond);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

module.exports = { RateLimiter, monotonicMs };
