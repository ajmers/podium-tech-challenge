import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/config/load.js';
import { sendError } from '../src/http-utils.js';
import { buildRouteHandler, compose } from '../src/pipeline.js';
import { startGateway, startUpstream } from './helpers/servers.js';

describe('compose', () => {
  it('runs handlers as an onion around the terminal', async () => {
    const calls = [];
    const handler = (name) => async (ctx, next) => {
      calls.push(`${name}:in`);
      await next();
      calls.push(`${name}:out`);
    };
    await compose([handler('a'), handler('b')], async () => calls.push('terminal'))({});
    assert.deepEqual(calls, ['a:in', 'b:in', 'terminal', 'b:out', 'a:out']);
  });

  it('stops when a handler does not call next', async () => {
    let reached = false;
    await compose([async () => {}], async () => (reached = true))({});
    assert.equal(reached, false);
  });

  it('lets a handler call next more than once (retry)', async () => {
    let attempts = 0;
    const retryOnce = async (ctx, next) => {
      await next();
      if (ctx.outcome.status === 503) await next();
    };
    const ctx = {};
    await compose([retryOnce], async (c) => {
      attempts += 1;
      c.outcome = { status: attempts === 1 ? 503 : 200 };
    })(ctx);
    assert.equal(attempts, 2);
    assert.deepEqual(ctx.outcome, { status: 200 });
  });

  it('propagates errors, including synchronous throws', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    await assert.rejects(compose([boom], async () => {})({}), /boom/);
    await assert.rejects(compose([], boom)({}), /boom/);
  });

  it('runs just the terminal when there are no handlers', async () => {
    let reached = false;
    await compose([], async () => (reached = true))({});
    assert.equal(reached, true);
  });
});

describe('buildRouteHandler', () => {
  it('only includes stages whose create() returns a handler, in order', async () => {
    const calls = [];
    const stage = (name, applies) => ({
      name,
      create: (route) =>
        applies(route)
          ? async (ctx, next) => {
              calls.push(name);
              await next();
            }
          : null,
    });
    const stages = [
      stage('auth', (r) => Boolean(r.auth)),
      stage('rate_limit', () => true),
      stage('transform', (r) => Boolean(r.transform)),
    ];
    const run = buildRouteHandler({ path: '/a', auth: {} }, stages, async () => calls.push('proxy'), {});
    await run({});
    assert.deepEqual(calls, ['auth', 'rate_limit', 'proxy']);
  });

  it('passes the route and shared deps to create()', () => {
    const route = { path: '/a' };
    const deps = { now: () => 0, gateway: {} };
    let seen;
    buildRouteHandler(route, [{ name: 'spy', create: (...args) => ((seen = args), null) }], async () => {}, deps);
    assert.equal(seen[0], route);
    assert.equal(seen[1], deps);
  });
});

// End-to-end: custom stages plugged into a real gateway.
describe('gateway pipeline', () => {
  // Rejects requests without X-Allow on routes that set `guarded: true`.
  const guardStage = {
    name: 'guard',
    create(route) {
      if (!route.guarded) return null;
      return async (ctx, next) => {
        if (ctx.req.headers['x-allow'] !== 'yes') return sendError(ctx.res, 403, 'forbidden');
        await next();
      };
    },
  };
  // Adds a response header on the way in and records the proxy outcome on the way out.
  const outcomes = [];
  const tagStage = {
    name: 'tag',
    create(route) {
      return async (ctx, next) => {
        ctx.res.setHeader('x-route', route.path);
        await next();
        outcomes.push(ctx.outcome);
      };
    },
  };

  let upstream;
  let gateway;

  before(async () => {
    upstream = await startUpstream();
    gateway = await startGateway(
      {
        routes: [
          { path: '/open', upstream: { url: upstream.url } },
          { path: '/guarded', guarded: true, upstream: { url: upstream.url } },
          { path: '/broken', explode: true, upstream: { url: upstream.url } },
        ],
      },
      {
        stages: [
          guardStage,
          tagStage,
          {
            name: 'explode',
            create: (route) =>
              route.explode
                ? async () => {
                    throw new Error('stage bug');
                  }
                : null,
          },
        ],
      },
    );
  });
  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it('runs stages around the proxy and exposes the outcome', async () => {
    const res = await fetch(`${gateway.url}/open/x`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-route'), '/open');
    assert.deepEqual(outcomes.at(-1), { status: 200 });
  });

  it('lets a stage short-circuit before the upstream is called', async () => {
    const before = upstream.requests.length;
    const res = await fetch(`${gateway.url}/guarded/x`);
    assert.equal(res.status, 403);
    assert.equal(upstream.requests.length, before);

    const allowed = await fetch(`${gateway.url}/guarded/x`, { headers: { 'x-allow': 'yes' } });
    assert.equal(allowed.status, 200);
  });

  it('applies route-specific stages only to their routes', async () => {
    const res = await fetch(`${gateway.url}/open/x`);
    assert.equal(res.status, 200); // guard not applied here
  });

  it('turns an unexpected stage error into a 500', async (t) => {
    t.mock.method(console, 'error', () => {});
    const res = await fetch(`${gateway.url}/broken`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
  });

  it('surfaces stage config errors when the gateway is built', async () => {
    const strict = {
      name: 'strict',
      create: () => {
        throw new ConfigError('routes[0].strict: bad value');
      },
    };
    await assert.rejects(
      startGateway({ routes: [{ path: '/a', upstream: { url: 'http://x' } }] }, { stages: [strict] }),
      ConfigError,
    );
  });
});
