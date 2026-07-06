import type { Classification, CognitiveShape } from '../types.js';

/**
 * Instant-route short-circuit.
 *
 * Some prompts are so cheap and well-defined that the entire classifier-
 * context-validators pipeline is a tax. This module owns the regex set
 * for those prompts; when a match fires, the router skips the rest and
 * hands off to the cheapest capable route immediately.
 *
 * Budget: <20ms per call. The router uses this BEFORE running the
 * cascade, so a green match guarantees no LLM judge fee.
 */

export type InstantPattern = {
  id: string;
  pattern: RegExp;
  taskType: Classification['taskType'];
  shape: CognitiveShape;
  /** Suggested route hint (resolved by router/policy). */
  route: 'cheap' | 'haiku' | 'local';
  rationale: string;
};

const TRIVIAL_SHAPE: CognitiveShape = {
  deepReasoning: 0,
  multiFileTaste: 0.1,
  hugeContext: 0,
  adversarial: 0,
  algorithmic: 0,
  exploratory: 0,
};

export const DEFAULT_INSTANT_PATTERNS: InstantPattern[] = [
  {
    id: 'typo-fix',
    pattern: /^\s*(?:fix|correct|repair)\s+typo/i,
    taskType: 'trivial',
    shape: TRIVIAL_SHAPE,
    route: 'cheap',
    rationale: 'instant:typo-fix',
  },
  {
    id: 'rename-symbol',
    pattern: /^\s*rename\s+(?:variable|function|class|symbol|file)\s+\w+/i,
    taskType: 'trivial',
    shape: { ...TRIVIAL_SHAPE, multiFileTaste: 0.3 },
    route: 'cheap',
    rationale: 'instant:rename',
  },
  {
    id: 'add-comment',
    pattern: /^\s*add\s+(?:a\s+)?(?:comment|jsdoc|docstring)/i,
    taskType: 'docs',
    shape: TRIVIAL_SHAPE,
    route: 'haiku',
    rationale: 'instant:add-comment',
  },
  {
    id: 'format-file',
    pattern: /^\s*(?:format|prettify|run\s+(?:prettier|biome))/i,
    taskType: 'trivial',
    shape: TRIVIAL_SHAPE,
    route: 'local',
    rationale: 'instant:format',
  },
  {
    id: 'commit-message',
    pattern: /(?:write|generate|create)\s+(?:a\s+)?commit\s+message/i,
    taskType: 'docs',
    shape: TRIVIAL_SHAPE,
    route: 'cheap',
    rationale: 'instant:commit-message',
  },
  {
    id: 'changelog',
    pattern: /(?:write|generate|update)\s+(?:the\s+)?changelog/i,
    taskType: 'docs',
    shape: { ...TRIVIAL_SHAPE, multiFileTaste: 0.2 },
    route: 'cheap',
    rationale: 'instant:changelog',
  },
];

export type InstantMatch = {
  matched: true;
  pattern: InstantPattern;
  classification: Classification;
};

export type InstantMiss = {
  matched: false;
};

/**
 * Returns a synthesised `Classification` when an instant pattern fires.
 * The cascade is never invoked for these prompts (saving ~50-500ms each).
 *
 * Callers MUST be free to bypass instant route via `--no-instant` or via
 * config; we surface it as a separate function (not baked into the
 * cascade) so the eval harness can isolate its accuracy.
 */
export function matchInstant(
  prompt: string,
  patterns: InstantPattern[] = DEFAULT_INSTANT_PATTERNS,
): InstantMatch | InstantMiss {
  for (const p of patterns) {
    if (p.pattern.test(prompt)) {
      return {
        matched: true,
        pattern: p,
        classification: {
          taskType: p.taskType,
          shape: p.shape,
          confidence: 0.99,
          rationale: p.rationale,
          source: 'instant',
          hash: '',
        },
      };
    }
  }
  return { matched: false };
}
