#!/usr/bin/env node
import { ConfigError, loadConfigFile } from './config/load.js';
import { createGateway } from './gateway.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  const configPath = process.argv[2] ?? process.env.GATEWAY_CONFIG;
  if (!configPath) {
    console.error('Usage: node src/index.js <config.yaml>   (or set GATEWAY_CONFIG)');
    process.exit(2);
  }

  let config;
  try {
    config = await loadConfigFile(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const port = Number(process.env.PORT ?? config.gateway.port);
  const server = createGateway(config);

  server.on('error', (err) => {
    console.error(`Failed to start gateway: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`GatewayKit listening on :${port} with ${config.routes.length} route(s) from ${configPath}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
