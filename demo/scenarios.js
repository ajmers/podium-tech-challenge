/**
 * Demo scenarios. Each mirrors a case from the test suite, but runs against
 * the routes in gateway.yaml so you can watch real traffic flow through.
 *
 * A scenario's run(h) uses the harness to send requests and returns steps:
 *   { label, request, response, upstream, checks: [{ label, pass }] }
 */

const USERS = 'localhost:3001';
const ORDERS = 'localhost:3002';
const PRODUCTS_PRIMARY = 'localhost:3003';
const LEGACY = 'localhost:3005';
const INTERNAL = 'localhost:3006';
const VALID_KEY = 'sk_live_abc123';

const check = (label, pass) => ({ label, pass: Boolean(pass) });
const status = (r, code) => check(`Gateway responds ${code}`, r.response.status === code);
const notReached = (r) => check('Upstream never receives the request', r.upstream.length === 0);
const reached = (r, id) => check(`Request reaches upstream ${id}`, r.upstream.length === 1 && r.upstream[0].upstream === id);
const step = (label, result, checks) => ({ label, ...result, checks });

export const scenarios = [
  // ── Core ────────────────────────────────────────────────────────────────
  {
    id: 'health',
    group: 'Core',
    title: 'Health check',
    description: 'GET /health is always answered by the gateway itself, regardless of config.',
    async run(h) {
      const r = await h.send({ path: '/health' });
      return [
        step('GET /health', r, [
          status(r, 200),
          check('Body has status "healthy"', r.response.body?.status === 'healthy'),
          check('uptime_seconds is an integer', Number.isInteger(r.response.body?.uptime_seconds)),
          notReached(r),
        ]),
      ];
    },
  },
  {
    id: 'proxy-get',
    group: 'Core',
    title: 'Basic proxying',
    description: 'A request matching /api/users is forwarded to its upstream with path and query intact.',
    async run(h) {
      const r = await h.send({ path: '/api/users/42?expand=true' });
      return [
        step('GET /api/users/42?expand=true', r, [
          status(r, 200),
          reached(r, USERS),
          check('Upstream sees the full path and query', r.upstream[0]?.url === '/api/users/42?expand=true'),
        ]),
      ];
    },
  },
  {
    id: 'proxy-post',
    group: 'Core',
    title: 'Request bodies are forwarded',
    description: 'POST bodies stream through the gateway to the upstream unchanged.',
    async run(h) {
      const body = { name: 'Ada Lovelace', role: 'admin' };
      const r = await h.send({ method: 'POST', path: '/api/users', body });
      return [
        step('POST /api/users', r, [
          status(r, 200),
          reached(r, USERS),
          check('Upstream receives the same JSON body', JSON.stringify(r.upstream[0]?.body) === JSON.stringify(body)),
        ]),
      ];
    },
  },
  {
    id: 'not-found',
    group: 'Core',
    title: 'Unmatched route → 404',
    description: 'Paths that match no route get a 404 from the gateway.',
    async run(h) {
      const r = await h.send({ path: '/api/nope' });
      return [step('GET /api/nope', r, [status(r, 404), check('Body is { error: "not_found" }', r.response.body?.error === 'not_found'), notReached(r)])];
    },
  },
  {
    id: 'segment-boundary',
    group: 'Core',
    title: 'Prefixes match whole segments',
    description: '/api/users matches /api/users/… but not /api/usersX.',
    async run(h) {
      const r = await h.send({ path: '/api/usersX' });
      return [step('GET /api/usersX', r, [status(r, 404), notReached(r)])];
    },
  },
  {
    id: 'method-not-allowed',
    group: 'Core',
    title: 'Wrong method → 405',
    description: '/api/products only allows GET, so POST is rejected with an Allow header.',
    async run(h) {
      const r = await h.send({ method: 'POST', path: '/api/products/1', body: { x: 1 } });
      return [
        step('POST /api/products/1', r, [
          status(r, 405),
          check('Allow header is "GET"', r.response.headers?.allow === 'GET'),
          notReached(r),
        ]),
      ];
    },
  },
  {
    id: 'strip-prefix',
    group: 'Core',
    title: 'strip_prefix',
    description: 'Routes with strip_prefix: true drop the route path before forwarding.',
    async run(h) {
      const a = await h.send({ path: '/api/products/123?color=red' });
      const b = await h.send({ path: '/api/products' });
      const c = await h.send({ path: '/api/legacy/v1/data' });
      return [
        step('GET /api/products/123?color=red', a, [
          status(a, 200),
          reached(a, PRODUCTS_PRIMARY),
          check('Upstream sees /123?color=red', a.upstream[0]?.url === '/123?color=red'),
        ]),
        step('GET /api/products (whole path stripped)', b, [check('Upstream sees /', b.upstream[0]?.url === '/')]),
        step('GET /api/legacy/v1/data', c, [reached(c, LEGACY), check('Upstream sees /v1/data', c.upstream[0]?.url === '/v1/data')]),
      ];
    },
  },
  {
    id: 'proxy-headers',
    group: 'Core',
    title: 'Proxy headers',
    description:
      'The gateway rewrites Host, appends X-Forwarded-For, and drops hop-by-hop headers (including any named in Connection).',
    async run(h) {
      const r = await h.send({
        path: '/api/users/me',
        headers: { 'x-forwarded-for': '203.0.113.9', connection: 'x-session-secret', 'x-session-secret': 'hunter2', 'x-normal': 'kept' },
      });
      const up = r.upstream[0]?.headers ?? {};
      return [
        step('GET /api/users/me', r, [
          status(r, 200),
          check('Host is the upstream, not the gateway', up.host?.startsWith('127.0.0.1:') && !r.response.headers?.host),
          check('X-Forwarded-For has the client IP appended', up['x-forwarded-for'] === '203.0.113.9, 127.0.0.1'),
          check('X-Forwarded-Proto is set', up['x-forwarded-proto'] === 'http'),
          check('Header named in Connection is dropped', up['x-session-secret'] === undefined),
          check('Ordinary headers pass through', up['x-normal'] === 'kept'),
        ]),
      ];
    },
  },

  // ── Resilience ──────────────────────────────────────────────────────────
  {
    id: 'upstream-error',
    group: 'Resilience',
    title: 'Upstream errors pass through',
    description: "An upstream's own 503 is returned unchanged; the gateway doesn't rewrite it.",
    async run(h) {
      const r = await h.send({ path: '/api/legacy/status/503' });
      return [step('GET /api/legacy/status/503', r, [status(r, 503), reached(r, LEGACY)])];
    },
  },
  {
    id: 'upstream-down',
    group: 'Resilience',
    title: 'Upstream down → 502',
    description: 'Stops the orders upstream, sends a request, then starts it again.',
    async run(h) {
      await h.setUpstream(ORDERS, false);
      let down;
      try {
        down = await h.send({ path: '/api/orders' });
      } finally {
        await h.setUpstream(ORDERS, true);
      }
      const back = await h.send({ path: '/api/orders' });
      return [
        step(`GET /api/orders with ${ORDERS} stopped`, down, [
          status(down, 502),
          check('Body is { error: "bad_gateway" }', down.response.body?.error === 'bad_gateway'),
        ]),
        step(`GET /api/orders after ${ORDERS} restarts`, back, [status(back, 200), reached(back, ORDERS)]),
      ];
    },
  },
  {
    id: 'timeout',
    group: 'Resilience',
    title: 'Per-route timeout → 504',
    description: '/api/orders has a 5s timeout. The upstream is asked to take 6s, so the gateway gives up at 5s and cancels it. (Takes ~5s.)',
    async run(h) {
      const r = await h.send({ path: '/api/orders/slow?ms=6000' });
      return [
        step('GET /api/orders/slow?ms=6000', r, [
          status(r, 504),
          check('Gateway gives up after ~5s, not 6s', r.response.durationMs >= 4900 && r.response.durationMs < 5900),
          check('Upstream request is cancelled', r.upstream[0]?.aborted === true),
        ]),
      ];
    },
  },
  {
    id: 'client-disconnect',
    group: 'Resilience',
    title: 'Client disconnect cancels upstream',
    description: 'The client hangs up after 300ms; the gateway cancels the in-flight upstream request instead of letting it run.',
    async run(h) {
      const r = await h.send({ path: '/api/users/slow?ms=3000', abortAfterMs: 300 });
      return [
        step('GET /api/users/slow?ms=3000, client aborts at 300ms', r, [
          check('Client gave up', r.response.aborted === true),
          reached(r, USERS),
          check('Upstream request is cancelled', r.upstream[0]?.aborted === true),
        ]),
      ];
    },
  },
  // ── Auth ────────────────────────────────────────────────────────────────
  {
    id: 'auth-missing',
    group: 'Auth',
    title: 'No API key → 401',
    description: '/api/internal requires X-API-Key. Without it the gateway rejects the request before the upstream.',
    async run(h) {
      const r = await h.send({ path: '/api/internal/data' });
      return [step('GET /api/internal/data', r, [status(r, 401), check('Body is { error: "unauthorized" }', r.response.body?.error === 'unauthorized'), notReached(r)])];
    },
  },
  {
    id: 'auth-wrong',
    group: 'Auth',
    title: 'Wrong API key → 401',
    description: 'A wrong key gets the identical response to a missing one, so callers learn nothing.',
    async run(h) {
      const r = await h.send({ path: '/api/internal/data', headers: { 'x-api-key': 'sk_live_abc12' } });
      return [step('GET /api/internal/data with a near-miss key', r, [status(r, 401), notReached(r)])];
    },
  },
  {
    id: 'auth-valid',
    group: 'Auth',
    title: 'Valid API key → proxied',
    description: 'A configured key is accepted, and the key header is stripped before forwarding.',
    async run(h) {
      const r = await h.send({ path: '/api/internal/data', headers: { 'X-API-Key': VALID_KEY } });
      return [
        step('GET /api/internal/data with a valid key', r, [
          status(r, 200),
          reached(r, INTERNAL),
          check('Upstream does not see X-API-Key', r.upstream[0]?.headers?.['x-api-key'] === undefined),
        ]),
      ];
    },
  },
  {
    id: 'auth-dot-bypass',
    group: 'Auth',
    title: '"../" can\'t bypass auth',
    description: '/api/users/../internal is resolved to /api/internal before routing, so auth still applies.',
    async run(h) {
      const r = await h.send({ path: '/api/users/../internal/data' });
      return [step('GET /api/users/../internal/data', r, [status(r, 401), notReached(r)])];
    },
  },

  // ── Load balancing ──────────────────────────────────────────────────────
  {
    id: 'load-balancing',
    group: 'Load balancing',
    title: 'Weighted round robin (3:1)',
    description: '/api/products has two targets weighted 3:1. Eight requests: 6 go to localhost:3003 and 2 to localhost:3004, interleaved A A B A rather than A A A B.',
    async run(h) {
      const results = [];
      for (let i = 1; i <= 8; i += 1) results.push(await h.send({ path: `/api/products/${i}` }));
      const order = results.map((r) => r.response.headers?.['x-upstream-name']);
      const count = (id) => order.filter((name) => name === id).length;
      const letters = order.map((name) => (name === PRODUCTS_PRIMARY ? 'A' : 'B')).join(' ');
      return [
        {
          label: '8 × GET /api/products/{i}',
          summary: { requests: 8, statusCounts: countStatuses(results), totalMs: results.reduce((n, r) => n + r.response.durationMs, 0) },
          checks: [
            check(`6 served by ${PRODUCTS_PRIMARY}`, count(PRODUCTS_PRIMARY) === 6),
            check('2 served by localhost:3004', count('localhost:3004') === 2),
            check(`Order is interleaved A A B A A A B A (got ${letters})`, letters === 'A A B A A A B A'),
          ],
        },
        step('Request 3 (goes to the lighter target)', results[2], [reached(results[2], 'localhost:3004')]),
      ];
    },
  },

  // ── Rate limiting ───────────────────────────────────────────────────────
  {
    id: 'rate-limit-fixed',
    group: 'Rate limiting',
    title: 'Route limit: 10 per 10s (fixed window)',
    description: '/api/orders allows 10 requests per 10s per IP. Requests 11 and 12 get 429 with Retry-After and never reach the upstream.',
    async run(h) {
      const results = [];
      for (let i = 1; i <= 12; i += 1) results.push(await h.send({ path: `/api/orders/${i}` }));
      const statuses = results.map((r) => r.response.status);
      const remaining = results.slice(0, 10).map((r) => r.response.headers?.['x-ratelimit-remaining']);
      const eleventh = results[10];
      return [
        {
          label: '12 × GET /api/orders/{i}, one after another',
          summary: { requests: 12, statusCounts: countStatuses(results), totalMs: results.reduce((n, r) => n + r.response.durationMs, 0) },
          checks: [
            check('Requests 1-10 return 200', statuses.slice(0, 10).every((s) => s === 200)),
            check('X-RateLimit-Remaining counts down 9 → 0', remaining.join(',') === '9,8,7,6,5,4,3,2,1,0'),
            check('Requests 11-12 return 429', statuses[10] === 429 && statuses[11] === 429),
          ],
        },
        step('Request 11 (over the limit)', eleventh, [
          status(eleventh, 429),
          check('Retry-After header is set (≤ 10s)', Number(eleventh.response.headers?.['retry-after']) > 0 && Number(eleventh.response.headers?.['retry-after']) <= 10),
          check('Body is { error: "rate_limited", retry_after }', eleventh.response.body?.error === 'rate_limited' && Number.isInteger(eleventh.response.body?.retry_after)),
          notReached(eleventh),
        ]),
      ];
    },
  },
  {
    id: 'rate-limit-concurrency',
    group: 'Rate limiting',
    title: '50 concurrent vs a 30/min limit',
    description: '/api/users allows 30 per minute (sliding window). 50 requests at the same moment: exactly 30 get through, with no race between the check and the increment.',
    async run(h) {
      // Per-request upstream attribution isn't reliable with requests in
      // flight together, so compare the upstream's total before and after.
      const upstreamCount = () => h.state().upstreams.find((u) => u.id === USERS).requestCount;
      const before = upstreamCount();
      const started = performance.now();
      const results = await Promise.all(Array.from({ length: 50 }, (_, i) => h.send({ path: `/api/users/${i}` })));
      const counts = countStatuses(results);
      const proxied = results.filter((r) => r.response.status === 200);
      return [
        {
          label: '50 × GET /api/users/{i} in parallel',
          summary: { requests: 50, statusCounts: counts, totalMs: Math.round(performance.now() - started) },
          checks: [
            check('Exactly 30 return 200', counts[200] === 30),
            check('Exactly 20 return 429', counts[429] === 20),
            check('Each 200 matches its own request', proxied.every((r) => r.response.body?.url === r.request.path)),
            check('Only 30 requests reach the upstream', upstreamCount() - before === 30),
          ],
        },
      ];
    },
  },
  {
    id: 'rate-limit-global',
    group: 'Rate limiting',
    title: 'global_rate_limit as the default',
    description: '/api/legacy has no rate_limit of its own, so it gets global_rate_limit (100 per 60s). 105 parallel requests: 100 pass.',
    async run(h) {
      const results = await Promise.all(Array.from({ length: 105 }, () => h.send({ path: '/api/legacy/ping' })));
      const counts = countStatuses(results);
      return [
        {
          label: '105 × GET /api/legacy/ping in parallel',
          summary: { requests: 105, statusCounts: counts, totalMs: Math.max(...results.map((r) => r.response.durationMs)) },
          checks: [
            check('Exactly 100 return 200', counts[200] === 100),
            check('Exactly 5 return 429', counts[429] === 5),
            check('X-RateLimit-Limit is 100 (the global limit)', results[0].response.headers?.['x-ratelimit-limit'] === '100'),
          ],
        },
      ];
    },
  },
];

function countStatuses(results) {
  const counts = {};
  for (const r of results) counts[r.response.status] = (counts[r.response.status] ?? 0) + 1;
  return counts;
}
