/**
 * Dashboard data layer.
 *
 * Pure-ish aggregation over the project store (`.coderouter/memory.db`)
 * plus a read of the global settings file (`~/.coderouter/credentials.json`).
 * The HTTP layer (`server.ts`) is a thin shell around these functions, so
 * all the interesting logic stays here and is unit-testable without a
 * socket.
 *
 * Usage is project-scoped on purpose: every other CodeRouter command keys
 * off `--cwd` and writes runs into that repo's db, so the dashboard mirrors
 * that contract. The header surfaces which project it's reporting on.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  CATALOG,
  ProviderRegistry,
  agent,
  customize,
  defaultProviders,
  discoverProjects,
  listProjects,
  models,
  openStore,
  plugins,
  registerProject,
  resolveDbPath,
} from '@coderouter/core';
import type { InstalledPlugin, Plugin, ResolvedPlugin, Rule, RunMode, Skill, Subagent } from '@coderouter/core';
import type { RunRecord } from '@coderouter/core/store';
import {
  CREDENTIALS_PATH,
  SEARCH_PROVIDERS,
  SETUP_PROVIDERS,
  getAutoApply,
  getPreferredModels,
  getPreviewInApp,
  getRunMode,
  getSpendingLimit,
  type SetupProvider,
} from '../ui/setup.js';
import { detectHosts, type DetectedHost } from '../ui/hosts.js';

export type UsageTotals = {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  costUsd: number;
  /** Cost incurred in the current calendar month (local time). */
  monthCostUsd: number;
  /** `YYYY-MM` key for the month `monthCostUsd` covers. */
  monthKey: string;
  /** 0-1 fraction of runs that ended `success`. */
  successRate: number;
  avgDurationMs: number;
  /** Average user rating across rated runs, or null when none rated. */
  avgRating: number | null;
};

export type BreakdownRow = {
  key: string;
  label: string;
  runs: number;
  tokens: number;
  costUsd: number;
};

export type HeatmapDay = {
  /** ISO date, `YYYY-MM-DD`, local time. */
  date: string;
  runs: number;
  tokens: number;
  costUsd: number;
};

export type RecentRun = {
  id: string;
  createdAt: number;
  mode: string;
  status: string;
  taskType: string | null;
  /** Primary route (`provider,model`), kept for back-compat/sorting. */
  route: string;
  /**
   * Every distinct model the run touched, in order of first use, as
   * `provider,model` labels. A single task often fans out across several
   * models (classifier judge, main agent, escalated fixer), so the UI
   * renders the whole set rather than just the primary route.
   */
  routes: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  rating: number | null;
  prompt: string;
};

export type UsageReport = {
  /**
   * `cwd` is the repo the dashboard was launched from; the report itself
   * aggregates usage across every CodeRouter project on this machine.
   * `projectCount` is how many contributed data.
   */
  project: { cwd: string; dbPath: string; hasData: boolean; projectCount: number };
  totals: UsageTotals;
  byMode: BreakdownRow[];
  byProvider: BreakdownRow[];
  byTaskType: BreakdownRow[];
  heatmap: HeatmapDay[];
  highlights: {
    mostActiveMonth: string | null;
    mostActiveDay: string | null;
    longestStreakDays: number;
    currentStreakDays: number;
  };
  recentRuns: RecentRun[];
  generatedAt: number;
};

export type ProviderSetting = {
  name: string;
  label: string;
  envVar: string;
  example: string;
  configured: boolean;
  /** Where the key came from: the credentials file, the shell env, or nowhere. */
  source: 'file' | 'shell' | 'none';
  /** Masked preview (e.g. `sk-or-…a1b2`); never the raw key. */
  masked: string | null;
};

export type HostSetting = {
  provider: DetectedHost['provider'];
  label: string;
  cli: string;
  binPath: string;
  blurb: string;
  enabled: boolean;
};

export type AvailableModel = {
  provider: string;
  model: string;
  label: string;
  /** Rough tier hint from the catalog: which intents this model serves. */
  tiers: ('strong' | 'cheap' | 'balanced')[];
};

export type SettingsReport = {
  providers: ProviderSetting[];
  /** Optional web-search API keys (Tavily/Brave). Not required to run. */
  searchProviders: ProviderSetting[];
  hosts: HostSetting[];
  limits: { monthlyUsd: number | null };
  /** Whether agent/chat file changes are applied automatically (vs. reviewed). */
  autoApply: boolean;
  /** How the agent executes commands + edits. */
  runMode: RunMode;
  /** Whether previews open in Studio's built-in browser (vs. the OS browser). */
  previewInApp: boolean;
  preferredModels: {
    strong: { provider: string; model: string } | null;
    cheap: { provider: string; model: string } | null;
  };
  availableModels: AvailableModel[];
  paths: { credentials: string; db: string };
};

