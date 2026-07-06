import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunMode } from '@coderouter/core';
import {
  HOST_DISABLE_ENV,
  detectHosts,
  type DetectedHost,
  type HostProvider,
} from './hosts.js';

/**
 * The first-class providers we surface in the `/setup` wizard. Order
 * here is the order shown in the picker.
 */
export type SetupProvider = {
  name: string;
  envVar: string;
  label: string;
  example: string;
};

export const SETUP_PROVIDERS: readonly SetupProvider[] = [
  { name: 'anthropic',  envVar: 'ANTHROPIC_API_KEY',  label: 'Anthropic',          example: 'sk-ant-...' },
  { name: 'openai',     envVar: 'OPENAI_API_KEY',     label: 'OpenAI',             example: 'sk-...' },
  { name: 'google',     envVar: 'GOOGLE_API_KEY',     label: 'Google (Gemini)',    example: 'AIza...' },
  { name: 'openrouter', envVar: 'OPENROUTER_API_KEY', label: 'OpenRouter',         example: 'sk-or-...' },
  { name: 'deepseek',   envVar: 'DEEPSEEK_API_KEY',   label: 'DeepSeek',           example: 'sk-...' },
  { name: 'groq',       envVar: 'GROQ_API_KEY',       label: 'Groq',               example: 'gsk_...' },
];

/**
 * Optional web-search API keys. These power the `web_search` tool and
 * Masterplan research with higher-quality results than the keyless
 * DuckDuckGo fallback. They are NOT required to run CodeRouter, so they
 * never count toward "configured" - they're a pure enhancement.
 */
export const SEARCH_PROVIDERS: readonly SetupProvider[] = [
  { name: 'tavily', envVar: 'TAVILY_API_KEY', label: 'Tavily',       example: 'tvly-...' },
  { name: 'brave',  envVar: 'BRAVE_API_KEY',  label: 'Brave Search', example: 'BSA...' },
];

export const CREDENTIALS_PATH = join(homedir(), '.coderouter', 'credentials.json');

type CredentialsFile = {
  providers?: Record<string, { apiKey?: string }>;
  /**
   * Per-host enable/disable flags. Missing entries default to enabled
   * so a fresh install that finds e.g. codex on PATH uses it without
   * the user having to opt in.
   */
  hosts?: Partial<Record<HostProvider, { enabled?: boolean }>>;
  /**
   * Optional spending guardrails. `monthlyUsd` caps spend per calendar
   * month; the dashboard surfaces progress against it. Stored globally
   * (not per-project) since API keys + billing are account-wide.
   */
  limits?: { monthlyUsd?: number };
  /**
   * When true, file changes produced by a chat/agent run are applied to
   * the project working tree automatically. When false (default), the run
   * keeps its edits as a reviewable diff and the user accepts them
   * explicitly from the desktop app. Stored globally like other prefs.
   */
  autoApply?: boolean;
  /**
   * How the agent executes commands and edits. Stored globally like other
   * prefs. See `RunMode`. Defaults to `unsandboxed` (Cursor-style: edits and
   * commands run in-place in the real project directory).
   */
  runMode?: RunMode;
  /**
   * Where `open_preview` shows a URL / page. When true (default), it opens
   * in CodeRouter Studio's built-in browser panel - and CLI previews are
   * routed to a running Studio instance when one is connected. When false,
   * previews open in the OS default browser instead. Stored globally.
   */
  previewInApp?: boolean;
  /**
   * User's preferred models per tier. When set, routing leans on these
   * instead of the catalog default: `strong` is used for high-effort
   * intents (deep reasoning, multi-file, huge context), `cheap` for
   * trivial / cost-sensitive ones. Each is a (provider, model) pair the
   * router resolves against the registry; an unconfigured pick is
   * silently ignored so a stale preference never blocks a run.
   */
  preferredModels?: {
    strong?: PreferredModel;
    cheap?: PreferredModel;
  };
};

export type PreferredModel = { provider: string; model: string };

/**
 * Hydrate process.env from the persisted credentials file. Safe to call
 * multiple times; existing env vars (e.g. set in the user's shell rc)
 * take precedence and are never overwritten.
 *
 * Also sets `CODEROUTER_DISABLE_<HOST>=1` for any host the user has
 * turned off; the core `ProviderRegistry.isReady` checks that flag so
 * a disabled host stops appearing as a routing candidate even though
 * its binary is still on PATH.
 *
 * Returns the env vars that ended up populated by the loader so callers
 * can show a "loaded from credentials.json" hint.
 */
