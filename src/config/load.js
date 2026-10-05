import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { parseDuration } from './duration.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT = '30s';

/** Read and parse a YAML config file from disk. */
export async function loadConfigFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${err.message}`);
  }
  return parseConfig(text);
}

/** Parse YAML text into a normalized config object. */
export function parseConfig(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${err.message}`);
  }
  return normalizeConfig(raw);
}

/**
 * Validate the raw config and convert it into the shape the gateway uses at
 * runtime (durations in ms, defaults applied). Everything downstream reads the
 * normalized form so feature code never re-parses strings.
 *
 * TODO: normalize per-feature blocks (rate_limit, retry, transforms, ...)
 * as each feature is implemented.
 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Config must be a YAML mapping');
  }
  const gateway = raw.gateway ?? {};
  const routes = raw.routes ?? [];
  if (!Array.isArray(routes)) {
    throw new ConfigError('"routes" must be a list');
  }

  return {
    gateway: {
      port: gateway.port ?? DEFAULT_PORT,
      globalTimeoutMs: wrapDuration(gateway.global_timeout ?? DEFAULT_TIMEOUT, 'gateway.global_timeout'),
      globalRateLimit: gateway.global_rate_limit ?? null,
    },
    routes: routes.map((route, i) => normalizeRoute(route, i)),
  };
}

function normalizeRoute(route, index) {
  const where = `routes[${index}]`;
  if (!route || typeof route !== 'object') {
    throw new ConfigError(`${where} must be a mapping`);
  }
  if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
    throw new ConfigError(`${where}.path must be a string starting with "/"`);
  }
  if (!route.upstream || typeof route.upstream !== 'object') {
    throw new ConfigError(`${where}.upstream is required`);
  }

  return {
    ...route,
    methods: (route.methods ?? []).map((m) => String(m).toUpperCase()),
    strip_prefix: Boolean(route.strip_prefix),
  };
}

function wrapDuration(value, field) {
  try {
    return parseDuration(value);
  } catch (err) {
    throw new ConfigError(`${field}: ${err.message}`);
  }
}