/** A single OpenRouter catalog model, trimmed to what the picker needs. */
export type CatalogModel = {
  /** OpenRouter id, e.g. `anthropic/claude-sonnet-4-5`. */
  id: string;
  /** Human label from the catalog (falls back to the id). */
  label: string;
  /** USD per 1M input / output tokens (0 when unknown or free). */
  pricePer1MIn: number;
  pricePer1MOut: number;
  /** Max context window in tokens (0 when unknown). */
  contextWindow: number;
  /** Whether the model advertises tool-calling (needed for agent mode). */
  tools: boolean;
  /** Whether the model accepts image input. */
  vision: boolean;
  /** Benchmark-grounded coding score (0-100) from the curated catalog. */
  coding: number;
  /** Coarse quality tier (`frontier`/`strong`/`mid`/`small`). */
  tier: string;
};

export type OpenRouterCatalog = {
  models: CatalogModel[];
  /** Non-null when the catalog couldn't be fetched (offline, no cache). */
  error: string | null;
};

/** Rules / skills / subagents, both scopes, for the customization UI. */
export type AssetsReport = {
  rules: Rule[];
  skills: Skill[];
  subagents: Subagent[];
  /** Resolved roots so the UI can show where files live. */
  roots: { project: string; global: string };
};

export async function buildAssetsReport(cwd: string): Promise<AssetsReport> {
  const [rules, skills, subagents] = await Promise.all([
    customize.loadRules(cwd),
    customize.loadSkills(cwd),
    customize.loadSubagents(cwd),
  ]);
  return {
    rules,
    skills,
    subagents,
    roots: {
      project: customize.scopeRoot('project', cwd),
      global: customize.scopeRoot('global', cwd),
    },
  };
}

/** A catalog plugin (marketplace entry) annotated with install state. */
export type PluginListItem = Pick<
  Plugin,
  'id' | 'name' | 'description' | 'author' | 'category' | 'tags' | 'homepage' | 'marketplace'
> & {
  installedProject: boolean;
  installedGlobal: boolean;
};

export type PluginsReport = {
  catalog: PluginListItem[];
  marketplaces: Array<{
    name: string;
    repo: string;
    source: 'builtin' | 'user';
    owner?: string;
    count: number;
    error?: string;
  }>;
  categories: string[];
  /** Installed plugins no longer found in any marketplace (orphans). */
  orphans: PluginListItem[];
};

/**
 * Build the marketplace view: catalog from all registered marketplaces
 * (cloned blobless on first read) + per-scope install state. Plugin
 * assets are NOT resolved here — that happens lazily on preview/install.
 */
export async function buildPluginsReport(
  cwd: string,
  opts: { refresh?: boolean } = {},
): Promise<PluginsReport> {
  const [{ plugins: catalogPlugins, marketplaces }, { project, global }] = await Promise.all([
    plugins.loadCatalog(opts),
    plugins.loadAllInstalled(cwd),
  ]);
  const inProject = new Set(project.map((p) => p.id));
  const inGlobal = new Set(global.map((p) => p.id));

  const toItem = (p: Plugin): PluginListItem => ({
    id: p.id,
    name: p.name,
    description: p.description,
    author: p.author,
    category: p.category,
    tags: p.tags,
    homepage: p.homepage,
    marketplace: p.marketplace,
    installedProject: inProject.has(p.id),
    installedGlobal: inGlobal.has(p.id),
  });

  const catalog = catalogPlugins.map(toItem);
  const known = new Set(catalogPlugins.map((p) => p.id));

  // Installed plugins that no longer appear in any marketplace.
  const orphanMap = new Map<string, PluginListItem>();
  const addOrphan = (rec: InstalledPlugin, scope: 'project' | 'global') => {
    if (known.has(rec.id)) return;
    const item =
      orphanMap.get(rec.id) ??
      ({
        id: rec.id,
        name: rec.name,
        description: `Installed from ${rec.marketplace}`,
        category: 'Installed',
        tags: [],
        marketplace: rec.marketplace,
        installedProject: false,
        installedGlobal: false,
      } as PluginListItem);
    if (scope === 'project') item.installedProject = true;
    else item.installedGlobal = true;
    orphanMap.set(rec.id, item);
  };
  for (const r of project) addOrphan(r, 'project');
  for (const r of global) addOrphan(r, 'global');

  const categories = [...new Set(catalog.map((p) => p.category).filter(Boolean))].sort() as string[];
  return { catalog, marketplaces, categories, orphans: [...orphanMap.values()] };
}

