/**
 * Progress notifier shared by all modes.
 *
 * CLI: renders @clack/prompts spinners ('[2/6] GitHub code search ... done')
 * MCP: emits `progress` capability notifications when the host supports them.
 *
 * The core never imports a UI library; it speaks through this typed
 * callback so the same modes work in either rendering target.
 */

export type ProgressUpdate = {
  phase: string;
  stage: 'start' | 'progress' | 'done' | 'error';
  message?: string;
  /** Phase index, 1-based. */
  index?: number;
  /** Total phases. */
  total?: number;
  /** Free-form data the renderer can ignore or surface. */
  data?: Record<string, unknown>;
};

export type ProgressNotifier = (u: ProgressUpdate) => void;

export const noopProgress: ProgressNotifier = () => {};

/**
 * Shape the REPL looks for on `ProgressUpdate.data` to stamp every
 * log entry + the spinner with the active model. Every mode that
 * picks a route should include this before it starts streaming so
 * tool blocks show `openrouter_agent:…` on the right edge.
 */
export function routeProgressData(route: {
  provider: string;
  model: string;
  via?: string;
  rationale?: string;
}): { route: { provider: string; model: string; via: string; rationale: string } } {
  return {
    route: {
      provider: route.provider,
      model: route.model,
      via: route.via ?? route.provider,
      rationale: route.rationale ?? '',
    },
  };
}
