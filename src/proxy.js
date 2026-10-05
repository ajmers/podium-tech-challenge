import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { sendError } from './http-utils.js';

// Headers that describe a single connection and must not be forwarded
// (RFC 9110 §7.6.1). Any header named in `Connection` is also hop-by-hop.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Create a proxy with its own keep-alive connection pools.
 *
 * `forward()` streams the client request to a single upstream target and
 * streams the response back. It always settles the client response itself
 * (upstream response, 502, or 504) and resolves with an outcome describing
 * what happened, so later pipeline stages (retry, circuit breaker, metrics)
 * can react without re-inspecting the response.
 */
export function createProxy({ maxSockets = 256 } = {}) {
  const agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets }),
    'https:': new https.Agent({ keepAlive: true, maxSockets }),
  };

  /**
   * @param {http.IncomingMessage} req  client request
   * @param {http.ServerResponse} res   client response
   * @param {object} options
   * @param {string} options.target     upstream base URL, e.g. "http://localhost:3001"
   * @param {string} options.path       path + query to request on the upstream
   * @param {number} options.timeoutMs  max wait for upstream response headers
   * @returns {Promise<{status: number|null, error?: string}>}
   */
  function forward(req, res, { target, path, timeoutMs }) {
    return new Promise((resolve) => {
      const url = buildUpstreamUrl(target, path);
      const transport = url.protocol === 'https:' ? https : http;

      let settled = false;
      let timedOut = false;
      let clientGone = false;
      let responseStarted = false;

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const upstreamReq = transport.request(url, {
        method: req.method,
        headers: buildUpstreamHeaders(req, url),
        agent: agents[url.protocol],
      });

      // The timeout bounds time-to-first-byte: once the upstream starts
      // responding, the body streams for as long as it takes.
      const timer = setTimeout(() => {
        timedOut = true;
        upstreamReq.destroy();
      }, timeoutMs);

      // If the client goes away before we finish, stop the upstream work too.
      res.on('close', () => {
        if (!res.writableFinished) {
          clientGone = true;
          upstreamReq.destroy();
        }
      });

      upstreamReq.on('response', (upstreamRes) => {
        responseStarted = true;
        clearTimeout(timer);
        const status = upstreamRes.statusCode;
        res.writeHead(status, stripHopByHop(upstreamRes.headers));
        pipeline(upstreamRes, res, (err) => {
          finish(err ? { status, error: clientGone ? 'client_aborted' : 'response_aborted' } : { status });
        });
      });

      upstreamReq.on('error', (err) => {
        if (responseStarted) return; // the response pipeline reports this
        if (clientGone) return finish({ status: null, error: 'client_aborted' });
        if (timedOut) {
          sendError(res, 504, 'gateway_timeout');
          return finish({ status: 504, error: 'timeout' });
        }
        sendError(res, 502, 'bad_gateway');
        finish({ status: 502, error: err.code ?? 'upstream_error' });
      });

      // Stream the request body. Failures surface through upstreamReq 'error'.
      pipeline(req, upstreamReq, () => {});
    });
  }

  function close() {
    for (const agent of Object.values(agents)) agent.destroy();
  }

  return { forward, close };
}

/**
 * Join an upstream base URL with a request path, keeping any base path:
 *   ("http://host:3001",     "/users?x=1") -> http://host:3001/users?x=1
 *   ("http://host:3001/v2/", "/users")     -> http://host:3001/v2/users
 * The origin is always taken from the target, so a request path like
 * "//evil.com/x" can never change which host we connect to.
 */
export function buildUpstreamUrl(target, path) {
  const base = new URL(target);
  const basePath = base.pathname.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return new URL(`${base.origin}${basePath}${suffix}`);
}

function buildUpstreamHeaders(req, url) {
  const headers = stripHopByHop(req.headers);
  const clientIp = req.socket.remoteAddress;
  const priorFor = req.headers['x-forwarded-for'];

  headers.host = url.host;
  headers['x-forwarded-for'] = priorFor ? `${priorFor}, ${clientIp}` : clientIp;
  headers['x-forwarded-host'] ??= req.headers.host;
  headers['x-forwarded-proto'] ??= 'http';
  return headers;
}

function stripHopByHop(headers) {
  const listed = String(headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && !listed.includes(name)) out[name] = value;
  }
  return out;
}
