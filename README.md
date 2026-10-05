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
  config/
    load.js         YAML loading, validation, normalization
    duration.js     "30s" / "500ms" duration parsing
  http-utils.js     JSON / error response helpers
mock/
  upstream.js       Mock upstream server (used by tests and `npm run mock`)
test/
  helpers/          Start gateway / upstream on ephemeral ports
  *.test.js
gateway.yaml        Example config (the spec)
```

## Feature checklist

- [x] Load config from CLI arg or `GATEWAY_CONFIG`; fail fast on malformed config
- [x] `GET /health` returns status and uptime
- [x] 404 for unmatched routes
- [ ] Route matching + basic proxying
- [ ] Method filtering (405)
- [ ] `strip_prefix`
- [ ] Upstream timeouts (`global_timeout`, per-route `timeout`)
- [ ] Rate limiting (`fixed_window`, `sliding_window`; per `ip` / `global`)
- [ ] Retries with backoff
- [ ] Load balancing (`round_robin`, `weighted_round_robin`)
- [ ] Active health checks
- [ ] API key auth
- [ ] Circuit breaker
- [ ] Request / response header transforms
- [ ] Request body mapping / response envelope

See `DECISIONS.md` for prioritization and design trade-offs.
