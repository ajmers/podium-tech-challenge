# GatewayKit — SWE Take-Home (Spec)

> Transcribed from `GatewayKit_-_Take_Home_Project_Requirements.pdf`. The full example
> config is in [`../gateway.yaml`](../gateway.yaml) and is part of this spec.

## Scope

- The exercise is intentionally larger than 2 hours. AI coding tools are expected; the
  goal is to see how they're orchestrated to make strategic progress under time pressure.
- No one finishes everything. What matters is the quality of what's built, the order it's
  built in, and how clearly the omissions are explained. **"A well-architected gateway that
  handles three features cleanly will always beat a brittle gateway that half-implements six."**
- 2 hours to submit, followed by a 30-minute code walkthrough. Be ready to explain any code,
  including AI-generated code.

## The problem

Build **GatewayKit**, a lightweight, config-driven API gateway that sits between clients and
upstream services, handling routing, rate limiting, request/response transformation, and
resilience. Think a simplified Kong, Envoy, or AWS API Gateway, built from scratch.

## How it works

- `gateway.yaml` **is** the spec: build a gateway that reads it and behaves accordingly.
- The config is self-documenting; implement as much as possible in the time.
- Evaluation runs the gateway against the provided config, **then against a different config
  file with the same schema but different values and routes**. It must work with any valid
  config following the schema.

## Config summary (see `gateway.yaml` for the full file)

- `gateway.port`: 8080
- `GET /health` is always available regardless of config: `200 { "status": "healthy", "uptime_seconds": <int> }`
- `gateway.global_timeout`: default timeout for all upstream requests
- `gateway.global_rate_limit`: default rate limit for all routes unless overridden
  (`requests`, `window`, `strategy`: `fixed_window` | `sliding_window`, `per`: `ip` | `global`)
- `routes[]`:
  - `path`, `methods`, `strip_prefix` (e.g. `/api/products/123` → `/123`)
  - `upstream.url`, or `upstream.targets[]` (`url`, `weight`) with `balance`: `round_robin` | `weighted_round_robin`; `upstream.timeout` overrides the global timeout
  - `rate_limit` (same shape as the global one)
  - `retry`: `attempts`, `backoff` (`fixed` | `exponential`), `initial_delay`, `on` (status codes)
  - `health_check`: `path`, `interval`, `unhealthy_threshold` (consecutive failures)
  - `request_transform`: `headers.add` / `headers.remove`; `body.mapping` (destination ← source, dot notation, `$literal:...`, `$request_time`)
  - `response_transform`: `headers.add` / `headers.remove`; `body.envelope` (`$body`, `$response_time`, `$route_path`)
  - `auth`: `type: api_key`, `header`, `keys`
  - `circuit_breaker`: `threshold`, `window`, `cooldown`; when tripped return
    `503 { "error": "service_unavailable", "retry_after": <seconds_remaining> }`

## Core requirements (non-negotiable)

1. Start and listen on **port 8080**, reading config from a YAML path passed as a
   command-line argument or environment variable.
2. `GET /health` always returns `200 OK` with `{ "status": "healthy", "uptime_seconds": <int> }`, regardless of config.
3. **Basic proxying:** matching requests are forwarded upstream and the response returned. Unmatched routes return **404**.
4. **Method filtering:** e.g. a `POST` to a `["GET"]`-only route returns **405 Method Not Allowed**.
5. Works with **any valid config** following the schema, not just the example.

## What to submit

1. A Git repository with history intact; **commit history matters**.
2. A `DECISIONS.md` in the repo root covering:
   - how config features were prioritized
   - architectural choices and trade-offs (proxy pipeline structure, extensibility)
   - what would be built next with more time
   - partially implemented features and their current state
   - how AI tools were used (optional, encouraged)
3. A working **test suite runnable with a single command**, self-contained with a mock upstream or test harness.
4. A `README.md` with setup/run instructions, how to run tests, a checklist of implemented config features, and prerequisites.

## Evaluation

| Category | Weight | Looking for |
|---|---|---|
| Architectural judgment | 35% | Prioritization, pipeline structure for extensibility, trade-offs under time pressure; *why* things were built in the order they were |
| Code quality | 25% | Readability, separation of concerns, testing approach; another engineer could add a config feature in an afternoon |
| Production thinking | 25% | Error handling, concurrency, failure modes: upstream down? malformed config? 50 requests hitting a rate-limited route at once? |
| Communication | 15% | Quality of DECISIONS.md, commit history that tells a story, clear README |

## Constraints

- Any language. The standard library HTTP server/client and a YAML parser are allowed.
  **No existing API gateway, reverse proxy, or HTTP proxy frameworks/libraries**: building the proxy logic is the point.
- In-memory storage is fine; no database needed.
- Include a simple mock upstream: a few canned endpoints, ideally one slow or flaky.

## Ambiguities

Ambiguities in the config are intentional: **make a call, document the reasoning, move on.**
