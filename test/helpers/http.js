import http from 'node:http';

/**
 * Raw http.request so tests can send things fetch() refuses or normalizes away
 * (hop-by-hop headers, unnormalized paths like "/a/../b").
 */
export function rawRequest(url, { method = 'GET', path, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
