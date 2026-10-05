/**
 * Picks which upstream target serves each request.
 *
 *   round_robin           targets in turn, ignoring weights
 *   weighted_round_robin  in proportion to weight, using nginx's "smooth"
 *                         algorithm: weights 3:1 give A A B A, not A A A B,
 *                         so lighter targets aren't left idle for long stretches
 *
 * A single-target upstream (`url:`) is just a one-item list, so every route
 * goes through the same code path.
 */
export const BALANCE_STRATEGIES = ['round_robin', 'weighted_round_robin'];

export function createBalancer({ targets, balance = 'round_robin' }) {
  if (targets.length === 1) return { pick: () => targets[0].url };
  return balance === 'weighted_round_robin' ? smoothWeighted(targets) : roundRobin(targets);
}

function roundRobin(targets) {
  let next = 0;
  return {
    pick() {
      const target = targets[next];
      next = (next + 1) % targets.length;
      return target.url;
    },
  };
}

function smoothWeighted(targets) {
  const state = targets.map((target) => ({ url: target.url, weight: target.weight, current: 0 }));
  const total = state.reduce((sum, t) => sum + t.weight, 0);
  return {
    pick() {
      // Every target gains its weight; the highest is chosen and pays back the total.
      let best = state[0];
      for (const t of state) {
        t.current += t.weight;
        if (t.current > best.current) best = t;
      }
      best.current -= total;
      return best.url;
    },
  };
}
