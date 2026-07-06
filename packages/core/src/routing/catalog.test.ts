import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenRouterModel } from '../agent/providers/openrouter.js';
import {
  getModelCatalog,
  normalizeCatalog,
  supportsStructuredOutput,
  toCandidateModel,
} from './catalog.js';

const SAMPLE: OpenRouterModel[] = [
  {
    id: 'anthropic/claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['tools', 'tool_choice', 'reasoning', 'response_format'],
    architecture: { input_modalities: ['text', 'image'] },
  },
  {
    id: 'some-lab/random-chat-1b',
    name: 'Random Chat 1B',
    context_length: 8_000,
    pricing: { prompt: '0.0000001', completion: '0.0000002' },
    supported_parameters: [],
  },
  {
    id: 'qwen/qwen3-coder',
    name: 'Qwen3 Coder',
    context_length: 128_000,
    pricing: { prompt: '0.0000002', completion: '0.0000008' },
    supported_parameters: ['tools'],
  },
];

describe('routing/catalog normalizer', () => {
  it('maps an OpenRouterModel into a CandidateModel', () => {
    const c = toCandidateModel(SAMPLE[0]!);
    expect(c.modelId).toBe('anthropic/claude-sonnet-4-5');
    expect(c.contextLength).toBe(200_000);
    expect(c.pricePromptPer1M).toBeCloseTo(3, 5);
    expect(c.priceCompletionPer1M).toBeCloseTo(15, 5);
    expect(c.supportsTools).toBe(true);
    expect(c.supportsVision).toBe(true);
    expect(c.supportsStructuredOutput).toBe(true);
    expect(c.via).toBe('openrouter');
    expect(typeof c.codingScore).toBe('number');
  });

  it('detects structured-output support', () => {
    expect(supportsStructuredOutput(SAMPLE[0]!)).toBe(true);
    expect(supportsStructuredOutput(SAMPLE[2]!)).toBe(false);
  });

  it('filters to coding models by default', () => {
    const coding = normalizeCatalog(SAMPLE);
    const ids = coding.map((c) => c.modelId);
    expect(ids).toContain('anthropic/claude-sonnet-4-5');
    expect(ids).toContain('qwen/qwen3-coder');
    expect(ids).not.toContain('some-lab/random-chat-1b');
  });

  it('keeps everything with includeAll', () => {
    expect(normalizeCatalog(SAMPLE, { includeAll: true })).toHaveLength(3);
  });
});

describe('routing/catalog getModelCatalog (cached, no network)', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cr-catalog-'));
    cachePath = join(dir, 'openrouter-models.json');
    await writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), models: SAMPLE }), 'utf8');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a fresh on-disk cache and normalizes it', async () => {
    const cat = await getModelCatalog({ cachePath, ttlMs: 60_000, includeAll: true });
    expect(cat).toHaveLength(3);
    expect(cat.find((c) => c.modelId === 'qwen/qwen3-coder')?.supportsTools).toBe(true);
  });
});
