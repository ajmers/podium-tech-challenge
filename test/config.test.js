import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfigFile, parseConfig } from '../src/config/load.js';
import { parseDuration } from '../src/config/duration.js';

const EXAMPLE_CONFIG = fileURLToPath(new URL('../gateway.yaml', import.meta.url));

describe('parseDuration', () => {
  it('parses supported units', () => {
    assert.equal(parseDuration('250ms'), 250);
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('5m'), 300_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('1.5s'), 1_500);
  });

  it('rejects garbage', () => {
    for (const bad of ['', '30', 'ten seconds', '5d', '-1s', null, undefined]) {
      assert.throws(() => parseDuration(bad), /Invalid duration/, `expected ${bad} to throw`);
    }
  });
});

describe('config loading', () => {
  it('loads the example gateway.yaml', async () => {
    const config = await loadConfigFile(EXAMPLE_CONFIG);
    assert.equal(config.gateway.port, 8080);
    assert.equal(config.gateway.globalTimeoutMs, 30_000);
    assert.equal(config.routes.length, 5);
    assert.deepEqual(config.routes[0].methods, ['GET', 'POST']);
  });

  it('applies defaults for a minimal config', () => {
    const config = parseConfig('routes: []');
    assert.equal(config.gateway.port, 8080);
    assert.equal(config.gateway.globalTimeoutMs, 30_000);
  });

  it('rejects malformed YAML', () => {
    assert.throws(() => parseConfig('routes: [unclosed'), ConfigError);
  });

  it('rejects routes without a path or upstream', () => {
    assert.throws(() => parseConfig('routes:\n  - upstream: { url: "http://x" }'), /path/);
    assert.throws(() => parseConfig('routes:\n  - path: /a'), /upstream/);
  });

  it('rejects an invalid global timeout', () => {
    assert.throws(() => parseConfig('gateway:\n  global_timeout: soon'), /global_timeout/);
  });

  it('reports a missing file as a ConfigError', async () => {
    await assert.rejects(loadConfigFile('/does/not/exist.yaml'), ConfigError);
  });
});