/** Resolve a single plugin's assets (clones its repo) for the detail modal. */
export async function buildPluginPreview(
  id: string,
  marketplace: string | undefined,
): Promise<ResolvedPlugin | { error: string }> {
  const plugin = await plugins.findPlugin(id, marketplace);
  if (!plugin) return { error: `plugin not found: ${id}` };
  return plugins.resolvePlugin(plugin);
}

const HEATMAP_DAYS = 371; // 53 weeks, aligned to whole weeks in the UI.

/**
 * Fetch the entire OpenRouter model catalog for the model picker. OpenRouter's
 * `/models` endpoint is public, so this works without an API key; results are
 * cached on disk by core, so repeat calls are cheap. On failure (offline, no
 * cache) we return an empty list plus an error message rather than throwing,
 * so the picker degrades to free-text entry.
 */
export async function buildOpenRouterCatalog(): Promise<OpenRouterCatalog> {
  try {
    const all = await agent.openrouter.fetchOpenRouterModels();
    const catalogModels: CatalogModel[] = all
      .map((m) => {
        const card = models.resolveCard(m.id, m);
        const coding = card.quality.coding;
        return {
          id: m.id,
          label: m.name ?? m.id,
          pricePer1MIn: agent.openrouter.pricePer1MIn(m),
          pricePer1MOut: agent.openrouter.pricePer1MOut(m),
          contextWindow: m.context_length ?? 0,
          tools: agent.openrouter.isToolCapable(m),
          vision: agent.openrouter.isVisionCapable(m),
          coding,
          tier: models.tierForCoding(coding),
        };
      })
      // Quality-first ordering: best coding score first, then larger
      // context, then id for stability. Mirrors how the router ranks.
      .sort((a, b) => {
        if (b.coding !== a.coding) return b.coding - a.coding;
        if (b.contextWindow !== a.contextWindow) return b.contextWindow - a.contextWindow;
        return a.id.localeCompare(b.id);
      });
    return { models: catalogModels, error: null };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read every run for the project at `cwd` and fold it into the shape the
 * dashboard renders. Opens the store read-only-ish (we never write) and
 * closes it before returning so we don't hold a WAL handle open for the
 * life of the server.
 */
let backfillPromise: Promise<unknown> | null = null;
/** Run the filesystem backfill at most once per process. */
function backfillProjectsOnce(): Promise<unknown> {
  if (!backfillPromise) backfillPromise = discoverProjects().catch(() => []);
  return backfillPromise;
}

export async function buildUsageReport(cwd: string): Promise<UsageReport> {
  const dbPath = resolveDbPath(cwd);
  const generatedAt = Date.now();

  // Make sure the current repo is tracked, then aggregate runs from every
  // CodeRouter project registered on this machine (deduped by db path).
  registerProject(cwd);
  // Once per dashboard process, backfill repos that already have a
  // `.coderouter/memory.db` but were never registered (best-effort).
  await backfillProjectsOnce();
  const dbPaths = new Set<string>();
  for (const p of listProjects()) dbPaths.add(p.dbPath);
  if (existsSync(dbPath)) dbPaths.add(dbPath);

  const runs: RunRecord[] = [];
  let projectCount = 0;
  for (const path of dbPaths) {
    if (!existsSync(path)) continue;
    const store = await openStore(path);
    try {
      // Bounded per project to cap memory across many repos.
      const projectRuns = store.runs.list(5000);
      if (projectRuns.length) projectCount++;
      runs.push(...projectRuns);
    } finally {
      try {
        store.db.close();
      } catch {
        // best-effort
      }
    }
  }

  if (runs.length === 0) {
    return emptyReport(cwd, dbPath, generatedAt);
  }

  // Merged across repos — re-sort recent-first for recentRuns/streaks.
  runs.sort((a, b) => b.createdAt - a.createdAt);

  return {
    project: { cwd, dbPath, hasData: true, projectCount },
    totals: computeTotals(runs),
    byMode: groupBy(runs, (r) => ({ key: r.mode, label: r.mode })),
    byProvider: groupBy(runs, (r) => {
      const primary = r.routes[0];
      const key = primary ? (primary.via ?? primary.provider) : 'unknown';
      const label = primary
        ? `${primary.via ?? primary.provider}${primary.model ? ` · ${primary.model}` : ''}`
        : 'unknown';
      return { key, label };
    }),
    byTaskType: groupBy(runs, (r) => ({
      key: r.taskType ?? 'unclassified',
      label: r.taskType ?? 'unclassified',
    })),
    heatmap: computeHeatmap(runs, generatedAt),
    highlights: computeHighlights(runs),
    recentRuns: runs.slice(0, 50).map(toRecentRun),
    generatedAt,
  };
}

/** Read provider keys (masked) + host enable flags from the global config. */
export function buildSettingsReport(cwd: string): SettingsReport {
  const file = readCredentialsFile();
  const providers: ProviderSetting[] = SETUP_PROVIDERS.map((p) => describeProvider(p, file));
  const searchProviders: ProviderSetting[] = SEARCH_PROVIDERS.map((p) => describeProvider(p, file));
  const hosts: HostSetting[] = detectHosts().map((h) => ({
    provider: h.provider,
    label: h.label,
    cli: h.cli,
    binPath: h.binPath,
    blurb: h.blurb,
    enabled: h.enabled,
  }));
  return {
    providers,
    searchProviders,
    hosts,
    limits: getSpendingLimit(),
    autoApply: getAutoApply(),
    runMode: getRunMode(),
    previewInApp: getPreviewInApp(),
    preferredModels: getPreferredModels(),
    availableModels: listAvailableModels(),
    paths: { credentials: CREDENTIALS_PATH, db: resolveDbPath(cwd) },
  };
}

/**
 * Catalog models the user can actually route to right now — i.e. whose
 * provider is configured + ready. De-duplicated by (provider, model)
 * and tagged with a coarse tier hint so the picker can group them.
 */
function listAvailableModels(): AvailableModel[] {
  const registry = new ProviderRegistry(defaultProviders());
  const seen = new Set<string>();
  const out: AvailableModel[] = [];
  for (const entry of CATALOG) {
    if (!registry.has(entry.provider)) continue;
    if (!registry.isReady(entry.provider)) continue;
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tiers = new Set<'strong' | 'cheap' | 'balanced'>();
    for (const b of entry.intents) {
      if (b.intent === 'deep-reasoning' || b.intent === 'multi-file' || b.intent === 'huge-context')
        tiers.add('strong');
      else if (b.intent === 'fast-cheap' || b.intent === 'local-offline') tiers.add('cheap');
      else if (b.intent === 'balanced-agent') tiers.add('balanced');
    }
    out.push({
      provider: entry.provider,
      model: entry.model,
      label: `${entry.provider} · ${entry.model}`,
      tiers: [...tiers],
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type CredentialsFileShape = {
  providers?: Record<string, { apiKey?: string }>;
};

function readCredentialsFile(): CredentialsFileShape {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFileShape;
  } catch {
    return {};
  }
}

function describeProvider(p: SetupProvider, file: CredentialsFileShape): ProviderSetting {
  const fileKey = file.providers?.[p.name]?.apiKey?.trim() || undefined;
  const envKey = process.env[p.envVar]?.trim() || undefined;
  // The CLI hydrates file keys into env at startup, so an env hit that
  // differs from the file value is a genuine shell-set key.
  const source: ProviderSetting['source'] = fileKey
    ? 'file'
    : envKey
      ? 'shell'
      : 'none';
  const raw = fileKey ?? envKey ?? null;
  return {
    name: p.name,
    label: p.label,
    envVar: p.envVar,
    example: p.example,
    configured: Boolean(raw),
    source,
    masked: raw ? maskKey(raw) : null,
  };
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function computeTotals(runs: RunRecord[]): UsageTotals {
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let monthCostUsd = 0;
  let durationMs = 0;
  let successes = 0;
  let ratingSum = 0;
  let ratingCount = 0;
  const monthKey = localDateKey(Date.now()).slice(0, 7);
  for (const r of runs) {
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    costUsd += r.costUsd;
    if (localDateKey(r.createdAt).slice(0, 7) === monthKey) monthCostUsd += r.costUsd;
    durationMs += r.durationMs;
    if (r.status === 'success') successes++;
    if (typeof r.rating === 'number') {
      ratingSum += r.rating;
      ratingCount++;
    }
  }
  return {
    runs: runs.length,
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    costUsd,
    monthCostUsd,
    monthKey,
    successRate: runs.length > 0 ? successes / runs.length : 0,
    avgDurationMs: runs.length > 0 ? durationMs / runs.length : 0,
    avgRating: ratingCount > 0 ? ratingSum / ratingCount : null,
  };
}

function groupBy(
  runs: RunRecord[],
  keyOf: (r: RunRecord) => { key: string; label: string },
): BreakdownRow[] {
  const map = new Map<string, BreakdownRow>();
  for (const r of runs) {
    const { key, label } = keyOf(r);
    const row = map.get(key) ?? { key, label, runs: 0, tokens: 0, costUsd: 0 };
    row.runs += 1;
    row.tokens += r.tokensIn + r.tokensOut;
    row.costUsd += r.costUsd;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.runs - a.runs);
}

function computeHeatmap(runs: RunRecord[], now: number): HeatmapDay[] {
  const byDate = new Map<string, { runs: number; tokens: number; costUsd: number }>();
  for (const r of runs) {
    const date = localDateKey(r.createdAt);
    const cur = byDate.get(date) ?? { runs: 0, tokens: 0, costUsd: 0 };
    cur.runs += 1;
    cur.tokens += r.tokensIn + r.tokensOut;
    cur.costUsd += r.costUsd;
    byDate.set(date, cur);
  }
  const out: HeatmapDay[] = [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (HEATMAP_DAYS - 1));
  for (let i = 0; i < HEATMAP_DAYS; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = localDateKey(d.getTime());
    const hit = byDate.get(key);
    out.push({ date: key, runs: hit?.runs ?? 0, tokens: hit?.tokens ?? 0, costUsd: hit?.costUsd ?? 0 });
  }
  return out;
}

function computeHighlights(runs: RunRecord[]): UsageReport['highlights'] {
  const byDay = new Map<string, number>();
  const byMonth = new Map<string, number>();
  for (const r of runs) {
    const day = localDateKey(r.createdAt);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    const month = day.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  }

  const mostActiveDay = topKey(byDay);
  const mostActiveMonth = topKey(byMonth);

  // Streaks: walk the sorted set of active days, counting consecutive
  // calendar days. Current streak is the run ending today or yesterday.
  const activeDays = [...byDay.keys()].sort();
  let longest = 0;
  let running = 0;
  let prev: number | null = null;
  for (const day of activeDays) {
    const ts = Date.parse(`${day}T00:00:00`);
    if (prev !== null && ts - prev === 86_400_000) {
      running += 1;
    } else {
      running = 1;
    }
    longest = Math.max(longest, running);
    prev = ts;
  }

  let current = 0;
  if (activeDays.length > 0) {
    const todayKey = localDateKey(Date.now());
    const yesterdayKey = localDateKey(Date.now() - 86_400_000);
    const last = activeDays[activeDays.length - 1]!;
    if (last === todayKey || last === yesterdayKey) {
      current = 1;
      for (let i = activeDays.length - 2; i >= 0; i--) {
        const a = Date.parse(`${activeDays[i + 1]}T00:00:00`);
        const b = Date.parse(`${activeDays[i]}T00:00:00`);
        if (a - b === 86_400_000) current += 1;
        else break;
      }
    }
  }

  return {
    mostActiveDay,
    mostActiveMonth,
    longestStreakDays: longest,
    currentStreakDays: current,
  };
}

function topKey(m: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [k, n] of m) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function toRecentRun(r: RunRecord): RecentRun {
  const labels: string[] = [];
  for (const ref of r.routes ?? []) {
    const label = `${ref.via ?? ref.provider}${ref.model ? `,${ref.model}` : ''}`;
    if (label && !labels.includes(label)) labels.push(label);
  }
  const route = labels[0] ?? '—';
  return {
    id: r.id,
    createdAt: r.createdAt,
    mode: r.mode,
    status: r.status,
    taskType: r.taskType,
    route,
    routes: labels,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    rating: r.rating,
    prompt: r.prompt.length > 140 ? `${r.prompt.slice(0, 140)}…` : r.prompt,
  };
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyReport(cwd: string, dbPath: string, generatedAt: number): UsageReport {
  return {
    project: { cwd, dbPath, hasData: false, projectCount: 0 },
    totals: {
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokens: 0,
      costUsd: 0,
      monthCostUsd: 0,
      monthKey: localDateKey(generatedAt).slice(0, 7),
      successRate: 0,
      avgDurationMs: 0,
      avgRating: null,
    },
    byMode: [],
    byProvider: [],
    byTaskType: [],
    heatmap: computeHeatmap([], generatedAt),
    highlights: {
      mostActiveMonth: null,
      mostActiveDay: null,
      longestStreakDays: 0,
      currentStreakDays: 0,
    },
    recentRuns: [],
    generatedAt,
  };
}
