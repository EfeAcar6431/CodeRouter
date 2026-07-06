# Routing roadmap (steps 12-16)

The MVP in this module is a **deterministic, fully-logged, evaluable** four-layer
router: hard filters → value scorer → strategy selector → executor, with a
per-decision audit trail (`store/routing.ts`) and an offline eval/replay harness
(`@coderouter/eval`). Everything below is intentionally **not built yet** - it is
the ordered plan for turning that honest baseline into a learning system.

Guiding principle: *logging and evaluation come before intelligence.* Every step
here is gated on the previous step's numbers moving in the eval/replay harness,
never on vibes.

## Where we are (MVP recap)

- `routeSubtask(task)` → `RoutingDecision` (`router.ts`), composing:
  - `featureExtractor.ts` (deterministic features)
  - `hardFilters.ts` (explainable, reason-coded rejections)
  - `scorer.ts` + `policies/heuristicPolicy.ts` (closed-form pass/cost/latency → utility)
  - `strategySelector.ts` (single_shot / draft_verify / bounded_cascade / holdout)
- `executor.ts` runs the decision (injected `InvokeModel`; `makeRegistryInvoker`
  wires the real `ProviderRegistry` path).
- `logger.ts` + `store/routing.ts` persist request / decision / invocation / outcome.
- `RoutingDecision.loggedPropensity = 1`, `explorationProbability = 0` — honest
  values for a deterministic argmax router, and the exact hooks the bandit needs.

---

## Step 12 — Harden `draft_verify`

**Goal:** make draft→verify a real quality lever, not just two calls.

- Define a concrete verifier contract: the verifier consumes the draft's diff +
  the task and returns a structured verdict (`pass | revise | fail` + notes),
  reusing the existing fix-pass in `handoff/workflow.ts` (`runHandoff`).
- Wire `executor.ts`'s `draft_verify` branch to `runHandoff` so a failed verify
  triggers one bounded revision by the verifier model.
- Log verifier verdicts into `execution_outcomes.verifier_pass`.
- **Gate:** on the eval set, `draft_verify` must raise pass rate over
  `single_shot` on medium-risk tasks at < 2× cost, or it's not selected.

## Step 13 — Harden `bounded_cascade`

**Goal:** principled escalation with a hard budget.

- Replace the fixed fallback list with a budget-aware ladder: escalate only
  while `spent + nextEstCost ≤ costBudget` and predicted marginal pass-prob gain
  clears a threshold; reuse `runTournament` / `orchestrate` from `workflows/`.
- Add an explicit stop-reason (`budget_exhausted`, `converged`, `max_depth`) to
  the invocation log.
- **Gate:** cascade must beat `always_strong` on cost/success for hard tasks in
  replay without losing pass rate.

## Step 14 — Learned scorer (offline-trained utility model)

**Goal:** replace the closed-form `heuristicPolicy` with a model trained on
logged outcomes.

- Build a training set from `routing_requests` ⋈ `routing_decisions` ⋈
  `model_invocations` ⋈ `execution_outcomes`: features → realized pass/cost/latency.
- Train a small calibrated pass-probability model per (task-kind × model) offline;
  keep cost/latency as measured empirical means. Ship as `policies/learnedPolicy.ts`
  behind the same `scoreCandidates` interface.
- **Gate:** learned scorer must beat `heuristic_router` on the replay harness
  (higher pass rate at equal-or-lower cost/success) before it becomes default.

## Step 15 — Shadow mode

**Goal:** compare policies on live traffic with zero risk.

- Run the candidate policy *alongside* the active one on every request, log both
  decisions (the shadow decision is logged, never executed), and diff them.
- Add a shadow report to `@coderouter/eval` that reads paired decisions and
  estimates the counterfactual delta (using replay's simulator for the untaken
  arm until real outcomes exist).
- **Gate:** promote a shadow policy to live only after N requests show a
  significant, positive counterfactual delta.

## Step 16 — Low-risk contextual bandit

**Goal:** controlled online exploration, unbiased by construction.

- Introduce ε-greedy / Thompson exploration **only** among near-tied top
  candidates (utility within a small margin), capped at a low
  `explorationProbability`; write the true draw probability into
  `RoutingDecision.loggedPropensity` (already plumbed) so off-policy estimates
  (IPS / doubly-robust) stay unbiased.
- Keep hard filters and safety/holdout rules non-explorable — exploration never
  overrides an impossibility or a safety-critical holdout.
- **Gate:** bandit must not regress pass rate on high-risk tasks and must show
  net utility improvement in shadow before enabling by default; ship with a
  kill-switch (`explorationProbability = 0` reverts to the deterministic argmax).

---

## Invariants to preserve across all steps

1. Every rejected candidate keeps at least one reason code.
2. Every decision remains fully logged with an honest `loggedPropensity`.
3. Holdout and hard-filter safety rules are never subject to exploration.
4. No step ships without moving the eval/replay numbers in the right direction.
