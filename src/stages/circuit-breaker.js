import { ConfigError } from '../config/load.js';
import { parseDuration } from '../config/duration.js';
import { sendError } from '../http-utils.js';

/**
 * Circuit breaker.
 *
 *   circuit_breaker:
 *     threshold: 5      # trip after 5 failures...
 *     window: "60s"     # ...within 60s
 *     cooldown: "30s"   # then reject for 30s before trying the upstream again
 *
 *   CLOSED ──threshold failures in window──▶ OPEN ──cooldown passes──▶ HALF-OPEN
 *     ▲                                       ▲                          │
 *     └────────── trial request succeeds ─────┼──────────────────────────┤
 *                                             └──── trial request fails ─┘
 *
 * While OPEN, requests get 503 { error: "service_unavailable", retry_after }
 * immediately, without touching the upstream, so a struggling service gets
 * room to recover and clients fail fast instead of waiting for timeouts.
 * HALF-OPEN lets exactly one trial request through.
 *
 * A failure is any 5xx outcome, including the gateway's own 502 (unreachable)
 * and 504 (timeout). 4xx responses and client disconnects are not upstream
 * failures and are ignored. A success doesn't erase earlier failures: the
 * breaker trips on `threshold` failures within the window, as configured.
 *
 * State is per route, since the config block is per route.
 */
export const circuitBreakerStage = {
  name: 'circuit_breaker',

  create(route, { now }) {
    if (route.circuit_breaker === undefined) return null;
    const { threshold, windowMs, cooldownMs } = parseCircuitBreaker(route.circuit_breaker, `route "${route.path}" circuit_breaker`);

    let state = 'closed';
    let openedAt = 0;
    let trialInFlight = false;
    let failures = []; // timestamps of recent failures, oldest first

    const reject = (res, retryAfterMs) => {
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader('retry-after', retryAfter);
      sendError(res, 503, 'service_unavailable', { retry_after: retryAfter });
    };

    const open = (t) => {
      state = 'open';
      openedAt = t;
      failures = [];
    };

    const handler = async (ctx, next) => {
      const t = now();

      if (state === 'open') {
        const remaining = openedAt + cooldownMs - t;
        if (remaining > 0) return reject(ctx.res, remaining);
        state = 'half_open';
      }

      let isTrial = false;
      if (state === 'half_open') {
        if (trialInFlight) return reject(ctx.res, 1000);
        trialInFlight = true;
        isTrial = true;
      }

      try {
        await next();
      } finally {
        if (isTrial) trialInFlight = false;
      }

      const failed = isFailure(ctx.outcome);
      const finishedAt = now();
      if (isTrial) {
        if (failed) open(finishedAt);
        else if (ctx.outcome?.error !== 'client_aborted') {
          state = 'closed';
          failures = [];
        }
        return;
      }
      if (!failed) return;

      failures = failures.filter((at) => finishedAt - at < windowMs);
      failures.push(finishedAt);
      if (failures.length >= threshold) open(finishedAt);
    };

    // Read-only view for observability (the demo UI polls this).
    handler.inspect = () => {
      const t = now();
      const remaining = openedAt + cooldownMs - t;
      return {
        state: state === 'open' && remaining <= 0 ? 'half_open' : state,
        failures: failures.filter((at) => t - at < windowMs).length,
        threshold,
        retryAfterSeconds: state === 'open' && remaining > 0 ? Math.ceil(remaining / 1000) : 0,
      };
    };
    return handler;
  },
};

function isFailure(outcome) {
  if (!outcome || outcome.error === 'client_aborted') return false;
  return outcome.status === null || outcome.status >= 500;
}

function parseCircuitBreaker(block, where) {
  if (!block || typeof block !== 'object') {
    throw new ConfigError(`${where} must be a mapping`);
  }
  const { threshold, window, cooldown } = block;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new ConfigError(`${where}.threshold must be a positive integer`);
  }
  const duration = (value, field) => {
    let ms;
    try {
      ms = parseDuration(value);
    } catch (err) {
      throw new ConfigError(`${where}.${field}: ${err.message}`);
    }
    if (ms <= 0) throw new ConfigError(`${where}.${field} must be greater than zero`);
    return ms;
  };
  return { threshold, windowMs: duration(window, 'window'), cooldownMs: duration(cooldown, 'cooldown') };
}
