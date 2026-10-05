/**
 * The per-route request pipeline.
 *
 * Every config feature (auth, rate limiting, circuit breaking, ...) is a
 * *stage*: an object with a name and a `create(route, deps)` factory.
 *
 *   const stage = {
 *     name: 'auth',
 *     create(route, deps) {
 *       if (!route.auth) return null;          // route doesn't use this feature
 *       const keys = new Set(route.auth.keys);  // validate + precompute once
 *       return async (ctx, next) => {           // runs per request
 *         if (!keys.has(ctx.req.headers['x-api-key'])) return sendError(ctx.res, 401, 'unauthorized');
 *         await next();
 *       };
 *     },
 *   };
 *
 * `create` runs once per route at startup, so a stage validates its own config
 * block there (throwing ConfigError) and pays no per-request setup cost.
 * Routes only run the stages they actually configure.
 *
 * Handlers form an onion around the proxy, like Koa middleware:
 *   - code before `await next()` sees the request on the way in,
 *   - code after it sees `ctx.outcome` on the way out,
 *   - not calling `next()` short-circuits (the stage must respond itself),
 *   - calling `next()` again re-runs everything inward (used by retry).
 */

/**
 * Build the handler for one route from the ordered stage list.
 * @param {object} route      normalized route config
 * @param {object[]} stages   ordered stage definitions
 * @param {Function} terminal (ctx) => Promise, the innermost handler (the proxy)
 * @param {object} deps       shared dependencies passed to every stage (clock, gateway config)
 */
export function buildRouteHandler(route, stages, terminal, deps) {
  const handlers = [];
  const inspectors = {};
  for (const stage of stages) {
    const handler = stage.create(route, deps);
    if (!handler) continue;
    handlers.push(handler);
    // A stage can optionally expose read-only state for observability.
    if (typeof handler.inspect === 'function') inspectors[stage.name] = handler.inspect;
  }
  const run = compose(handlers, terminal);
  run.inspect = () => Object.fromEntries(Object.entries(inspectors).map(([name, inspect]) => [name, inspect()]));
  return run;
}

/** Compose `(ctx, next)` handlers around a terminal `(ctx)` handler. */
export function compose(handlers, terminal) {
  return function run(ctx) {
    const dispatch = async (i) => {
      if (i === handlers.length) return terminal(ctx);
      return handlers[i](ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}
