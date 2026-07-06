import type { Adapter } from '../adapters/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RouterContext } from '../routing/policy.js';
import type { RouteRef } from '../types.js';

/**
 * Execution context for loop generation + running. Mirrors `ModeContext`
 * but is owned by the loops layer so the supervisor/runner don't depend
 * on the modes module. The daemon/CLI builds this per loop (same wiring
 * as `executeRun`).
 */
export type LoopRunContext = {
  registry: ProviderRegistry;
  router: RouterContext;
  cwd: string;
  /** Override adapter resolution (tests / eval). */
  resolveAdapter?: (route: RouteRef) => Adapter;
};

export function resolveLoopAdapter(route: RouteRef, ctx: LoopRunContext): Adapter {
  return ctx.resolveAdapter
    ? ctx.resolveAdapter(route)
    : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;
}