export function loadCredentialsIntoEnv(): { applied: string[] } {
  const applied: string[] = [];
  let parsed: CredentialsFile;
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    parsed = JSON.parse(raw) as CredentialsFile;
  } catch {
    return { applied };
  }
  for (const p of [...SETUP_PROVIDERS, ...SEARCH_PROVIDERS]) {
    if (process.env[p.envVar]) continue;
    const key = parsed.providers?.[p.name]?.apiKey;
    if (key) {
      process.env[p.envVar] = key;
      applied.push(p.envVar);
    }
  }
  for (const [host, cfg] of Object.entries(parsed.hosts ?? {})) {
    const envName = HOST_DISABLE_ENV[host as HostProvider];
    if (!envName) continue;
    if (cfg?.enabled === false) {
      process.env[envName] = '1';
    } else {
      delete process.env[envName];
    }
  }
  return { applied };
}

/**
 * Persist a single provider's API key to the credentials file (creating
 * the file + parent dir if needed) and also set it on process.env so
 * the current REPL session can use it immediately.
 *
 * The file is written with 0600 permissions because API keys.
 */
export function saveCredential(provider: SetupProvider, apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('saveCredential: empty key');

  let existing: CredentialsFile = {};
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    existing = JSON.parse(raw) as CredentialsFile;
  } catch {
    // file doesn't exist or is malformed - rewrite from scratch
  }
  existing.providers ??= {};
  existing.providers[provider.name] = { apiKey: trimmed };

  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // permissions are best-effort (e.g. on Windows)
  }
  process.env[provider.envVar] = trimmed;
}

/**
 * Forget a previously-saved API key: remove it from credentials.json
 * *and* unset its env var so the router stops routing to that provider
 * immediately.
 *
 * Note: env vars set in the user's shell rc (outside CodeRouter) will
 * still be present after this call - we can only manage what we own.
 * The caller should surface this if `apiKey` came from the shell env
 * rather than the credentials file.
 */
export function removeCredential(provider: SetupProvider): { wasInShellEnv: boolean } {
  let existing: CredentialsFile = {};
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    existing = JSON.parse(raw) as CredentialsFile;
  } catch {
    // no credentials file - nothing to remove from disk, but we may
    // still need to drop the env var
  }
  const persistedKey = existing.providers?.[provider.name]?.apiKey;
  if (existing.providers) {
    delete existing.providers[provider.name];
    mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
    writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
    try {
      chmodSync(CREDENTIALS_PATH, 0o600);
    } catch {
      // permissions are best-effort
    }
  }

  const currentEnv = process.env[provider.envVar];
  const wasInShellEnv = Boolean(currentEnv && currentEnv !== persistedKey);
  if (!wasInShellEnv) {
    delete process.env[provider.envVar];
  }
  return { wasInShellEnv };
}

/**
 * Persist a host's enabled flag to credentials.json and mirror it on
 * `process.env.CODEROUTER_DISABLE_<HOST>` so the change takes effect
 * immediately without a REPL restart.
 */
export function setHostEnabled(provider: HostProvider, enabled: boolean): void {
  let existing: CredentialsFile = {};
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    existing = JSON.parse(raw) as CredentialsFile;
  } catch {
    // file doesn't exist or is malformed - rewrite from scratch
  }
  existing.hosts ??= {};
  existing.hosts[provider] = { enabled };

  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // permissions are best-effort (e.g. on Windows)
  }
  const envName = HOST_DISABLE_ENV[provider];
  if (enabled) delete process.env[envName];
  else process.env[envName] = '1';
}

/**
 * Default monthly spending cap (USD) enforced when the user hasn't set one.
 * CodeRouter always has a cap so runaway agent loops can't quietly burn
 * through an API budget.
 */
export const DEFAULT_MONTHLY_LIMIT_USD = 50;

/**
 * Read the persisted monthly spending limit (USD). Returns `null` when
 * unset or invalid, meaning "use the default cap".
 */
export function getSpendingLimit(): { monthlyUsd: number | null } {
  try {
    const file = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
    const v = file.limits?.monthlyUsd;
    return { monthlyUsd: typeof v === 'number' && v > 0 ? v : null };
  } catch {
    return { monthlyUsd: null };
  }
}

/**
 * Whether agent/chat file changes are applied automatically. Defaults to
 * `true` (Cursor-style): edits are written straight to the working tree and
 * can be undone afterwards. Users can opt into review-first mode by turning
 * the auto-accept setting off.
 */
export function getAutoApply(): boolean {
  try {
    const file = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
    return file.autoApply !== false;
  } catch {
    return true;
  }
}

/** Persist the auto-apply preference. */
export function setAutoApply(enabled: boolean): void {
  let existing: CredentialsFile = {};
  try {
    existing = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
  } catch {
    // file doesn't exist or is malformed - rewrite from scratch
  }
  existing.autoApply = enabled === true;
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // permissions are best-effort (e.g. on Windows)
  }
}

/**
 * Whether previews open in CodeRouter Studio's built-in browser (default)
 * or the OS default browser. A malformed/absent value defaults to `true`.
 */
export function getPreviewInApp(): boolean {
  try {
    const file = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
    return file.previewInApp !== false;
  } catch {
    return true;
  }
}

