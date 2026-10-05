import { ConfigError } from '../config/load.js';
import { parseDuration } from '../config/duration.js';
import { sendError } from '../http-utils.js';
import { createFixedWindowLimiter, createSlidingWindowLimiter } from '../rate-limiters.js';

const STRATEGIES = {
  fixed_window: createFixedWindowLimiter,
  sliding_window: createSlidingWindowLimiter,
};
const PER = ['ip', 'global'];

/**
 * Rate limiting.
 *
 *   gateway.global_rate_limit   default for every route
 *   routes[].rate_limit         replaces (does not stack with) the global limit
 *
 *   { requests: 30, window: "60s", strategy: "sliding_window", per: "ip" }
 *
 * Every route gets its own counters, even when it uses the global settings:
 * "global_rate_limit" is a default policy, not one budget shared by all routes.
 * per: "ip" counts each client separately (by socket address, since
 * X-Forwarded-For can be forged); per: "global" counts all clients together.
 *
 * Over the limit: 429 { error: "rate_limited", retry_after: <seconds> } with a
 * Retry-After header. All responses carry X-RateLimit-Limit / -Remaining.
 */
export const rateLimitStage = {
  name: 'rate_limit',

  create(route, { gateway, now }) {
    // Validate the global block even when this route overrides it, so a bad
    // global config is always reported at startup.
    const global = gateway.globalRateLimit ? parseRateLimit(gateway.globalRateLimit, 'gateway.global_rate_limit') : null;
    const own = route.rate_limit !== undefined ? parseRateLimit(route.rate_limit, `route "${route.path}" rate_limit`) : null;
    const settings = own ?? global;
    if (!settings) return null;

    const limiter = STRATEGIES[settings.strategy]({ limit: settings.requests, windowMs: settings.windowMs, now });

    return async (ctx, next) => {
      const key = settings.per === 'global' ? 'global' : ctx.clientIp;
      const result = limiter.hit(key);
      ctx.res.setHeader('x-ratelimit-limit', result.limit);
      ctx.res.setHeader('x-ratelimit-remaining', result.remaining);
      if (!result.allowed) {
        const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        ctx.res.setHeader('retry-after', retryAfter);
        sendError(ctx.res, 429, 'rate_limited', { retry_after: retryAfter });
        return;
      }
      await next();
    };
  },
};

export function parseRateLimit(block, where) {
  if (!block || typeof block !== 'object') {
    throw new ConfigError(`${where} must be a mapping`);
  }
  const { requests, window, strategy = 'fixed_window', per = 'ip' } = block;
  if (!Number.isInteger(requests) || requests < 1) {
    throw new ConfigError(`${where}.requests must be a positive integer`);
  }
  let windowMs;
  try {
    windowMs = parseDuration(window);
  } catch (err) {
    throw new ConfigError(`${where}.window: ${err.message}`);
  }
  if (windowMs <= 0) {
    throw new ConfigError(`${where}.window must be greater than zero`);
  }
  if (!(strategy in STRATEGIES)) {
    throw new ConfigError(`${where}.strategy must be one of: ${Object.keys(STRATEGIES).join(', ')}`);
  }
  if (!PER.includes(per)) {
    throw new ConfigError(`${where}.per must be one of: ${PER.join(', ')}`);
  }
  return { requests, windowMs, strategy, per };
}
