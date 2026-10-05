import { once } from 'node:events';
import { createMockUpstream } from '../../mock/upstream.js';
import { normalizeConfig } from '../../src/config/load.js';
import { createGateway } from '../../src/gateway.js';

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
 * Start a gateway from a raw (un-normalized) config object, as if it had been
 * read from YAML. Returns { url, close }.
 */
export async function startGateway(rawConfig, options) {
  const server = createGateway(normalizeConfig(rawConfig), options);
  const url = await listen(server);
  return { url, close: () => close(server) };
}
