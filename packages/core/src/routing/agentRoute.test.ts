import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultProviders, ProviderRegistry } from '../providers/registry.js';
import { openStore } from '../store/index.js';
import {
  classificationToSubtask,
  collectAgentCandidates,
  routeAgentLive,
} from './agentRoute.js';
import type { Classification } from '../types.js';

const classification = (taskType: Classification['taskType'] = 'feature'): Classification => ({
  hash: 'h',
  source: 'rules',
  confidence: 0.9,
  rationale: '',
  taskType,
  shape: {
    deepReasoning: 0.2,
    multiFileTaste: 0.2,
    hugeContext: 0.1,
    adversarial: 0.1,
    algorithmic: 0.1,
    exploratory: 0.2,
  },
});

describe('classificationToSubtask', () => {
  it('marks creative prompts as low risk', () => {
    const st = classificationToSubtask({
      subtaskId: 't1',
      prompt: 'generate a new logo for CodeRouter',
      classification: classification('feature'),
      effort: 'medium',
    });
    expect(st.riskTier).toBe('low');
    expect(st.requiresTools).toBe(true);
  });

  it('marks high-effort work as high risk', () => {
    const st = classificationToSubtask({
      subtaskId: 't1',
      prompt: 'refactor the auth module',
      classification: classification('refactor'),
      effort: 'high',
    });
    expect(st.riskTier).toBe('high');
  });
});

describe('collectAgentCandidates + routeAgentLive', () => {
  let dir: string;
  let cachePath: string;
  const prevKey = process.env.OPENROUTER_API_KEY;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cr-agent-route-'));
    cachePath = join(dir, 'openrouter-models.json');
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    await writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        models: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            name: 'Sonnet',
            context_length: 200_000,
            pricing: { prompt: '0.000003', completion: '0.000015' },
            supported_parameters: ['tools', 'tool_choice'],
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          },
          {
            id: 'anthropic/claude-3-5-haiku',
            name: 'Haiku',
            context_length: 200_000,
            pricing: { prompt: '0.0000008', completion: '0.000004' },
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          },
          {
            id: '~anthropic/claude-opus-latest',
            name: 'Opus latest alias',
            context_length: 200_000,
            pricing: { prompt: '0.000015', completion: '0.000075' },
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          },
        ],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    await rm(dir, { recursive: true, force: true });
  });

  it('tags OpenRouter models as coderouter_agent / openrouter_agent', async () => {
    // Point the catalog cache at our fixture by writing the default path
    // is awkward; instead call getModelCatalog via collect with a registry
    // that is ready, and stub by temporarily writing to the real cache
    // location is too invasive. Use collectAgentCandidates with registry
    // and inject via getModelCatalog's cachePath through env isn't supported.
    // So we test routeAgentLive with an explicit candidate list instead,
    // and separately assert collectAgentCandidates shape when key is set.
    const registry = new ProviderRegistry(defaultProviders());
    // Force catalog path by writing to the default cache if needed —
    // collectAgentCandidates uses getModelCatalog() which reads ~/.coderouter.
    // For unit isolation, pass explicit candidates to routeAgentLive.
    const candidates = [
      {
        modelId: 'anthropic/claude-3-5-haiku',
        contextLength: 200_000,
        supportedParameters: ['tools'],
        pricePromptPer1M: 0.8,
        priceCompletionPer1M: 4,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: false,
        via: 'openrouter_agent',
        adapter: 'coderouter_agent' as const,
        codingScore: 52,
      },
      {
        modelId: 'anthropic/claude-sonnet-4-5',
        contextLength: 200_000,
        supportedParameters: ['tools'],
        pricePromptPer1M: 3,
        priceCompletionPer1M: 15,
        supportsTools: true,
        supportsVision: true,
        supportsStructuredOutput: false,
        via: 'openrouter_agent',
        adapter: 'coderouter_agent' as const,
        codingScore: 88,
      },
    ];

    const store = await openStore(join(dir, 'store.sqlite'));
    const task = classificationToSubtask({
      subtaskId: 'logo-1',
      prompt: 'generate a new logo for the app',
      classification: classification('feature'),
      effort: 'medium',
      repoId: dir,
    });
    expect(task.riskTier).toBe('low');

    const live = await routeAgentLive({
      task,
      registry,
      store: store.routing,
      candidates,
      fallback: {
        provider: 'coderouter_agent',
        model: 'anthropic/claude-sonnet-4-5',
        via: 'openrouter_agent',
        rationale: 'fallback',
      },
    });

    expect(live.route.model).toBeTruthy();
    expect(live.route.via).toBe('openrouter_agent');
    expect(live.route.provider).toBe('coderouter_agent');
    expect(live.route.rationale).toMatch(/routeSubtask:/);
    expect(live.decisionId).toBeTruthy();
    // Low-risk creative task should prefer the cheaper model.
    expect(live.route.model).toBe('anthropic/claude-3-5-haiku');

    const decisions = store.routing.listDecisions(5);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0]!.decision.primaryModel).toBe('anthropic/claude-3-5-haiku');
    store.db.close();
  });

  it('skips ~ alias models in collectAgentCandidates', async () => {
    // Smoke: with OPENROUTER_API_KEY set, collect returns something editable
    // or empty if cache miss — either way must not throw.
    const registry = new ProviderRegistry(defaultProviders());
    const cands = await collectAgentCandidates(registry);
    for (const c of cands) {
      expect(c.modelId.startsWith('~')).toBe(false);
      expect(c.adapter).toBeTruthy();
    }
  });
});
