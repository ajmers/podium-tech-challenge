import http from 'node:http';
import { sendError, sendJson } from './http-utils.js';
import { createBalancer } from './balancer.js';
import { buildRouteHandler } from './pipeline.js';
import { createProxy } from './proxy.js';
import { createRouter } from './router.js';
import { DEFAULT_STAGES } from './stages/index.js';

/**
 * Build the gateway HTTP server from a normalized config.
 * Does not call listen() — the caller decides the port (tests use 0).
 *
 * Request flow:
 *   /health  ->  built-in handler (always available, bypasses routing)
 *   else     ->  match route (404 if none, 405 if method not allowed)
 *            ->  the route's pipeline (see src/pipeline.js and src/stages/)
 *            ->  proxy to upstream
 *
 * Each route's pipeline is built once here, so a stage with invalid config
 * throws ConfigError at startup rather than on the first request.
 *
 * @param {object} config            normalized config (see config/load.js)
 * @param {object} [options]
 * @param {() => number} [options.now]  clock, injectable for tests
 * @param {object[]} [options.stages]   stage list, defaults to DEFAULT_STAGES
 */
export function createGateway(config, { now = Date.now, stages = DEFAULT_STAGES } = {}) {
  const startedAt = now();
  const router = createRouter(config.routes);
  const proxy = createProxy();

  // One balancer per route, so each route rotates through its own targets.
  const balancers = new Map(config.routes.map((route) => [route, createBalancer(route.upstream)]));

  // Innermost handler of every pipeline: send the request upstream and record
  // the outcome so outer stages can react to it on the way out.
  const forward = async (ctx) => {
    ctx.outcome = await proxy.forward(ctx.req, ctx.res, {
      target: balancers.get(ctx.route).pick(),
      path: ctx.upstreamPath + ctx.search,
      timeoutMs: ctx.route.upstream.timeoutMs,
    });
  };

  const deps = { gateway: config.gateway, now };
  const routeHandlers = new Map(
    config.routes.map((route) => [route, buildRouteHandler(route, stages, forward, deps)]),
  );

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('Unhandled gateway error:', err);
      if (!res.headersSent) {
        sendError(res, 500, 'internal_error');
      } else {
        res.destroy(err);
      }
    });
  });

  server.on('close', () => proxy.close());

  async function handleRequest(req, res) {
    // Parsing also resolves "." and ".." segments, so "/api/users/../internal"
    // is matched (and forwarded) as "/api/internal" and can't sneak past a
    // route's checks.
    let url;
    try {
      url = new URL(req.url, 'http://gateway.local');
    } catch {
      sendError(res, 400, 'bad_request');
      return;
    }
    const { pathname, search } = url;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        status: 'healthy',
        uptime_seconds: Math.floor((now() - startedAt) / 1000),
      });
      return;
    }

    const match = router.match(req.method, pathname);
    if (match.type === 'not_found') {
      sendError(res, 404, 'not_found');
      return;
    }
    if (match.type === 'method_not_allowed') {
      res.setHeader('allow', match.allowed.join(', '));
      sendError(res, 405, 'method_not_allowed');
      return;
    }

    const { route, upstreamPath } = match;
    const ctx = {
      req,
      res,
      route,
      upstreamPath,
      search,
      clientIp: req.socket.remoteAddress,
      receivedAt: now(),
      outcome: null, // set by the proxy: { status, error? }
    };
    await routeHandlers.get(route)(ctx);
  }

  return server;
}
