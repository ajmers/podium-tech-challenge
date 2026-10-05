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

  const globalTimeoutMs = wrapDuration(gateway.global_timeout ?? DEFAULT_TIMEOUT, 'gateway.global_timeout');
  const normalizedRoutes = routes.map((route, i) => normalizeRoute(route, i, { globalTimeoutMs }));

  const seen = new Set();
  for (const route of normalizedRoutes) {
    if (seen.has(route.path)) {
      throw new ConfigError(`Duplicate route path "${route.path}"`);
    }
    seen.add(route.path);
  }

  return {
    gateway: {
      port: gateway.port ?? DEFAULT_PORT,
      globalTimeoutMs,
      globalRateLimit: gateway.global_rate_limit ?? null,
    },
    routes: normalizedRoutes,
  };
}

function normalizeRoute(route, index, { globalTimeoutMs }) {
  const where = `routes[${index}]`;
  if (!route || typeof route !== 'object') {
    throw new ConfigError(`${where} must be a mapping`);
  }
  if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
    throw new ConfigError(`${where}.path must be a string starting with "/"`);
  }
  if (route.methods !== undefined && (!Array.isArray(route.methods) || route.methods.length === 0)) {
    throw new ConfigError(`${where}.methods must be a non-empty list (omit it to allow all methods)`);
  }

  return {
    ...route,
    path: normalizeRoutePath(route.path),
    // null means "any method"
    methods: route.methods ? route.methods.map((m) => String(m).toUpperCase()) : null,
    strip_prefix: Boolean(route.strip_prefix),
    upstream: normalizeUpstream(route.upstream, `${where}.upstream`, { globalTimeoutMs }),
  };
}

/** "/api/users/" -> "/api/users"; "/" stays "/". */
function normalizeRoutePath(path) {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Both upstream shapes become a list of targets, so a single `url` is just a
 * one-target pool and load balancing can be added without touching callers:
 *   { url }                       -> targets: [{ url, weight: 1 }]
 *   { targets: [{url, weight}] }  -> targets as given
 */
function normalizeUpstream(upstream, where, { globalTimeoutMs }) {
  if (!upstream || typeof upstream !== 'object') {
    throw new ConfigError(`${where} is required`);
  }

  let targets;
  if (upstream.url !== undefined) {
    targets = [{ url: upstream.url, weight: 1 }];
  } else if (Array.isArray(upstream.targets) && upstream.targets.length > 0) {
    targets = upstream.targets.map((t) => ({ url: t?.url, weight: t?.weight ?? 1 }));
  } else {
    throw new ConfigError(`${where} needs either "url" or a non-empty "targets" list`);
  }

  targets.forEach((target, i) => {
    const field = upstream.url !== undefined ? `${where}.url` : `${where}.targets[${i}]`;
    validateUpstreamUrl(target.url, field);
    if (!Number.isInteger(target.weight) || target.weight < 1) {
      throw new ConfigError(`${field}.weight must be a positive integer`);
    }
  });

  return {
    ...upstream,
    targets,
    timeoutMs: upstream.timeout === undefined ? globalTimeoutMs : wrapDuration(upstream.timeout, `${where}.timeout`),
  };
}

function validateUpstreamUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${field}: invalid URL ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${field}: URL must be http or https`);
  }
}

function wrapDuration(value, field) {
  try {
    return parseDuration(value);
  } catch (err) {
    throw new ConfigError(`${field}: ${err.message}`);
  }
}