/** Persist the preview-target preference. */
export function setPreviewInApp(enabled: boolean): void {
  let existing: CredentialsFile = {};
  try {
    existing = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
  } catch {
    // file doesn't exist or is malformed - rewrite from scratch
  }
  existing.previewInApp = enabled === true;
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // permissions are best-effort (e.g. on Windows)
  }
}

const RUN_MODES: readonly RunMode[] = ['sandboxed', 'allowlist', 'unsandboxed'];

/**
 * How the agent runs commands + edits. Defaults to `unsandboxed`
 * (Cursor-style: in-place in the real project dir). A malformed/absent
 * value falls back to the default.
 */
export function getRunMode(): RunMode {
  try {
    const file = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
    return file.runMode && RUN_MODES.includes(file.runMode) ? file.runMode : 'unsandboxed';
  } catch {
    return 'unsandboxed';
  }
}

/** Persist the run-mode preference. */
export function setRunMode(mode: RunMode): void {
  const next = RUN_MODES.includes(mode) ? mode : 'unsandboxed';
  let existing: CredentialsFile = {};
  try {
    existing = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
  } catch {
    // file doesn't exist or is malformed - rewrite from scratch
  }
  existing.runMode = next;
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // permissions are best-effort (e.g. on Windows)
  }
}

/**
 * The monthly limit actually enforced: the user's value if set, else the
 * default cap. Always a positive number — there is always a cap.
 */
export function getEffectiveSpendingLimit(): number {
  const v = getSpendingLimit().monthlyUsd;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_MONTHLY_LIMIT_USD;
}

/**
 * Persist (or clear) the monthly spending limit. Passing `null` or a
 * non-positive number removes the explicit cap (falling back to the default).
 */
export function setSpendingLimit(monthlyUsd: number | null): void {
  let existing: CredentialsFile = {};
  try {
    existing = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
  } catch {
    // file doesn't exist or is malformed - rewrite from scratch
  }
  existing.limits ??= {};
  if (typeof monthlyUsd === 'number' && monthlyUsd > 0) {
    existing.limits.monthlyUsd = monthlyUsd;
  } else {
    delete existing.limits.monthlyUsd;
  }

  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // permissions are best-effort (e.g. on Windows)
  }
}

/**
 * Read the user's preferred models per tier. Missing tiers come back
 * as `null` ("let the router decide").
 */
export function getPreferredModels(): {
  strong: PreferredModel | null;
  cheap: PreferredModel | null;
} {
  try {
    const file = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
    const norm = (m: PreferredModel | undefined): PreferredModel | null =>
      m && typeof m.provider === 'string' && typeof m.model === 'string'
        ? { provider: m.provider, model: m.model }
        : null;
    return {
      strong: norm(file.preferredModels?.strong),
      cheap: norm(file.preferredModels?.cheap),
    };
  } catch {
    return { strong: null, cheap: null };
  }
}

/**
 * Persist (or clear) the preferred model for a tier. Passing `null`
 * removes the preference for that tier.
 */
export function setPreferredModel(tier: 'strong' | 'cheap', value: PreferredModel | null): void {
  let existing: CredentialsFile = {};
  try {
    existing = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as CredentialsFile;
  } catch {
    // file doesn't exist or is malformed - rewrite from scratch
  }
  existing.preferredModels ??= {};
  if (value && value.provider && value.model) {
    existing.preferredModels[tier] = { provider: value.provider, model: value.model };
  } else {
    delete existing.preferredModels[tier];
  }

  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // permissions are best-effort (e.g. on Windows)
  }
}

/**
 * What we know about the user's current provider setup at REPL
 * startup.
 *
 * - `apiKeys` -> API providers whose env var (or persisted credential)
 *   resolved to a populated `process.env[...]`.
 * - `hosts`   -> local CLIs (codex / claude / ollama) actually on PATH.
 * - `configured` -> true when *either* source has at least one entry;
 *   that's the bar for "we can route a prompt without help".
 */
export type DetectedSetup = {
  configured: boolean;
  apiKeys: string[];
  /** Names of web-search providers (tavily/brave) with a key present. */
  searchKeys: string[];
  hosts: DetectedHost[];
};

export function detectConfiguredProviders(): DetectedSetup {
  const apiKeys: string[] = [];
  for (const p of SETUP_PROVIDERS) {
    if (process.env[p.envVar]) apiKeys.push(p.name);
  }
  const searchKeys: string[] = [];
  for (const p of SEARCH_PROVIDERS) {
    if (process.env[p.envVar]) searchKeys.push(p.name);
  }
  const hosts = detectHosts();
  // Only *enabled* hosts count toward "configured" - if the user has
  // disabled every host and has no API keys, we still want the setup
  // wizard to fire on next launch. Search keys are optional and never
  // count toward "configured".
  const enabledHostCount = hosts.filter((h) => h.enabled).length;
  return {
    configured: apiKeys.length + enabledHostCount > 0,
    apiKeys,
    searchKeys,
    hosts,
  };
}
