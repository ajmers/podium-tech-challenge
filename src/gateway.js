import http from 'node:http';
import { sendError, sendJson } from './http-utils.js';
import { createProxy } from './proxy.js';
import { createRouter } from './router.js';

/**
 * Build the gateway HTTP server from a normalized config.
 * Does not call listen() — the caller decides the port (tests use 0).
 *
 * Request flow (planned):
 *   /health  ->  built-in handler (always available, bypasses routing)
 *   else     ->  match route (404 if none, 405 if method not allowed)
 *            ->  route pipeline: auth -> rate limit -> circuit breaker
 *                -> request transform -> proxy (retry / timeout / LB)
 *                -> response transform
 */
export function createGateway(config, { now = Date.now } = {}) {
  const startedAt = now();
  const router = createRouter(config.routes);
  const proxy = createProxy();

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
    await proxy.forward(req, res, {
      target: pickTarget(route),
      path: upstreamPath + search,
      timeoutMs: route.upstream.timeoutMs,
    });
  }

  return server;
}

// TODO: load balancing (round_robin / weighted_round_robin) replaces this.
function pickTarget(route) {
  return route.upstream.targets[0].url;
}
