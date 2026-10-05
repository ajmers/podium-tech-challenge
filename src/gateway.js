import http from 'node:http';
import { sendError, sendJson } from './http-utils.js';

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

  async function handleRequest(req, res) {
    const { pathname } = new URL(req.url, 'http://gateway.local');

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        status: 'healthy',
        uptime_seconds: Math.floor((now() - startedAt) / 1000),
      });
      return;
    }

    // TODO: route matching + proxy pipeline (config.routes)
    sendError(res, 404, 'not_found');
  }

  return server;
}
