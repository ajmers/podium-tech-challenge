/**
 * Prefix router.
 *
 * - A route path matches itself and anything below it on a segment boundary:
 *   "/api/users" matches "/api/users" and "/api/users/42", not "/api/usersX".
 * - The longest (most specific) matching path wins, regardless of config order.
 * - If the path matches but the method is not allowed, the result is 405 with
 *   the allowed methods, rather than falling through to a shorter route.
 *
 * Routes are sorted once at startup; matching is a linear scan, which is
 * plenty for the handful of routes a gateway config typically has.
 */
export function createRouter(routes) {
  const ordered = [...routes].sort((a, b) => b.path.length - a.path.length);

  /**
   * @param {string} method    request method, e.g. "GET"
   * @param {string} pathname  normalized request path (no query string)
   * @returns {{ type: 'matched', route, upstreamPath: string }
   *         | { type: 'method_not_allowed', route, allowed: string[] }
   *         | { type: 'not_found' }}
   */
  function match(method, pathname) {
    const route = ordered.find((r) => pathMatches(r.path, pathname));
    if (!route) return { type: 'not_found' };
    if (route.methods && !route.methods.includes(method)) {
      return { type: 'method_not_allowed', route, allowed: route.methods };
    }
    return { type: 'matched', route, upstreamPath: upstreamPathFor(route, pathname) };
  }

  return { match };
}

function pathMatches(prefix, pathname) {
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * With strip_prefix the route path is removed before forwarding:
 *   "/api/products/123" -> "/123", "/api/products" -> "/".
 */
function upstreamPathFor(route, pathname) {
  if (!route.strip_prefix || route.path === '/') return pathname;
  return pathname.slice(route.path.length) || '/';
}
