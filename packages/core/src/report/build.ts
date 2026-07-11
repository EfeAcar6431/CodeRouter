import type { ModeOutput } from '../modes/types.js';
import type { Report } from './types.js';

export function buildReport(prompt: string, out: ModeOutput): Report {
  return {
    runId: out.runId,
    mode: out.mode,
    status: out.status,
    prompt,
    classification: out.classification
      ? {
          taskType: out.classification.taskType,
          confidence: out.classification.confidence,
          rationale: out.classification.rationale,
          source: out.classification.source,
        }
      : undefined,
    routes: out.routes ?? [],
    costUsd: out.costUsd,
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    durationMs: out.durationMs,
    rationale: out.rationale,
    validators: out.validators ?? [],
    filesChanged: out.filesChanged,
    diff: out.diff,
    citations: out.citations,
    text: out.text,
    escalationHint: (out as { escalationHint?: string }).escalationHint,
    openQuestions: out.openQuestions,
    planId: out.planFile?.frontmatter.planId,
    phases: out.planFile?.frontmatter.phases,
    clarifications: out.clarifications,
    clarifyQuestions: out.clarifyQuestions,
    securityFindings: out.securityFindings,
    applied: out.applied,
    applyError: out.applyError,
    artifactDir: out.artifactDir,
    validatorsSkippedReason: out.validatorsSkippedReason,
    sessionId: out.sessionId,
    sessionProvider: out.sessionProvider,
    worktree: out.worktree,
    messages: out.messages,
  };
}
