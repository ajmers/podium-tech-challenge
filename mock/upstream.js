#!/usr/bin/env node
import http from 'node:http';

/**
 * A tiny configurable upstream used by tests and for local manual testing.
 *
 * Endpoints match on the *end* of the path, so they work behind any route
 * prefix (e.g. "/api/orders/slow" as well as "/slow"):
 *   GET  .../healthz          -> 200 ok
 *   ANY  .../slow?ms=N        -> responds after N ms (default 2000)
 *   ANY  .../status/:code     -> responds with that status code
 *   ANY  .../flaky            -> fails with 503 every other request
 *   ANY  *                    -> 200 echo of method, url, headers, body
 *
 * Every response carries X-Upstream-Name so tests can tell targets apart.
 */
export function createMockUpstream({ name = 'mock' } = {}) {
  let flakyCounter = 0;
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://upstream.local');
    const record = { method: req.method, url: req.url, headers: req.headers, body: bodyText, aborted: false };
    requests.push(record);
    res.on('close', () => {
      if (!res.writableFinished) record.aborted = true;
    });

    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-upstream-name': name,
        'x-powered-by': 'mock-upstream',
      });
      res.end(payload);
    };

    if (url.pathname.endsWith('/healthz')) return send(200, { status: 'ok' });

    if (url.pathname.endsWith('/slow')) {
      const ms = Number(url.searchParams.get('ms') ?? 2000);
      const timer = setTimeout(() => send(200, { slow: true, ms }), ms);
      res.on('close', () => clearTimeout(timer));
      return;
    }

    const statusMatch = /\/status\/(\d{3})$/.exec(url.pathname);
    if (statusMatch) return send(Number(statusMatch[1]), { status: Number(statusMatch[1]) });

    if (url.pathname.endsWith('/flaky')) {
      flakyCounter += 1;
      return flakyCounter % 2 === 1 ? send(503, { flaky: 'fail' }) : send(200, { flaky: 'ok' });
    }

    let body = bodyText;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // keep as text
    }
    send(200, { upstream: name, method: req.method, url: req.url, headers: req.headers, body });
  });

  return { server, requests };
}

// Run standalone: `node mock/upstream.js 3001 3002 ...` starts one mock per port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const ports = process.argv.slice(2).map(Number);
  const list = ports.length ? ports : [3001, 3002, 3003, 3004, 3005, 3006];
  for (const port of list) {
    const { server } = createMockUpstream({ name: `upstream-${port}` });
    server.listen(port, () => console.log(`mock upstream listening on :${port}`));
  }
}
