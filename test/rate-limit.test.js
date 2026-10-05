import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/config/load.js';
import { rateLimitStage } from '../src/stages/rate-limit.js';
import { startGateway, startUpstream } from './helpers/servers.js';

describe('rate limiting through the gateway', () => {
  let upstream;
  let gateway;
  let clock = 1_000_000;

  before(async () => {
    upstream = await startUpstream();
    gateway = await startGateway(
      {
        gateway: { global_rate_limit: { requests: 2, window: '60s' } },
        routes: [
          { path: '/limited', upstream: { url: upstream.url }, rate_limit: { requests: 3, window: '10s' } },
          { path: '/burst', upstream: { url: upstream.url }, rate_limit: { requests: 10, window: '60s', strategy: 'sliding_window' } },
          { path: '/default-a', upstream: { url: upstream.url } },
          { path: '/default-b', upstream: { url: upstream.url } },
          { path: '/generous', upstream: { url: upstream.url }, rate_limit: { requests: 5, window: '60s' } },
          {
            path: '/secure',
            upstream: { url: upstream.url },
            auth: { type: 'api_key', keys: ['good'] },
            rate_limit: { requests: 2, window: '60s' },
          },
        ],
      },
      { now: () => clock },
    );
  });
  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const get = (path, headers) => fetch(`${gateway.url}${path}`, { headers });

  it('allows up to the limit, then returns 429 without calling the upstream', async () => {
    const ok = [];
    for (let i = 0; i < 3; i += 1) ok.push(await get('/limited'));
    assert.deepEqual(ok.map((r) => r.status), [200, 200, 200]);
    assert.deepEqual(ok.map((r) => r.headers.get('x-ratelimit-remaining')), ['2', '1', '0']);
    assert.equal(ok[0].headers.get('x-ratelimit-limit'), '3');

    const before = upstream.requests.length;
    const res = await get('/limited');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '10');
    assert.deepEqual(await res.json(), { error: 'rate_limited', retry_after: 10 });
    assert.equal(upstream.requests.length, before);
  });

  it('lets requests through again once the window passes', async () => {
    clock += 10_000;
    assert.equal((await get('/limited')).status, 200);
  });

  it('lets exactly `limit` of 50 concurrent requests through', async () => {
    const statuses = await Promise.all(Array.from({ length: 50 }, () => get('/burst').then((r) => r.status)));
    assert.equal(statuses.filter((s) => s === 200).length, 10);
    assert.equal(statuses.filter((s) => s === 429).length, 40);
  });

  it('applies global_rate_limit to routes without their own limit, with separate counters per route', async () => {
    for (const path of ['/default-a', '/default-b']) {
      const statuses = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await get(path)).status);
      assert.deepEqual(statuses, [200, 200, 429], path);
    }
  });

  it('uses a route limit instead of the global one (they do not stack)', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await get('/generous')).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  });

  it('runs after auth, so rejected requests do not use up the quota', async () => {
    for (let i = 0; i < 5; i += 1) assert.equal((await get('/secure', { 'x-api-key': 'bad' })).status, 401);
    assert.equal((await get('/secure', { 'x-api-key': 'good' })).status, 200);
  });
});

describe('rate limit keys', () => {
  // Drive the stage directly so we can simulate different client IPs.
  function fakeRes() {
    return {
      headers: {},
      status: null,
      setHeader(name, value) {
        this.headers[name] = value;
      },
      writeHead(status) {
        this.status = status;
      },
      end() {},
    };
  }

  async function run(per, ips) {
    const handler = rateLimitStage.create(
      { path: '/x', rate_limit: { requests: 1, window: '60s', per } },
      { gateway: { globalRateLimit: null }, now: () => 0 },
    );
    const statuses = [];
    for (const ip of ips) {
      const res = fakeRes();
      let passed = false;
      await handler({ clientIp: ip, res }, async () => (passed = true));
      statuses.push(passed ? 200 : res.status);
    }
    return statuses;
  }

  it('per: ip counts each client separately', async () => {
    assert.deepEqual(await run('ip', ['1.1.1.1', '2.2.2.2', '1.1.1.1']), [200, 200, 429]);
  });

  it('per: global counts all clients together', async () => {
    assert.deepEqual(await run('global', ['1.1.1.1', '2.2.2.2']), [200, 429]);
  });
});

describe('rate limit config validation', () => {
  const build = (gateway, rateLimit) =>
    startGateway({
      gateway,
      routes: [{ path: '/a', upstream: { url: 'http://localhost:1' }, ...(rateLimit && { rate_limit: rateLimit }) }],
    });

  it('rejects invalid route limits', async () => {
    await assert.rejects(build({}, { requests: 0, window: '1s' }), /requests must be a positive integer/);
    await assert.rejects(build({}, { requests: 1, window: 'soon' }), /rate_limit\.window/);
    await assert.rejects(build({}, { requests: 1, window: '0s' }), /greater than zero/);
    await assert.rejects(build({}, { requests: 1, window: '1s', strategy: 'token_bucket' }), /strategy/);
    await assert.rejects(build({}, { requests: 1, window: '1s', per: 'user' }), /per must be/);
  });

  it('rejects an invalid global limit even when routes override it', async () => {
    await assert.rejects(
      build({ global_rate_limit: { requests: -1, window: '1s' } }, { requests: 1, window: '1s' }),
      (err) => err instanceof ConfigError && /gateway\.global_rate_limit/.test(err.message),
    );
  });
});
