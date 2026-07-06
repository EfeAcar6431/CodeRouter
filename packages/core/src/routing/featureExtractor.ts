/**
 * Feature extraction: turn a `CodingSubtask` into deterministic routing
 * features. Same task in -> same features out (no clocks, no randomness), so
 * the features can be logged and replayed for eval.
 *
 * Also exposes `subtaskToClassification`, a bridge that lets the scorer reuse
 * the existing `estimateDifficulty` / `routingPolicy` machinery (which operate
 * on the legacy `Classification` + `CognitiveShape`) without duplicating it.
 */

import type { Classification, CognitiveShape, TaskType } from '../types.js';
import type {
  CodingSubtask,
  CodingSubtaskKind,
  Confidence,
  ExpectedPatchSize,
  RoutingFeatures,
} from './types.js';

const STACK_TRACE_RE = /Traceback|Exception|stack trace|\bat [\w$.<>]+\(|Error:|panic:/i;

/** Rough token estimate: ~4 chars/token. */
export function estimatePromptTokens(prompt: string): number {
  return Math.max(1, Math.ceil(prompt.length / 4));
}

function localizationConfidence(filesCount: number): Confidence {
  if (filesCount === 1) return 'high';
  if (filesCount >= 2 && filesCount <= 5) return 'medium';
  // 0 files (unknown where to look) or a sprawling >5-file scope are both low.
  return 'low';
}

function expectedPatchSize(promptLen: number, filesCount: number): ExpectedPatchSize {
  if (promptLen > 1_500 || filesCount > 5) return 'large';
  if (promptLen < 400 && filesCount <= 1) return 'small';
  return 'medium';
}

export function extractFeatures(task: CodingSubtask): RoutingFeatures {
  const filesCount = task.filesInScope?.length ?? 0;
  const promptTokensEst = estimatePromptTokens(task.prompt);
  return {
    promptTokensEst,
    filesCount,
    hasStackTrace: STACK_TRACE_RE.test(task.prompt),
    language: task.language,
    taskKind: task.kind,
    riskTier: task.riskTier,
    // If the caller didn't pin a context requirement, assume the prompt plus a
    // working buffer for the model to reason + write the patch.
    minContextTokens: task.minContextTokens ?? promptTokensEst + 4_000,
    expectedPatchSize: expectedPatchSize(task.prompt.length, filesCount),
    localizationConfidence: localizationConfidence(filesCount),
    requiresTools: task.requiresTools ?? false,
    requiresStructuredOutput: task.requiresStructuredOutput ?? false,
  };
}

/** Map the new subtask taxonomy onto the legacy classifier `TaskType`. */
export function kindToTaskType(kind: CodingSubtaskKind): TaskType {
  switch (kind) {
    case 'bugfix':
      return 'bugfix';
    case 'refactor':
      return 'refactor';
    case 'test_generation':
      return 'test';
    case 'doc_to_code':
      return 'feature';
    case 'review':
      return 'review';
    case 'code_search':
    case 'localization':
      return 'investigation';
    case 'cli_script':
      return 'feature';
    default:
      return 'feature';
  }
}

/** Map the legacy classifier `TaskType` onto the new subtask taxonomy. */
export function taskTypeToKind(taskType: TaskType): CodingSubtaskKind {
  switch (taskType) {
    case 'bugfix':
      return 'bugfix';
    case 'refactor':
      return 'refactor';
    case 'test':
      return 'test_generation';
    case 'review':
      return 'review';
    case 'investigation':
      return 'code_search';
    case 'trivial':
      return 'cli_script';
    case 'docs':
    case 'feature':
      return 'doc_to_code';
    default:
      return 'doc_to_code';
  }
}

/**
 * Synthesize a `Classification` from a subtask + its features so we can reuse
 * `estimateDifficulty` and `routingPolicy`. The cognitive shape is derived from
 * risk tier, task kind, and localization confidence - a coarse but deterministic
 * stand-in for the full classifier when routing a pre-labelled subtask.
 */
export function subtaskToClassification(
  task: CodingSubtask,
  features: RoutingFeatures,
): Classification {
  const risk = task.riskTier;
  const riskWeight = risk === 'high' ? 0.8 : risk === 'medium' ? 0.5 : 0.25;
  const bigScope = features.filesCount > 5 || features.expectedPatchSize === 'large';
  const lowLoc = features.localizationConfidence === 'low';

  const shape: CognitiveShape = {
    deepReasoning: clamp01(riskWeight + (task.kind === 'bugfix' ? 0.15 : 0)),
    multiFileTaste: clamp01((bigScope ? 0.7 : 0.3) + (task.kind === 'refactor' ? 0.2 : 0)),
    hugeContext: clamp01(
      features.minContextTokens > 100_000 ? 0.8 : features.minContextTokens / 200_000,
    ),
    adversarial: clamp01(task.kind === 'review' ? 0.6 : riskWeight * 0.5),
    algorithmic: clamp01(task.kind === 'bugfix' ? 0.5 : 0.3),
    exploratory: clamp01(lowLoc ? 0.7 : 0.3),
  };

  return {
    taskType: kindToTaskType(task.kind),
    shape,
    // Lower confidence when we can't localize - nudges difficulty up.
    confidence: lowLoc ? 0.5 : 0.85,
    rationale: `subtask:${task.kind} risk=${risk} files=${features.filesCount}`,
    source: 'rules',
    hash: task.subtaskId,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
