import type { Store } from '../store/index.js';
import type { TaskType } from '../types.js';
import type { MemoryBias } from './policy.js';

/**
 * Materializes a `MemoryBias` for the router from the persistent store.
 *
 * Currently surfaces:
 *   - lastSuccessfulRoute: route that succeeded most recently for the
 *     same task type (used by --fast).
 *   - forbiddenRoutes: routes with high recent failure rates for this
 *     task type (e.g. Codex failed 4/4 times on this repo's React
 *     components).
 *   - preferredRoutes: routes with strong success rates (top-1 wins).
 *
 * The thresholds are conservative so the router never gets stuck in a
 * single bad choice from a small sample.
 */
export type BiasOptions = {
  taskType: TaskType;
  failRate: number;
  preferRate: number;
  minSamples: number;
};

const DEFAULTS: BiasOptions = {
  taskType: 'feature',
  failRate: 0.8,
  preferRate: 0.7,
  minSamples: 3,
};

export function deriveMemoryBias(
  store: Store,
  opts: Partial<BiasOptions> & { taskType: TaskType },
): MemoryBias {
  const o = { ...DEFAULTS, ...opts };
  const stats = store.runs.routeStats(o.taskType);

  const forbidden: string[] = [];
  const preferred: { route: string; reason: string }[] = [];
  for (const s of stats) {
    if (s.total < o.minSamples) continue;
    const failRate = s.failed / s.total;
    if (failRate >= o.failRate) {
      forbidden.push(s.route);
      continue;
    }
    if (1 - failRate >= o.preferRate) {
      preferred.push({
        route: s.route,
        reason: `${Math.round((1 - failRate) * 100)}% success across ${s.total} runs for taskType=${o.taskType}`,
      });
    }
  }

  // Last successful route across any task type (used by --fast).
  const recent = store.runs.list(20);
  const lastSuccessRun = recent.find((r) => r.status === 'success');
  const lastSuccessfulRoute = lastSuccessRun?.routes[0]
    ? `${lastSuccessRun.routes[0].via ?? lastSuccessRun.routes[0].provider},${lastSuccessRun.routes[0].model}`
    : undefined;

  return {
    forbiddenRoutes: forbidden,
    preferredRoutes: preferred,
    lastSuccessfulRoute,
  };
}
