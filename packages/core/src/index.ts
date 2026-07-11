// Namespaced re-exports for callers that want module separation.
export * as adapters from './adapters/index.js';
export * as classify from './classify/index.js';
export * as router from './routing/index.js';
export * as sandbox from './sandbox/index.js';
export * as validate from './validate/index.js';
export * as modes from './modes/index.js';
export * as memory from './memory/index.js';
export * as store from './store/index.js';
export * as report from './report/index.js';
export * as config from './config/index.js';
export * as research from './research/index.js';
export * as handoff from './handoff/index.js';
export * as clarify from './clarify/index.js';
export * as context from './context/index.js';
export * as perf from './perf/index.js';
export * as transformers from './transformers/index.js';
export * as providers from './providers/index.js';
export * as workflows from './workflows/index.js';
export * as catalog from './catalog/index.js';
export * as agent from './agent/index.js';
export * as models from './models/index.js';
export * as customize from './customize/index.js';
export * as plugins from './plugins/index.js';
export * as loops from './loops/index.js';

// Convenience top-level re-exports of the most commonly used symbols.
// Mirrors what the CLI, MCP server, and eval harness import.
export * from './types.js';
export type { ProviderConfig, ProviderModelConfig } from './providers/types.js';
export type { ModeInput, ModeOutput, ModeContext, WorktreeHandle, RunMode } from './modes/types.js';
export type { ChatMessage, ContentBlock } from './agent/transport/types.js';
export { ConversationHistory } from './agent/history.js';
export { detectPromptImages, imageToDataUrl, imageMimeFromPath, imageBasename } from './context/images.js';
export type { ProgressNotifier, ProgressUpdate } from './modes/progress.js';
export type { Report } from './report/types.js';
export type { Store } from './store/index.js';
export type { Citation } from './types.js';
export type { Classification, TaskType, Effort, Mode, ProviderId, RouteRef } from './types.js';
export type {
  ActivityEvent,
  AskUserQuestionEntry,
  AskUserQuestionPayload,
} from './adapters/types.js';
export {
  ClassifierCascade,
  loadSeedCorpus,
  buildMergedIndex,
} from './classify/index.js';
export { matchInstant } from './routing/instant.js';
export { pick, pickStrong } from './routing/policy.js';
export type { RouterContext, MemoryBias, PickOptions } from './routing/policy.js';
export { fastClassification } from './routing/fast.js';
export { effortProfile } from './routing/effort.js';
export { deriveMemoryBias } from './routing/bias.js';
export { ProviderRegistry, defaultProviders } from './providers/index.js';
export { whichSync } from './sandbox/which.js';
export { resolveIntent, explainIntent, lookupModel, CATALOG } from './catalog/index.js';
export type { Intent, CatalogEntry } from './catalog/index.js';
export {
  MODEL_CARDS,
  findCard,
  cardTier,
  resolveCard,
  selectBest,
  selectModels,
  tierForCoding,
  taskFloor,
  computeQualityBias,
  observationsFromRuns,
  computeLatencyBias,
  latencyObservationsFromRuns,
  computePolicyPreference,
  policyObservationsFromRuns,
  routingPolicy,
} from './models/index.js';
export type {
  ModelCard,
  Modality,
  QualityTier,
  Candidate,
  SelectConstraints,
  Selection,
  Objective,
  ValueWeights,
  ModelObservation,
  LatencyObservation,
  PolicyObservation,
  RoutingPolicy,
  Difficulty,
  DifficultyBand,
} from './models/index.js';
export { estimateDifficulty } from './routing/difficulty.js';
export { runValidators, summarize, detectProject } from './validate/index.js';
export { scanContext } from './context/index.js';
export { loadProjectMemory, projectMemoryToSystemPrompt } from './memory/index.js';
export type { Rule, Skill, Subagent, AssetScope, AssetKind } from './customize/index.js';
export type {
  Plugin,
  PluginAsset,
  ResolvedPlugin,
  Marketplace,
  LoadedMarketplace,
  InstalledPlugin,
  InstallManifest,
} from './plugins/index.js';
export type {
  LoopSpec,
  LoopStatus,
  LoopRecord,
  LoopIteration,
  LoopEvent,
  LoopPreset,
  LoopValidation,
  VerifierResult,
  LoopRunContext,
} from './loops/index.js';
export {
  LoopSupervisor,
  generateLoopSpec,
  validateLoopSpec,
  discoverVerifiers,
  runLoop,
  approveLoopWorktree,
  discardLoopWorktree,
  PRESETS,
  applyPreset,
} from './loops/index.js';
export { coderouterHome } from './paths.js';
export {
  loadMcpServers,
  listMcpServers,
  saveMcpServer,
  removeMcpServer,
  graphifyPreset,
  projectMcpPath,
  globalMcpPath,
  getMcpToolsForCwd,
  disposeAllMcp,
  probeMcpServer,
} from './mcp/index.js';
export type { McpServerConfig, McpFile, McpToolInfo } from './mcp/index.js';
export { detectClarifications } from './clarify/index.js';
export {
  openStore,
  resolveDbPath,
  registerProject,
  listProjects,
  discoverProjects,
} from './store/index.js';
export type { ProjectEntry, ChatSession, ChatMessageRecord } from './store/index.js';
export { loadConfig } from './config/index.js';
export { runMode } from './modes/dispatch.js';
export { savePlanFile, loadPlanFile, renderPlanFile, parsePlanFile, newEmptyPlanFile } from './modes/planFile.js';
export type { PlanFile, PlanPhase, PlanFrontmatter } from './modes/planFile.js';
export type { Clarification, ClarificationSignal } from './clarify/types.js';
export {
  buildPlanClarifyQuestions,
  formatClarifyAnswers,
} from './clarify/planQuestions.js';
export type {
  PlanClarifyAnswer,
  PlanClarifyOption,
  PlanClarifyQuestion,
} from './clarify/planQuestions.js';
export {
  buildBrief,
  renderBriefAsPrompt,
  runHandoff,
} from './handoff/index.js';
export { runDualPlan } from './workflows/dualPlan.js';
export { runTournament } from './workflows/tournament.js';
export {
  buildReport,
  renderReportText,
  renderReportFooterText,
  renderReportJson,
} from './report/index.js';
export {
  DEFAULT_RULES as DEFAULT_INJECTION_RULES,
  scanText as scanForInjection,
  summarizeScan as summarizeInjectionScan,
  wrapUntrusted,
} from './security/index.js';
export type {
  InjectionFinding,
  InjectionRule,
  InjectionScanResult,
  InjectionSeverity,
} from './security/index.js';
export {
  buildCitations,
  renderReferences,
  injectInlineCitations,
  verifyCitations,
} from './research/citations.js';
