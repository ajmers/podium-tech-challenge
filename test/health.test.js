import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startGateway } from './helpers/servers.js';

describe('GET /health', () => {
  let gateway;
  let clock = 1_000_000;

  before(async () => {
    gateway = await startGateway({ routes: [] }, { now: () => clock });
  });
  after(() => gateway.close());

  it('returns 200 with status and integer uptime', async () => {
    clock += 2_500;
    const res = await fetch(`${gateway.url}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { status: 'healthy', uptime_seconds: 2 });
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${gateway.url}/nope`);
    assert.equal(res.status, 404);
  });
});
