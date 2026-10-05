import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixedWindowLimiter, createSlidingWindowLimiter } from '../src/rate-limiters.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const hitN = (limiter, key, n) => Array.from({ length: n }, () => limiter.hit(key));

describe('fixed window limiter', () => {
  it('allows `limit` hits, then denies with time until the window ends', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 10_000, now: clock.now });
    assert.deepEqual(hitN(limiter, 'a', 3).map((r) => r.remaining), [2, 1, 0]);
    clock.advance(4_000);
    assert.deepEqual(limiter.hit('a'), { allowed: false, limit: 3, remaining: 0, retryAfterMs: 6_000 });
  });

  it('starts a fresh window once the old one ends', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 10_000, now: clock.now });
    assert.equal(limiter.hit('a').allowed, true);
    clock.advance(9_999);
    assert.equal(limiter.hit('a').allowed, false);
    clock.advance(1);
    assert.equal(limiter.hit('a').allowed, true);
  });

  it('counts keys separately', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 10_000, now: clock.now });
    assert.equal(limiter.hit('a').allowed, true);
    assert.equal(limiter.hit('b').allowed, true);
    assert.equal(limiter.hit('a').allowed, false);
  });

  it('allows a 2x burst across a window boundary (why sliding window exists)', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 10, windowMs: 10_000, now: clock.now });
    limiter.hit('a');
    clock.advance(9_900);
    const late = hitN(limiter, 'a', 9).filter((r) => r.allowed).length;
    clock.advance(100);
    const early = hitN(limiter, 'a', 10).filter((r) => r.allowed).length;
    assert.equal(1 + late + early, 20); // 20 requests in ~10s against a limit of 10
  });

  it('sweeps expired buckets so memory stays bounded', () => {
    const clock = fakeClock();
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1_000, now: clock.now });
    for (let i = 0; i < 100; i += 1) limiter.hit(`ip-${i}`);
    assert.equal(limiter.size(), 100);
    clock.advance(1_000);
    limiter.hit('new');
    assert.equal(limiter.size(), 1);
  });
});

describe('sliding window limiter', () => {
  it('allows `limit` hits in the first window', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ limit: 10, windowMs: 10_000, now: clock.now });
    assert.equal(hitN(limiter, 'a', 12).filter((r) => r.allowed).length, 10);
  });

  it('weights the previous window by how much of it is still in range', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ limit: 10, windowMs: 10_000, now: clock.now });
    hitN(limiter, 'a', 10);

    clock.advance(10_000); // previous=10 at full weight -> nothing fits
    assert.equal(limiter.hit('a').allowed, false);

    clock.advance(5_000); // previous=10 at half weight -> 5 used, 5 more fit
    assert.equal(hitN(limiter, 'a', 8).filter((r) => r.allowed).length, 5);
  });

  it('blocks the boundary burst a fixed window allows', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ limit: 10, windowMs: 10_000, now: clock.now });
    limiter.hit('a');
    clock.advance(9_900);
    const late = hitN(limiter, 'a', 9).filter((r) => r.allowed).length;
    clock.advance(100);
    const early = hitN(limiter, 'a', 10).filter((r) => r.allowed).length;
    assert.equal(1 + late + early, 10);
  });

  it('reports how long until the next hit would fit', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ limit: 10, windowMs: 10_000, now: clock.now });
    hitN(limiter, 'a', 10);
    // Full now: wait for the next window (10s) plus 1s for 1/10 of it to slide out.
    assert.equal(limiter.hit('a').retryAfterMs, 11_000);

    clock.advance(10_000);
    const denied = limiter.hit('a');
    assert.equal(denied.retryAfterMs, 1_000);
    clock.advance(denied.retryAfterMs);
    assert.equal(limiter.hit('a').allowed, true);
  });

  it('forgets the previous window after a long gap', () => {
    const clock = fakeClock();
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 10_000, now: clock.now });
    hitN(limiter, 'a', 2);
    clock.advance(25_000);
    assert.equal(hitN(limiter, 'a', 2).filter((r) => r.allowed).length, 2);
  });
});
