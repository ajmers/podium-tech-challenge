/**
 * In-memory rate limiting algorithms. Each limiter tracks one bucket per key
 * (client IP, or "global") and exposes a synchronous `hit(key)`.
 *
 * `hit` checks and increments in one synchronous step. Node runs one piece of
 * JavaScript at a time, so concurrent requests can't race between the check and
 * the increment: exactly `limit` requests get through, however many arrive at once.
 *
 * A key's window starts at its first request, not at fixed clock times. That
 * keeps every client from resetting at the same moment (which would cause a
 * burst at each boundary) and makes behaviour deterministic in tests.
 *
 * Expired buckets are swept during normal hits, at most once per window, so
 * memory stays bounded by the number of recently active keys without needing
 * a background timer.
 *
 * hit(key) -> { allowed, limit, remaining, retryAfterMs }
 */

/** Fixed window: at most `limit` hits per window; the count resets when the window ends. */
export function createFixedWindowLimiter({ limit, windowMs, now }) {
  const buckets = new Map();
  const sweep = sweeper(buckets, windowMs, (bucket, t) => t >= bucket.start + windowMs);

  function hit(key) {
    const t = now();
    sweep(t);
    let bucket = buckets.get(key);
    if (!bucket || t >= bucket.start + windowMs) {
      bucket = { start: t, count: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.count < limit) {
      bucket.count += 1;
      return { allowed: true, limit, remaining: limit - bucket.count, retryAfterMs: 0 };
    }
    return { allowed: false, limit, remaining: 0, retryAfterMs: bucket.start + windowMs - t };
  }

  return { hit, size: () => buckets.size };
}

/**
 * Sliding window, using the common two-window estimate:
 *   used = previous_count * (portion of the previous window still in range) + current_count
 * This smooths out the boundary burst a fixed window allows (up to 2x the
 * limit across a reset) while storing two counters per key, not a timestamp
 * for every request.
 */
export function createSlidingWindowLimiter({ limit, windowMs, now }) {
  const buckets = new Map();
  const sweep = sweeper(buckets, windowMs, (bucket, t) => t >= bucket.start + 2 * windowMs);

  function roll(bucket, t) {
    if (t < bucket.start + windowMs) return;
    if (t < bucket.start + 2 * windowMs) {
      bucket.previous = bucket.current;
      bucket.start += windowMs;
    } else {
      bucket.previous = 0;
      bucket.start = t;
    }
    bucket.current = 0;
  }

  function hit(key) {
    const t = now();
    sweep(t);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { start: t, previous: 0, current: 0 };
      buckets.set(key, bucket);
    }
    roll(bucket, t);

    const elapsed = t - bucket.start;
    const used = bucket.previous * (1 - elapsed / windowMs) + bucket.current;
    if (used + 1 <= limit) {
      bucket.current += 1;
      return { allowed: true, limit, remaining: Math.max(0, Math.floor(limit - used - 1)), retryAfterMs: 0 };
    }
    // Round up so a client that waits exactly this long is never rejected again.
    return { allowed: false, limit, remaining: 0, retryAfterMs: Math.ceil(slidingWait(bucket, elapsed, limit, windowMs)) };
  }

  return { hit, size: () => buckets.size };
}

/** How long until one more hit would fit under the sliding estimate. */
function slidingWait({ previous, current }, elapsed, limit, windowMs) {
  if (current + 1 <= limit) {
    // Fits later in this window, once enough of `previous` has slid out.
    const fitsAt = windowMs * (1 - (limit - current - 1) / previous);
    return Math.max(0, fitsAt - elapsed);
  }
  // Must wait for the next window, where today's count becomes `previous`.
  const fitsAtNext = Math.max(0, windowMs * (1 - (limit - 1) / current));
  return windowMs - elapsed + fitsAtNext;
}

function sweeper(buckets, windowMs, isExpired) {
  let lastSweep = -Infinity;
  return (t) => {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, bucket] of buckets) {
      if (isExpired(bucket, t)) buckets.delete(key);
    }
  };
}
