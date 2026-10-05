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
export const DEFAULT_STAGES = [];
