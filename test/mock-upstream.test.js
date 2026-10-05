import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startUpstream } from './helpers/servers.js';

// Sanity checks for the test harness itself, so proxy test failures can be
// trusted to be gateway bugs rather than mock bugs.
describe('mock upstream', () => {
  let upstream;

  before(async () => {
    upstream = await startUpstream({ name: 'a' });
  });
  after(() => upstream.close());

  it('echoes requests and records them', async () => {
    const res = await fetch(`${upstream.url}/anything?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-upstream-name'), 'a');
    const body = await res.json();
    assert.equal(body.method, 'POST');
    assert.equal(body.url, '/anything?x=1');
    assert.deepEqual(body.body, { hello: 'world' });
    assert.equal(upstream.requests.at(-1).url, '/anything?x=1');
  });

  it('returns arbitrary status codes', async () => {
    const res = await fetch(`${upstream.url}/status/503`);
    assert.equal(res.status, 503);
  });
});
