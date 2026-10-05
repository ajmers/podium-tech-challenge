import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/load.js';
import { createBalancer } from '../src/balancer.js';
import { startGateway, startUpstream } from './helpers/servers.js';

const picks = (balancer, n) => Array.from({ length: n }, () => balancer.pick());

describe('balancer', () => {
  const targets = [
    { url: 'A', weight: 3 },
    { url: 'B', weight: 1 },
  ];

  it('round_robin takes targets in turn and ignores weights', () => {
    assert.deepEqual(picks(createBalancer({ targets, balance: 'round_robin' }), 4), ['A', 'B', 'A', 'B']);
  });

  it('weighted_round_robin follows weights and interleaves smoothly', () => {
    assert.deepEqual(picks(createBalancer({ targets, balance: 'weighted_round_robin' }), 8), ['A', 'A', 'B', 'A', 'A', 'A', 'B', 'A']);
  });

  it('keeps exact proportions over many picks', () => {
    const balancer = createBalancer({
      targets: [
        { url: 'A', weight: 5 },
        { url: 'B', weight: 3 },
        { url: 'C', weight: 2 },
      ],
      balance: 'weighted_round_robin',
    });
    const counts = {};
    for (const url of picks(balancer, 1000)) counts[url] = (counts[url] ?? 0) + 1;
    assert.deepEqual(counts, { A: 500, B: 300, C: 200 });
  });

  it('always returns the only target of a single-url upstream', () => {
    assert.deepEqual(picks(createBalancer({ targets: [{ url: 'A', weight: 1 }] }), 3), ['A', 'A', 'A']);
  });

  it('rejects an unknown balance strategy in config', () => {
    const yaml = 'routes:\n  - path: /a\n    upstream:\n      targets: [{ url: "http://a" }]\n      balance: random';
    assert.throws(() => parseConfig(yaml), /balance must be one of/);
  });
});

describe('load balancing through the gateway', () => {
  let a;
  let b;
  let gateway;

  before(async () => {
    a = await startUpstream({ name: 'a' });
    b = await startUpstream({ name: 'b' });
    gateway = await startGateway({
      routes: [
        {
          path: '/weighted',
          upstream: { targets: [{ url: a.url, weight: 3 }, { url: b.url, weight: 1 }], balance: 'weighted_round_robin' },
        },
        { path: '/rr', upstream: { targets: [{ url: a.url }, { url: b.url }] } },
      ],
    });
  });
  after(async () => {
    await gateway.close();
    await Promise.all([a.close(), b.close()]);
  });

  async function servedBy(path, n) {
    const names = [];
    for (let i = 0; i < n; i += 1) names.push((await fetch(`${gateway.url}${path}`)).headers.get('x-upstream-name'));
    return names;
  }

  it('splits traffic 3:1 for weighted_round_robin', async () => {
    const names = await servedBy('/weighted', 8);
    assert.equal(names.filter((n) => n === 'a').length, 6);
    assert.equal(names.filter((n) => n === 'b').length, 2);
  });

  it('defaults to round_robin', async () => {
    assert.deepEqual(await servedBy('/rr', 4), ['a', 'b', 'a', 'b']);
  });
});
