# GatewayKit

A lightweight, config-driven API gateway built on Node's standard `http` module.
It reads a YAML config describing routes and upstream services and proxies
client requests to those upstreams.

## Prerequisites

- Node.js **22+** (developed on Node 26)
- npm

The only runtime dependency is [`yaml`](https://www.npmjs.com/package/yaml) for config parsing.
Tests use Node's built-in test runner (`node:test`), so no test framework is needed.

## Setup

```bash
npm install
```

## Running the gateway

The gateway reads its config path from the first CLI argument, or from the
`GATEWAY_CONFIG` environment variable. It listens on `gateway.port` from the
config (8080 in the example), which you can override with `PORT`.

```bash
# Using the bundled example config, on port 8080
npm start

# Equivalent explicit forms
node src/index.js gateway.yaml
GATEWAY_CONFIG=gateway.yaml node src/index.js

# Auto-restart on file changes while developing
npm run dev
```

Check that it is up:

```bash
curl -s localhost:8080/health
# {"status":"healthy","uptime_seconds":3}
```

If the config file is missing or malformed, the gateway prints a `Config error: ...`
message and exits with a non-zero status rather than starting in a half-working state.

### Running with mock upstreams

`gateway.yaml` points at upstreams on `localhost:3001`–`3006`. To start mock
upstreams on all of those ports in a second terminal:

```bash
npm run mock               # starts mocks on 3001-3006
node mock/upstream.js 3001 # or pick specific ports
```

The mock upstream echoes requests back as JSON and has a few test endpoints:
`/healthz`, `/slow?ms=N`, `/status/:code`, and `/flaky`.

## Demo UI

```bash
npm run demo     # then open http://localhost:8081
```

The demo starts a real gateway from `gateway.yaml` on a random port, with an in-process
mock upstream for each upstream URL in the config. No other setup is needed, and
it won't conflict with a gateway already running on 8080. It has four tabs:

- **Scenarios**: one-click runs of the behaviours the test suite covers (proxying, 404/405,
  `strip_prefix`, 502/504, client disconnects, auth, rate limiting). Each scenario
  runs against a freshly restarted gateway so counters don't carry over between runs. Each request is
  shown three ways: what the client sent, what the upstream actually received (or that
  it was never reached), and what the gateway returned, plus pass/fail checks.
- **Playground**: send any request through the gateway, with presets.
- **Routes**: the loaded routes and which of their config features are implemented.
- **Test suite**: runs `npm test` and streams the output.

The upstream chips at the top let you stop and start each mock to see failures live.
Set `DEMO_PORT` or `GATEWAY_PORT` to change ports. The scenarios assume the routes in
`gateway.yaml`; the playground works with any config (`npm run demo -- other.yaml`).

## Running the tests

```bash
npm test
```

The suite is self-contained. Each test starts its own gateway and mock upstreams
on ephemeral ports, so you don't need anything running beforehand and the tests
won't conflict with a gateway already on port 8080.

## Project layout

```
src/
  index.js          CLI entry: load config, start server, graceful shutdown
  gateway.js        HTTP server + request pipeline
  router.js         Route matching, 404/405, strip_prefix
  pipeline.js       Per-route stage pipeline (how features plug in)
  stages/           One module per config feature; index.js sets the order
  proxy.js          Streams requests to an upstream; timeouts, 502/504
  config/
    load.js         YAML loading, validation, normalization
    duration.js     "30s" / "500ms" duration parsing
  http-utils.js     JSON / error response helpers
mock/
  upstream.js       Mock upstream server (used by tests and `npm run mock`)
demo/
  server.js         Demo UI server (`npm run demo`)
  harness.js        Runs gateway + mocks in-process and records each request's path
  scenarios.js      The scenarios shown in the UI
  public/           Static front end (no build step)
test/
  helpers/          Start gateway / upstream on ephemeral ports
  *.test.js
gateway.yaml        Example config (the spec)
```

## Feature checklist

**Core**

- [x] Load config from CLI arg or `GATEWAY_CONFIG`; fail fast on malformed config
- [x] `GET /health` returns status and uptime
- [x] Route matching (longest prefix wins, segment-boundary aware); 404 for unmatched routes
- [x] Method filtering (405 with `Allow` header)
- [x] Streaming proxy: 502 when upstream is unreachable, client disconnects cancel the upstream request
- [x] `strip_prefix`
- [x] Upstream timeouts (`global_timeout`, per-route `upstream.timeout`) → 504
- [x] Per-route stage pipeline for config features (see below)

**Config features** (listed in planned build order)

- [x] API key auth (`auth.type: api_key`): 401 on missing/invalid key, constant-time comparison, key header not forwarded upstream
- [x] Rate limiting: `global_rate_limit` + per-route `rate_limit` (route replaces global); `fixed_window` / `sliding_window`; per `ip` / `global`; 429 + `Retry-After`
- [ ] Load balancing (`round_robin`, `weighted_round_robin`). *Partial: `targets` is parsed and validated, but only the first target is used*
- [ ] Circuit breaker
- [ ] Retries with `fixed` / `exponential` backoff
- [ ] Request / response header transforms
- [ ] Request body mapping / response envelope
- [ ] Active health checks

## Adding a config feature

Each feature is a *stage*: `{ name, create(route, deps) }`. `create` runs once
per route at startup. It validates the route's config block (throwing
`ConfigError`) and returns a `(ctx, next)` handler, or `null` if the route
doesn't use the feature. Add the module to `src/stages/` and list it in
`src/stages/index.js`. See the comment at the top of `src/pipeline.js`.

See `DECISIONS.md` for prioritization and design trade-offs.
