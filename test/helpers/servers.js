import http from 'node:http';
import { once } from 'node:events';
import { createMockUpstream } from '../../mock/upstream.js';
import { normalizeConfig } from '../../src/config/load.js';
import { createGateway } from '../../src/gateway.js';
import { createProxy } from '../../src/proxy.js';

/** Listen on an ephemeral port and return the base URL. */
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** Start a mock upstream. Returns { url, requests, close }. */
export async function startUpstream(options) {
  const { server, requests } = createMockUpstream(options);
  const url = await listen(server);
  return { url, requests, close: () => close(server) };
}

/**
 * Start a bare server that forwards every request to `target` via the proxy
 * module, with no routing. Returns { url, outcomes, close } where `outcomes`
 * collects what each forward() call resolved with.
 */
export async function startProxy({ target, timeoutMs = 5_000 }) {
  const proxy = createProxy();
  const outcomes = [];
  const server = http.createServer(async (req, res) => {
    outcomes.push(await proxy.forward(req, res, { target, path: req.url, timeoutMs }));
  });
  const url = await listen(server);
  return {
    url,
    outcomes,
    close: async () => {
      await close(server);
      proxy.close();
    },
  };
}

/**
 * Start a gateway from a raw (un-normalized) config object, as if it had been
 * read from YAML. Returns { url, close }.
 */
export async function startGateway(rawConfig, options) {
  const server = createGateway(normalizeConfig(rawConfig), options);
  const url = await listen(server);
  return { url, close: () => close(server) };
}
