import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config/load.js';
import { createRouter } from '../src/router.js';

const UPSTREAM = { url: 'http://localhost:9999' };

function routerFor(routes) {
  const config = normalizeConfig({ routes: routes.map((r) => ({ upstream: UPSTREAM, ...r })) });
  return createRouter(config.routes);
}

describe('router: path matching', () => {
  const router = routerFor([
    { path: '/api/users', methods: ['GET'] },
    { path: '/api', methods: ['GET'] },
  ]);

  it('matches the exact route path', () => {
    const m = router.match('GET', '/api/users');
    assert.equal(m.type, 'matched');
    assert.equal(m.route.path, '/api/users');
  });

  it('matches sub-paths on a segment boundary', () => {
    assert.equal(router.match('GET', '/api/users/42').route.path, '/api/users');
    assert.equal(router.match('GET', '/api/users/').route.path, '/api/users');
  });

  it('does not match a partial segment', () => {
    // "/api/usersX" is not under "/api/users", so the "/api" route takes it.
    assert.equal(router.match('GET', '/api/usersX').route.path, '/api');
  });

  it('returns not_found when nothing matches', () => {
    assert.deepEqual(router.match('GET', '/other'), { type: 'not_found' });
    assert.deepEqual(router.match('GET', '/ap'), { type: 'not_found' });
  });

  it('prefers the longest match regardless of config order', () => {
    const reversed = routerFor([
      { path: '/api', methods: ['GET'] },
      { path: '/api/users', methods: ['GET'] },
    ]);
    assert.equal(reversed.match('GET', '/api/users/1').route.path, '/api/users');
  });

  it('treats a trailing slash in config the same as none', () => {
    const r = routerFor([{ path: '/api/orders/', methods: ['GET'] }]);
    assert.equal(r.match('GET', '/api/orders').type, 'matched');
    assert.equal(r.match('GET', '/api/orders/7').type, 'matched');
  });

  it('lets a "/" route catch everything else', () => {
    const r = routerFor([{ path: '/' }, { path: '/api' }]);
    assert.equal(r.match('GET', '/anything/here').route.path, '/');
    assert.equal(r.match('GET', '/api/x').route.path, '/api');
  });
});

describe('router: methods', () => {
  const router = routerFor([
    { path: '/api/products', methods: ['GET'] },
    { path: '/api', methods: ['GET', 'POST'] },
    { path: '/open' },
  ]);

  it('returns method_not_allowed with the allowed list', () => {
    const m = router.match('POST', '/api/products/1');
    assert.equal(m.type, 'method_not_allowed');
    assert.deepEqual(m.allowed, ['GET']);
  });

  it('does not fall back to a shorter route that allows the method', () => {
    // "/api" allows POST, but "/api/products" is the more specific match.
    assert.equal(router.match('POST', '/api/products').type, 'method_not_allowed');
  });

  it('allows any method when methods is omitted', () => {
    assert.equal(router.match('DELETE', '/open').type, 'matched');
  });

  it('normalizes configured methods to upper case', () => {
    const r = routerFor([{ path: '/x', methods: ['get'] }]);
    assert.equal(r.match('GET', '/x').type, 'matched');
  });
});

describe('router: strip_prefix', () => {
  const router = routerFor([
    { path: '/api/products', strip_prefix: true },
    { path: '/api/users', strip_prefix: false },
  ]);

  it('removes the route prefix when enabled', () => {
    assert.equal(router.match('GET', '/api/products/123').upstreamPath, '/123');
    assert.equal(router.match('GET', '/api/products/a/b').upstreamPath, '/a/b');
  });

  it('forwards "/" when the whole path is stripped', () => {
    assert.equal(router.match('GET', '/api/products').upstreamPath, '/');
  });

  it('keeps the full path when disabled', () => {
    assert.equal(router.match('GET', '/api/users/9').upstreamPath, '/api/users/9');
  });
});
