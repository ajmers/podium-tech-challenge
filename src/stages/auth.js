import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigError } from '../config/load.js';
import { sendError } from '../http-utils.js';

const DEFAULT_HEADER = 'X-API-Key';

/**
 * API key authentication.
 *
 *   auth:
 *     type: "api_key"
 *     header: "X-API-Key"        # optional, defaults to X-API-Key
 *     keys: ["sk_live_abc123"]
 *
 * Requests without a valid key get 401 and never reach the upstream. Missing
 * and wrong keys get the same response so callers can't tell them apart.
 * The key header is removed before forwarding so the credential doesn't leak
 * into upstream logs.
 */
export const authStage = {
  name: 'auth',

  create(route) {
    if (route.auth === undefined) return null;
    const { headerName, keyDigests } = parseAuthConfig(route.auth, `route "${route.path}" auth`);

    return async (ctx, next) => {
      const presented = ctx.req.headers[headerName];
      if (!isValidKey(presented, keyDigests)) {
        sendError(ctx.res, 401, 'unauthorized');
        return;
      }
      // The proxy builds upstream headers from req.headers.
      delete ctx.req.headers[headerName];
      await next();
    };
  },
};

function parseAuthConfig(auth, where) {
  if (!auth || typeof auth !== 'object') {
    throw new ConfigError(`${where} must be a mapping`);
  }
  // Fail closed: an auth block we don't understand must not leave the route open.
  if (auth.type !== 'api_key') {
    throw new ConfigError(`${where}.type ${JSON.stringify(auth.type)} is not supported (expected "api_key")`);
  }
  const header = auth.header ?? DEFAULT_HEADER;
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ConfigError(`${where}.header must be a non-empty string`);
  }
  const { keys } = auth;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ConfigError(`${where}.keys must be a non-empty list`);
  }
  if (!keys.every((key) => typeof key === 'string' && key !== '')) {
    throw new ConfigError(`${where}.keys must all be non-empty strings`);
  }
  return {
    // Node lowercases incoming header names.
    headerName: header.trim().toLowerCase(),
    keyDigests: keys.map(digest),
  };
}

/**
 * Compare in constant time so response timing doesn't reveal how much of a
 * guessed key was right. Hashing first gives equal-length buffers (which
 * timingSafeEqual requires) and hides key length; checking every key without
 * stopping early hides which key matched.
 */
function isValidKey(presented, keyDigests) {
  if (typeof presented !== 'string' || presented === '') return false;
  const candidate = digest(presented);
  let valid = false;
  for (const keyDigest of keyDigests) {
    valid = timingSafeEqual(candidate, keyDigest) || valid;
  }
  return valid;
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}
