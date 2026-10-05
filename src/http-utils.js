/** Send a JSON response. Safe to call once per response. */
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** Send a gateway-generated error in a consistent shape. */
export function sendError(res, status, error, extra = {}) {
  sendJson(res, status, { error, ...extra });
}
