import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startGateway, startUpstream } from './helpers/servers.js';

describe('circuit breaker', () => {
  let upstream;
  let gateway;
  let clock;

  beforeEach(async () => {
    clock = 1_000_000;
    upstream = await startUpstream();
    gateway = await startGateway(
      {
        routes: [
          {
            path: '/svc',
            upstream: { url: upstream.url },
            circuit_breaker: { threshold: 3, window: '60s', cooldown: '30s' },
          },
        ],
      },
      { now: () => clock },
    );
  });
  afterEach(async () => {
    await gateway.close();
    await upstream.close();
  });

  const get = (path) => fetch(`${gateway.url}${path}`);
  const fail = async (n) => {
    for (let i = 0; i < n; i += 1) assert.equal((await get('/svc/status/503')).status, 503);
  };

  it('trips after `threshold` failures and rejects without calling the upstream', async () => {
    await fail(3);
    const before = upstream.requests.length;
    const res = await get('/svc/ok');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.deepEqual(await res.json(), { error: 'service_unavailable', retry_after: 30 });
    assert.equal(upstream.requests.length, before);
  });

  it('counts retry_after down through the cooldown', async () => {
    await fail(3);
    clock += 20_500;
    assert.equal((await (await get('/svc/ok')).json()).retry_after, 10);
  });

  it('only counts failures inside the window', async () => {
    await fail(2);
    clock += 61_000;
    await fail(2);
    assert.equal((await get('/svc/ok')).status, 200);
  });

  it('ignores 4xx responses', async () => {
    for (let i = 0; i < 5; i += 1) assert.equal((await get('/svc/status/404')).status, 404);
    assert.equal((await get('/svc/ok')).status, 200);
  });

  it('closes again when the trial request after the cooldown succeeds', async () => {
    await fail(3);
    clock += 30_000;
    assert.equal((await get('/svc/ok')).status, 200);
    // Fully closed: a single new failure doesn't trip it.
    await fail(1);
    assert.equal((await get('/svc/ok')).status, 200);
  });

  it('re-opens for another cooldown when the trial request fails', async () => {
    await fail(3);
    clock += 30_000;
    assert.equal((await get('/svc/status/503')).status, 503); // trial reaches upstream and fails
    const res = await get('/svc/ok');
    assert.equal((await res.json()).error, 'service_unavailable');
  });

  it('counts an unreachable upstream (502) as a failure', async () => {
    await upstream.close();
    for (let i = 0; i < 3; i += 1) assert.equal((await get('/svc/x')).status, 502);
    assert.equal((await (await get('/svc/x')).json()).error, 'service_unavailable');
  });
});

describe('circuit breaker config validation', () => {
  const build = (cb) => startGateway({ routes: [{ path: '/a', upstream: { url: 'http://localhost:1' }, circuit_breaker: cb }] });

  it('rejects invalid settings', async () => {
    await assert.rejects(build({ threshold: 0, window: '1s', cooldown: '1s' }), /threshold/);
    await assert.rejects(build({ threshold: 1, window: 'x', cooldown: '1s' }), /circuit_breaker\.window/);
    await assert.rejects(build({ threshold: 1, window: '1s', cooldown: '0s' }), /cooldown must be greater than zero/);
  });
});
