/**
 * Layer 4a: executor.
 *
 * Carries out a `RoutingDecision` by making the model calls the strategy
 * prescribes and recording a `ModelInvocationResult` for each:
 *
 *   single_shot     - one call to the primary model.
 *   draft_verify    - draft with the primary, then a verifier pass.
 *   bounded_cascade - primary, escalating through fallbacks until one succeeds.
 *   holdout         - no model call.
 *
 * The actual network call is an injected `InvokeModel` seam so the executor is
 * unit-testable and provider-agnostic; `makeRegistryInvoker` wires the real
 * path through the existing `ProviderRegistry` adapters. Invocations never
 * throw out of the executor - a failed call becomes a `status: 'error'` result
 * so fallbacks and logging keep working.
 */

import type { Adapter } from '../adapters/types.js';
import type { RunMode } from '../modes/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderId } from '../types.js';
import type { InvocationRole } from './logger.js';
import type {
  CandidateModel,
  CodingSubtask,
  ModelInvocationResult,
  RoutingDecision,
} from './types.js';

export type InvokeRequest = {
  modelId: string;
  via?: string;
  provider?: ProviderId;
  role: InvocationRole;
  task: CodingSubtask;
  signal?: AbortSignal;
};

export type InvokeModel = (req: InvokeRequest) => Promise<ModelInvocationResult>;

export type ExecuteOptions = {
  invoke: InvokeModel;
  /** Candidate metadata so the executor can resolve `via`/`adapter` per model. */
  models?: CandidateModel[];
  signal?: AbortSignal;
  /** Callback per invocation (for live logging). */
  onInvocation?: (role: InvocationRole, result: ModelInvocationResult) => void;
  /** Predicate that marks an invocation as a failure (drives cascade escalation). */
  isFailure?: (r: ModelInvocationResult) => boolean;
};

export type ExecutionResult = {
  strategy: RoutingDecision['strategy'];
  status: 'ok' | 'error' | 'held_out';
  invocations: { role: InvocationRole; result: ModelInvocationResult }[];
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Best available text output (verifier > primary > last invocation). */
  text?: string;
};

const defaultIsFailure = (r: ModelInvocationResult): boolean => r.status !== 'ok';

export async function executeDecision(
  task: CodingSubtask,
  decision: RoutingDecision,
  opts: ExecuteOptions,
): Promise<ExecutionResult> {
  const byId = new Map((opts.models ?? []).map((m) => [m.modelId, m]));
  const isFailure = opts.isFailure ?? defaultIsFailure;
  const invocations: { role: InvocationRole; result: ModelInvocationResult }[] = [];

  const call = async (modelId: string, role: InvocationRole): Promise<ModelInvocationResult> => {
    const meta = byId.get(modelId);
    let result: ModelInvocationResult;
    try {
      result = await opts.invoke({
        modelId,
        via: meta?.via,
        provider: meta?.adapter,
        role,
        task,
        signal: opts.signal,
      });
    } catch (err) {
      result = {
        modelId,
        via: meta?.via,
        provider: meta?.adapter,
        status: 'error',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    invocations.push({ role, result });
    opts.onInvocation?.(role, result);
    return result;
  };

  if (decision.strategy === 'holdout') {
    return {
      strategy: 'holdout',
      status: 'held_out',
      invocations: [],
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  if (!decision.primaryModel) {
    return {
      strategy: decision.strategy,
      status: 'error',
      invocations: [],
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  let primaryText: string | undefined;
  let verifierText: string | undefined;

  if (decision.strategy === 'single_shot') {
    const r = await call(decision.primaryModel, 'primary');
    primaryText = r.text;
  } else if (decision.strategy === 'draft_verify') {
    const draft = await call(decision.primaryModel, 'primary');
    primaryText = draft.text;
    if (decision.verifierModel) {
      const v = await call(decision.verifierModel, 'verifier');
      verifierText = v.text;
    }
  } else if (decision.strategy === 'bounded_cascade') {
    const primary = await call(decision.primaryModel, 'primary');
    primaryText = primary.text;
    if (isFailure(primary)) {
      for (const fb of decision.fallbackModels ?? []) {
        const r = await call(fb, 'fallback');
        if (!isFailure(r)) {
          primaryText = r.text ?? primaryText;
          break;
        }
      }
    }
  }

  const costUsd = invocations.reduce((s, i) => s + i.result.costUsd, 0);
  const tokensIn = invocations.reduce((s, i) => s + i.result.tokensIn, 0);
  const tokensOut = invocations.reduce((s, i) => s + i.result.tokensOut, 0);
  const anyOk = invocations.some((i) => !isFailure(i.result));

  return {
    strategy: decision.strategy,
    status: anyOk ? 'ok' : 'error',
    invocations,
    costUsd,
    tokensIn,
    tokensOut,
    text: verifierText ?? primaryText ?? invocations.at(-1)?.result.text,
  };
}

export type RegistryInvokerOptions = {
  /** Working directory passed to the adapter (defaults to process cwd). */
  cwd?: string;
  /** Read-only invocation (default true - the router executor doesn't mutate). */
  readOnly?: boolean;
  runMode?: RunMode;
  /** System prompt for the call. */
  systemPrompt?: string;
};

/**
 * Build an `InvokeModel` backed by the real `ProviderRegistry`. Resolves the
 * route (`via,modelId`, falling back to the bare modelId), runs the adapter,
 * and maps `AdapterCallResult` into a `ModelInvocationResult`. Never throws.
 */
export function makeRegistryInvoker(
  registry: ProviderRegistry,
  options: RegistryInvokerOptions = {},
): InvokeModel {
  return async (req) => {
    const start = Date.now();
    const route = req.via ? `${req.via},${req.modelId}` : req.modelId;
    try {
      const { adapter, providerName }: { adapter: Adapter; providerName: string } =
        registry.resolve(route);
      const res = await adapter.run({
        prompt: req.task.prompt,
        systemPrompt: options.systemPrompt,
        cwd: options.cwd ?? process.cwd(),
        readOnly: options.readOnly ?? true,
        runMode: options.runMode,
        signal: req.signal,
      });
      return {
        modelId: req.modelId,
        via: providerName,
        provider: adapter.id,
        status: 'ok',
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        costUsd: res.costUsd,
        latencyMs: res.durationMs || Date.now() - start,
        text: res.text,
      };
    } catch (err) {
      return {
        modelId: req.modelId,
        via: req.via,
        provider: req.provider,
        status: 'error',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
