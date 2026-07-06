import type { CognitiveShape } from '../types.js';
import type { Classification } from '../types.js';

/**
 * `--fast` escape hatch.
 *
 * When fast mode is on, the run pipeline skips:
 *   - the classifier cascade
 *   - the context scanner (no manifest passed to the adapter)
 *   - the validators (no lint/typecheck/test on the resulting diff)
 *
 * It DOES still run inside a worktree sandbox - that's a safety
 * invariant we never give up, because the diff is the only artifact
 * `coderouter` can review post-hoc.
 *
 * The router uses `lastKnownRoute` for the repo (persisted in the
 * SQLite store) when present, falling back to the configured default.
 */
export type FastClassification = Classification & { source: 'instant' };

export function fastClassification(
  prompt: string,
  lastKnown?: { taskType: Classification['taskType']; shape?: CognitiveShape },
): FastClassification {
  return {
    hash: 'fast',
    source: 'instant',
    confidence: 0.5,
    taskType: lastKnown?.taskType ?? 'feature',
    shape: lastKnown?.shape ?? {
      deepReasoning: 0.4,
      multiFileTaste: 0.4,
      hugeContext: 0.2,
      adversarial: 0.2,
      algorithmic: 0.2,
      exploratory: 0.4,
    },
    rationale: `fast-mode: skipping classifier, context, validators (prompt=${prompt.slice(0, 80)})`,
  };
}
