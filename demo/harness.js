import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';
import { createMockUpstream } from '../mock/upstream.js';
import { normalizeConfig } from '../src/config/load.js';
import { createGateway } from '../src/gateway.js';
import { DEFAULT_STAGES } from '../src/stages/index.js';
import { parseRateLimit } from '../src/stages/rate-limit.js';

/**
 * Runs a real gateway from a config file, with one in-process mock upstream
 * per distinct upstream URL in that config. Upstream URLs are rewritten to
 * point at the mocks, so every route in the config is live.
 *
 * `send()` makes a request through the gateway and reports what the client
 * sent, what came back, and what (if anything) each upstream received.
 */
export async function startHarness(configPath, { gatewayPort = 0 } = {}) {
  const raw = parseYaml(await readFile(configPath, 'utf8'));

  // One mock per distinct upstream URL, labelled by its original host:port.
  const upstreams = new Map();
  for (const route of raw.routes ?? []) {
    for (const target of upstreamTargets(route)) {
      if (!upstreams.has(target.url)) {
        const id = new URL(target.url).host;
        const { server, requests } = createMockUpstream({ name: id });
        upstreams.set(target.url, { id, originalUrl: target.url, routes: [], server, requests, port: 0, up: false });
      }
      const entry = upstreams.get(target.url);
      if (!entry.routes.includes(route.path)) entry.routes.push(route.path);
    }
  }
  for (const upstream of upstreams.values()) await startUpstream(upstream);

  for (const route of raw.routes ?? []) {
    for (const target of upstreamTargets(route)) {
      target.url = `http://127.0.0.1:${upstreams.get(target.url).port}`;
    }
  }

  const config = normalizeConfig(raw);
  let gateway;
  let gatewayAddress = { port: gatewayPort };

  /** (Re)start the gateway on the same port, so in-memory state like rate-limit counters starts fresh. */
  async function restartGateway() {
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
    }
    gateway = createGateway(config);
    gateway.listen(gatewayAddress.port, '127.0.0.1');
    await once(gateway, 'listening');
    gatewayAddress = gateway.address();
  }
  await restartGateway();
  const byId = new Map([...upstreams.values()].map((u) => [u.id, u]));

  function snapshot() {
    return new Map([...byId.values()].map((u) => [u.id, u.requests.length]));
  }

  function upstreamRequestsSince(before) {
    const seen = [];
    for (const u of byId.values()) {
      for (const record of u.requests.slice(before.get(u.id))) {
        seen.push({ upstream: u.id, ...record, body: parseMaybeJson(record.body) });
      }
    }
    return seen;
  }

  /**
   * Send one request through the gateway with a raw http.request, so paths
   * like "/a/../b" and hop-by-hop headers go out exactly as written.
   */
  async function send({ method = 'GET', path = '/', headers = {}, body, abortAfterMs } = {}) {
    let payload;
    const outgoingHeaders = { ...headers };
    if (body !== undefined && body !== '') {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof body !== 'string') outgoingHeaders['content-type'] ??= 'application/json';
    }

    const before = snapshot();
    const started = performance.now();
    const response = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: gatewayAddress.port, method, path, headers: outgoingHeaders, agent: false },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: parseMaybeJson(Buffer.concat(chunks).toString('utf8')),
            }),
          );
          res.on('error', (err) => resolve({ error: err.message }));
        },
      );
      req.on('error', (err) => resolve({ error: err.message }));
      if (abortAfterMs !== undefined) {
        setTimeout(() => {
          req.destroy();
          resolve({ aborted: true });
        }, abortAfterMs);
      }
      req.end(payload);
    });
    const durationMs = Math.round(performance.now() - started);

    // Let upstream 'close' events land so cancellations are recorded.
    await sleep(50);

    return {
      request: { method, path, headers: outgoingHeaders, body: parseMaybeJson(payload) },
      response: { ...response, durationMs },
      upstream: upstreamRequestsSince(before),
    };
  }

  async function setUpstream(id, up) {
    const upstream = byId.get(id);
    if (!upstream) throw new Error(`Unknown upstream ${id}`);
    if (up && !upstream.up) await startUpstream(upstream);
    if (!up && upstream.up) await stopUpstream(upstream);
  }

  function state() {
    return {
      configPath,
      gatewayUrl: `http://127.0.0.1:${gatewayAddress.port}`,
      // Stage names match their config keys (auth, rate_limit, ...).
      implementedFeatures: DEFAULT_STAGES.map((stage) => stage.name),
      routes: config.routes.map((route) => ({
        path: route.path,
        methods: route.methods,
        stripPrefix: route.strip_prefix,
        timeoutMs: route.upstream.timeoutMs,
        upstreams: route.upstream.targets.map((t) => [...byId.values()].find((u) => t.url.endsWith(`:${u.port}`))?.id),
        balance: route.upstream.balance,
        targets: route.upstream.targets.map((t) => ({
          id: [...byId.values()].find((u) => t.url.endsWith(`:${u.port}`))?.id,
          weight: t.weight,
        })),
        features: FEATURE_KEYS.filter((key) => route[key] !== undefined),
        rateLimit: effectiveRateLimit(route, config.gateway.globalRateLimit),
      })),
      upstreams: [...byId.values()].map((u) => ({
        id: u.id,
        routes: u.routes,
        up: u.up,
        requestCount: u.requests.length,
      })),
    };
  }

  async function close() {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    for (const u of byId.values()) await stopUpstream(u);
  }

  return { send, setUpstream, restartGateway, state, close };
}

const FEATURE_KEYS = [
  'auth',
  'rate_limit',
  'retry',
  'circuit_breaker',
  'health_check',
  'request_transform',
  'response_transform',
];

/** The rate limit that applies to a route, and where it comes from. */
function effectiveRateLimit(route, globalRateLimit) {
  const block = route.rate_limit ?? globalRateLimit;
  if (!block) return null;
  const { requests, windowMs, strategy, per } = parseRateLimit(block, 'rate_limit');
  return { requests, windowMs, strategy, per, source: route.rate_limit ? 'route' : 'global' };
}

function upstreamTargets(route) {
  if (route.upstream?.url) return [route.upstream];
  return route.upstream?.targets ?? [];
}

async function startUpstream(upstream) {
  // Reuse the same port after a restart so the gateway's config still points at it.
  upstream.server.listen(upstream.port, '127.0.0.1');
  await once(upstream.server, 'listening');
  upstream.port = upstream.server.address().port;
  upstream.up = true;
}

async function stopUpstream(upstream) {
  upstream.server.closeAllConnections();
  await new Promise((resolve) => upstream.server.close(resolve));
  upstream.up = false;
}

function parseMaybeJson(text) {
  if (typeof text !== 'string' || text === '') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
