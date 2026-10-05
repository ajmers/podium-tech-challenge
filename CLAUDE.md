# GatewayKit

Config-driven API gateway take-home. The spec, including core requirements and evaluation criteria:

@docs/SPEC.md

## Working in this repo

- Node 22+, ESM, standard library `http` only; `yaml` is the sole dependency. No proxy/gateway libraries (spec constraint).
- `npm test` runs the self-contained suite (`node:test`, ephemeral ports). `npm start` runs on 8080 with `gateway.yaml`. `npm run demo` opens the demo UI on 8081.
- New config features are **stages** in `src/stages/` (`{ name, create(route, deps) }`, see `src/pipeline.js`), registered in order in `src/stages/index.js`. A stage validates its own config block at startup and throws `ConfigError`.
- Unimplemented config blocks must be accepted (any valid config has to run) but trigger a startup warning.

## Demo
Please put together a basic "demo" app I can run locally that allows me to play around with the functionality you've built. Add new features to it as we go.

## Prioritization: 
- Use plan mode 
- We will go through features one at a time so that I can review the implementation, see test results., and try the Demo app before committing manually
- scaffold first, then start implementing
- core requirements come before config features - start with proxying before defining individual route matching behaviors so we can define error behaviors (disconnect, 502, 504) before anyting depends on it
- build a request pipeline, modeled on nginx's phases and modules, for extensibility, code clarity / cleanliness (see 'pipeline' section beow)
- once basic gateway functionality is implemented, this is the order I built features in:
    - Auth
    - rate limiting
    - Load balancing
    - Request transforms
    - response transforms
    - Retry