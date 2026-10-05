#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { startHarness } from './harness.js';
import { scenarios } from './scenarios.js';

/**
 * GatewayKit demo: a small web UI that runs the gateway against gateway.yaml
 * with mock upstreams, and shows each scenario's traffic end to end.
 *
 *   npm run demo                 -> http://localhost:8081
 *   npm run demo -- other.yaml   -> use a different config (scenarios assume gateway.yaml)
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 8081);
const CONFIG = process.argv[2] ?? join(ROOT, 'gateway.yaml');
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const harness = await startHarness(CONFIG, { gatewayPort: Number(process.env.GATEWAY_PORT ?? 0) });

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://demo.local');

  if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, harness.state());

  if (req.method === 'GET' && pathname === '/api/scenarios') {
    return json(res, 200, scenarios.map(({ id, group, title, description }) => ({ id, group, title, description })));
  }

  const scenarioMatch = /^\/api\/scenarios\/([\w-]+)\/run$/.exec(pathname);
  if (req.method === 'POST' && scenarioMatch) {
    const scenario = scenarios.find((s) => s.id === scenarioMatch[1]);
    if (!scenario) return json(res, 404, { error: 'unknown scenario' });
    const steps = await scenario.run(harness);
    const pass = steps.every((s) => s.checks.every((c) => c.pass));
    return json(res, 200, { id: scenario.id, pass, steps });
  }

  if (req.method === 'POST' && pathname === '/api/request') {
    const { method, path, headers, body } = await readJson(req);
    return json(res, 200, await harness.send({ method, path, headers, body }));
  }

  const upstreamMatch = /^\/api\/upstreams\/([^/]+)\/(start|stop)$/.exec(pathname);
  if (req.method === 'POST' && upstreamMatch) {
    await harness.setUpstream(decodeURIComponent(upstreamMatch[1]), upstreamMatch[2] === 'start');
    return json(res, 200, harness.state());
  }

  if (req.method === 'POST' && pathname === '/api/test-run') return streamTestRun(res);

  if (req.method === 'GET') return serveStatic(pathname === '/' ? '/index.html' : pathname, res);

  json(res, 404, { error: 'not found' });
}

/** Run the real test suite and stream its output to the browser. */
function streamTestRun(res) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', 'test/**/*.test.js'], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  child.stdout.pipe(res, { end: false });
  child.stderr.pipe(res, { end: false });
  child.on('close', (code) => res.end(`\n[exit ${code}]\n`));
  res.on('close', () => child.kill());
}

async function serveStatic(pathname, res) {
  const type = CONTENT_TYPES[extname(pathname)];
  if (!type || pathname.includes('..')) return json(res, 404, { error: 'not found' });
  try {
    const content = await readFile(join(PUBLIC, pathname));
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(content);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

server.on('error', (err) => {
  console.error(`Demo failed to start: ${err.message} (set DEMO_PORT to use another port)`);
  process.exit(1);
});
server.listen(DEMO_PORT, () => {
  const { gatewayUrl, upstreams } = harness.state();
  console.log(`GatewayKit demo:  http://localhost:${DEMO_PORT}`);
  console.log(`Gateway:          ${gatewayUrl}  (config: ${CONFIG})`);
  console.log(`Mock upstreams:   ${upstreams.map((u) => u.id).join(', ')}`);
});

const shutdown = async () => {
  server.close();
  await harness.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
