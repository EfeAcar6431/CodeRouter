// Four-layer routing module.
//
// Legacy router primitives (migrated from `router/`): classification-driven
// `pick`/`pickStrong`, difficulty, effort, instant, memory bias.
export * from './effort.js';
export * from './fast.js';
export * from './instant.js';
export * from './policy.js';
export * from './bias.js';

// New four-layer surface: hard filters -> value scorer -> strategy selector.
export * from './reasonCodes.js';
export * from './types.js';
export * from './catalog.js';
export * from './featureExtractor.js';
export * from './hardFilters.js';
export * from './scorer.js';
export * from './strategySelector.js';
export * from './router.js';
export * from './executor.js';
export * from './logger.js';
export * from './shadow.js';
export * from './policies/heuristicPolicy.js';
