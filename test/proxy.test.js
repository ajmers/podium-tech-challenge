import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildUpstreamUrl } from '../src/proxy.js';
import { rawRequest } from './helpers/http.js';
import { startProxy, startUpstream } from './helpers/servers.js';

describe('buildUpstreamUrl', () => {
  it('joins origin and path, keeping the query string', () => {
    assert.equal(buildUpstreamUrl('http://h:3001', '/users?x=1&y=2').href, 'http://h:3001/users?x=1&y=2');
  });

  it('keeps a base path on the target', () => {
    assert.equal(buildUpstreamUrl('http://h:3001/v2/', '/users').href, 'http://h:3001/v2/users');
  });

  it('never lets the request path change the host', () => {
    assert.equal(buildUpstreamUrl('http://h:3001', '//evil.com/x').host, 'h:3001');
  });
});

describe('proxy forwarding', () => {
  let upstream;
  let proxy;

  before(async () => {
    upstream = await startUpstream({ name: 'users' });
    proxy = await startProxy({ target: upstream.url });
  });
  after(async () => {
    await proxy.close();
    await upstream.close();
  });

  it('forwards method, path and query, and returns the upstream response', async () => {
    const res = await fetch(`${proxy.url}/api/users/42?expand=true`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-upstream-name'), 'users');
    const body = await res.json();
    assert.equal(body.method, 'GET');
    assert.equal(body.url, '/api/users/42?expand=true');
    assert.deepEqual(proxy.outcomes.at(-1), { status: 200 });
  });

  it('streams request bodies through', async () => {
    const res = await fetch(`${proxy.url}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    assert.deepEqual((await res.json()).body, { name: 'Ada' });
  });

  it('handles large bodies', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const res = await fetch(`${proxy.url}/upload`, { method: 'PUT', body: big });
    assert.equal(res.status, 200);
    assert.equal(upstream.requests.at(-1).body.length, big.length);
  });

  it('passes upstream error statuses through unchanged', async () => {
    const res = await fetch(`${proxy.url}/status/503`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 503 });
    assert.deepEqual(proxy.outcomes.at(-1), { status: 503 });
  });

  it('sets Host and X-Forwarded-* headers', async () => {
    await fetch(`${proxy.url}/whoami`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    const { headers } = upstream.requests.at(-1);
    assert.equal(headers.host, new URL(upstream.url).host);
    assert.equal(headers['x-forwarded-for'], '203.0.113.9, 127.0.0.1');
    assert.equal(headers['x-forwarded-host'], new URL(proxy.url).host);
    assert.equal(headers['x-forwarded-proto'], 'http');
  });

  it('does not forward hop-by-hop headers', async () => {
    await rawRequest(`${proxy.url}/hop`, {
      headers: { connection: 'x-session-token', 'x-session-token': 'secret', 'keep-alive': 'timeout=5', 'x-normal': 'yes' },
    });
    const { headers } = upstream.requests.at(-1);
    assert.equal(headers['x-session-token'], undefined);
    assert.equal(headers['keep-alive'], undefined);
    assert.equal(headers['x-normal'], 'yes');
  });
});

describe('proxy failure modes', () => {
  it('returns 502 when the upstream is unreachable', async () => {
    // Grab a free port, then close it so nothing is listening there.
    const dead = await startUpstream();
    await dead.close();
    const proxy = await startProxy({ target: dead.url });
    try {
      const res = await fetch(`${proxy.url}/anything`);
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'bad_gateway' });
      assert.deepEqual(proxy.outcomes.at(-1), { status: 502, error: 'ECONNREFUSED' });
    } finally {
      await proxy.close();
    }
  });

  it('returns 504 and cancels the upstream request when it is too slow', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({ target: upstream.url, timeoutMs: 100 });
    try {
      const started = Date.now();
      const res = await fetch(`${proxy.url}/slow?ms=2000`);
      assert.equal(res.status, 504);
      assert.deepEqual(await res.json(), { error: 'gateway_timeout' });
      assert.ok(Date.now() - started < 1000, 'should not wait for the slow upstream');
      await sleep(50);
      assert.equal(upstream.requests.at(-1).aborted, true);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('cancels the upstream request when the client disconnects', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({ target: upstream.url });
    try {
      const controller = new AbortController();
      const pending = fetch(`${proxy.url}/slow?ms=2000`, { signal: controller.signal });
      await sleep(100);
      controller.abort();
      await assert.rejects(pending);
      await sleep(50);
      assert.equal(upstream.requests.at(-1).aborted, true);
      assert.deepEqual(proxy.outcomes.at(-1), { status: null, error: 'client_aborted' });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('handles many concurrent requests', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy({ target: upstream.url });
    try {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) => fetch(`${proxy.url}/item/${i}`).then((r) => r.json())),
      );
      assert.deepEqual(
        responses.map((b) => b.url).sort(),
        Array.from({ length: 50 }, (_, i) => `/item/${i}`).sort(),
      );
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
