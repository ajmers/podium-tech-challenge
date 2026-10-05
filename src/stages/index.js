import { authStage } from './auth.js';
import { circuitBreakerStage } from './circuit-breaker.js';
import { rateLimitStage } from './rate-limit.js';

/**
 * The default stage order. Order matters: cheap checks that reject requests
 * run first, so unauthenticated or over-limit traffic never costs an upstream
 * call or counts against the circuit breaker.
 *
 *   auth -> rate limit -> circuit breaker -> transforms -> retry -> [proxy]
 *
 * To add a feature: create a stage module in this directory (see
 * src/pipeline.js for the shape) and add it to this list.
 */
export const DEFAULT_STAGES = [authStage, rateLimitStage, circuitBreakerStage];

// Route-level config blocks the schema defines. Each is handled by the stage
// of the same name, or (for upstream-level features) elsewhere.
const ROUTE_FEATURES = ['auth', 'rate_limit', 'circuit_breaker', 'retry', 'request_transform', 'response_transform', 'health_check'];

/**
 * Config blocks that a route sets but no stage implements yet. These are
 * ignored at runtime, so the gateway warns at startup rather than letting
 * someone believe e.g. a circuit breaker is protecting a route.
 * @returns {{ path: string, feature: string }[]}
 */
export function findUnimplementedFeatures(routes, stages = DEFAULT_STAGES) {
  const implemented = new Set(stages.map((stage) => stage.name));
  return routes.flatMap((route) =>
    ROUTE_FEATURES.filter((feature) => route[feature] !== undefined && !implemented.has(feature)).map((feature) => ({
      path: route.path,
      feature,
    })),
  );
}
