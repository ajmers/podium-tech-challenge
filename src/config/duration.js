const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Parse a duration string like "500ms", "30s", "5m", "1h" into milliseconds.
 * Throws on anything it does not recognise so bad config fails fast at startup.
 */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  const match = typeof value === 'string' && /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration: ${JSON.stringify(value)} (expected e.g. "500ms", "30s", "5m")`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}
