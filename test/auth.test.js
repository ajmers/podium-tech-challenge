import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/config/load.js';
import { startGateway, startUpstream } from './helpers/servers.js';

describe('auth: api_key', () => {
  let upstream;
  let gateway;

  before(async () => {
    upstream = await startUpstream();
    gateway = await startGateway({
      routes: [
        {
          path: '/api/internal',
          methods: ['GET', 'POST'],
          upstream: { url: upstream.url },
          auth: { type: 'api_key', header: 'X-API-Key', keys: ['sk_live_abc123', 'sk_live_def456'] },
        },
        {
          path: '/api/partner',
          upstream: { url: upstream.url },
          auth: { type: 'api_key', header: 'Authorization-Token', keys: ['partner-key'] },
        },
        { path: '/api/public', upstream: { url: upstream.url } },
      ],
    });
  });
  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const get = (path, headers = {}) => fetch(`${gateway.url}${path}`, { headers });

  it('rejects a request with no key and never calls the upstream', async () => {
    const before = upstream.requests.length;
    const res = await get('/api/internal/data');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
    assert.equal(upstream.requests.length, before);
  });

  it('rejects a wrong key with the same response as a missing one', async () => {
    const res = await get('/api/internal/data', { 'x-api-key': 'sk_live_wrong' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  });

  it('rejects a near-miss key (prefix of a valid key)', async () => {
    const res = await get('/api/internal/data', { 'x-api-key': 'sk_live_abc12' });
    assert.equal(res.status, 401);
  });

  it('accepts any configured key', async () => {
    for (const key of ['sk_live_abc123', 'sk_live_def456']) {
      const res = await get('/api/internal/data', { 'X-API-Key': key });
      assert.equal(res.status, 200, `key ${key}`);
    }
  });

  it('does not forward the key header to the upstream', async () => {
    await get('/api/internal/data', { 'x-api-key': 'sk_live_abc123', 'x-other': 'kept' });
    const { headers } = upstream.requests.at(-1);
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers['x-other'], 'kept');
  });

  it('uses the configured header name', async () => {
    assert.equal((await get('/api/partner', { 'x-api-key': 'partner-key' })).status, 401);
    assert.equal((await get('/api/partner', { 'authorization-token': 'partner-key' })).status, 200);
  });

  it('does not apply keys from one route to another', async () => {
    const res = await get('/api/partner', { 'authorization-token': 'sk_live_abc123' });
    assert.equal(res.status, 401);
  });

  it('leaves routes without auth open', async () => {
    assert.equal((await get('/api/public')).status, 200);
  });

  it('checks the method (405) before auth', async () => {
    const res = await fetch(`${gateway.url}/api/internal`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  });
});

describe('auth: config validation', () => {
  const build = (auth) =>
    startGateway({ routes: [{ path: '/a', upstream: { url: 'http://localhost:1' }, auth }] });

  it('rejects unsupported auth types instead of leaving the route open', async () => {
    await assert.rejects(build({ type: 'jwt', keys: ['k'] }), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /route "\/a" auth\.type "jwt" is not supported/);
      return true;
    });
    await assert.rejects(build({ keys: ['k'] }), ConfigError);
  });

  it('rejects missing, empty, or non-string keys', async () => {
    await assert.rejects(build({ type: 'api_key' }), /keys must be a non-empty list/);
    await assert.rejects(build({ type: 'api_key', keys: [] }), /keys must be a non-empty list/);
    await assert.rejects(build({ type: 'api_key', keys: ['ok', 123] }), /non-empty strings/);
    await assert.rejects(build({ type: 'api_key', keys: [''] }), /non-empty strings/);
  });

  it('rejects an invalid header name', async () => {
    await assert.rejects(build({ type: 'api_key', header: '', keys: ['k'] }), /header/);
  });

  it('defaults the header to X-API-Key', async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway({
      routes: [{ path: '/a', upstream: { url: upstream.url }, auth: { type: 'api_key', keys: ['k'] } }],
    });
    try {
      assert.equal((await fetch(`${gateway.url}/a`, { headers: { 'x-api-key': 'k' } })).status, 200);
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });
});
