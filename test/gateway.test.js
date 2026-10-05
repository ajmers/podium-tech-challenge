import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rawRequest } from './helpers/http.js';
import { startGateway, startUpstream } from './helpers/servers.js';

// End-to-end: client -> gateway (routing) -> mock upstreams.
describe('gateway routing + proxying', () => {
  let users;
  let products;
  let slow;
  let gateway;

  before(async () => {
    users = await startUpstream({ name: 'users' });
    products = await startUpstream({ name: 'products' });
    slow = await startUpstream({ name: 'slow' });
    gateway = await startGateway({
      gateway: { global_timeout: '5s' },
      routes: [
        { path: '/api/users', methods: ['GET', 'POST'], upstream: { url: users.url } },
        { path: '/api/products', methods: ['GET'], strip_prefix: true, upstream: { url: products.url } },
        { path: '/api/slow', upstream: { url: slow.url, timeout: '100ms' }, strip_prefix: true },
        // Mirrors the auth-protected route in gateway.yaml
        { path: '/api/internal', methods: ['GET'], upstream: { url: 'http://127.0.0.1:1' } },
      ],
    });
  });
  after(async () => {
    await gateway.close();
    await Promise.all([users.close(), products.close(), slow.close()]);
  });

  it('proxies a matching request to the right upstream', async () => {
    const res = await fetch(`${gateway.url}/api/users/42?x=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.upstream, 'users');
    assert.equal(body.url, '/api/users/42?x=1');
  });

  it('forwards POST bodies', async () => {
    const res = await fetch(`${gateway.url}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    assert.deepEqual((await res.json()).body, { name: 'Ada' });
  });

  it('strips the prefix and keeps the query string', async () => {
    const res = await fetch(`${gateway.url}/api/products/123?color=red`);
    const body = await res.json();
    assert.equal(body.upstream, 'products');
    assert.equal(body.url, '/123?color=red');
  });

  it('returns 404 JSON for unmatched paths', async () => {
    const res = await fetch(`${gateway.url}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });

  it('returns 405 with an Allow header for disallowed methods', async () => {
    const res = await fetch(`${gateway.url}/api/products/1`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
    assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
    assert.equal(products.requests.filter((r) => r.method === 'POST').length, 0);
  });

  it('uses the per-route timeout', async () => {
    const res = await fetch(`${gateway.url}/api/slow/slow?ms=1000`);
    assert.equal(res.status, 504);
  });

  it('resolves ".." before matching so routes cannot be bypassed', async () => {
    const res = await rawRequest(gateway.url, { path: '/api/users/../internal/secrets' });
    // Matched (and handled) as /api/internal, not proxied to the users upstream.
    assert.notEqual(JSON.parse(res.body).upstream, 'users');
    assert.ok(!users.requests.some((r) => r.url.includes('internal')));
  });

  it('still serves /health', async () => {
    const res = await fetch(`${gateway.url}/health`);
    assert.equal(res.status, 200);
  });
});
