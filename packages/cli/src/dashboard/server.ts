/**
 * Local dashboard HTTP server.
 *
 * Dependency-free (node:http). Binds to loopback only and serves the
 * inlined SPA plus a small JSON API backed by `data.ts`. Mutating
 * endpoints write the global credentials file, so they're guarded with
 * a same-origin check to block drive-by CSRF from a page the user might
 * have open in the same browser.
 */

import { statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  removeCredential,
  saveCredential,
  setAutoApply,
  setHostEnabled,
  setPreferredModel,
  setPreviewInApp,
  setRunMode,
  setSpendingLimit,
  SEARCH_PROVIDERS,
  SETUP_PROVIDERS,
} from '../ui/setup.js';
import type { HostProvider } from '../ui/hosts.js';
import { customize, plugins, type RunMode } from '@coderouter/core';
import { INDEX_HTML } from './assets.js';
import {
  buildAssetsReport,
  buildOpenRouterCatalog,
  buildPluginPreview,
  buildPluginsReport,
  buildSettingsReport,
  buildUsageReport,
} from './data.js';

export type DashboardServer = {
  server: Server;
  url: string;
  port: number;
  close: () => Promise<void>;
};

export type StartOptions = {
  cwd: string;
  /** Preferred port; falls through to the next free port on conflict. */
  port?: number;
  host?: string;
};

const PORT_ATTEMPTS = 12;

export async function startDashboardServer(opts: StartOptions): Promise<DashboardServer> {
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    handle(req, res, opts.cwd).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  // The dashboard is a background helper for an interactive REPL: it must
  // never keep the Node event loop alive on its own. Without this, a single
  // Ctrl+C (which Ink delivers as a keystroke, not a signal) tears down the
  // UI but the listening socket + any browser keep-alive connections leave
  // the process hanging until a *second* Ctrl+C lands as a real SIGINT.
  // Unref'ing the server handle and every connection socket lets the
  // process exit as soon as the REPL's own handles are gone.
  server.on('connection', (socket) => socket.unref());

  const port = await listen(server, host, opts.port ?? 4319);
  server.unref();
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return {
    server,
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-close keep-alive connections so close() resolves promptly
        // instead of waiting for browsers to drop their sockets.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Try preferred port, then increment until one is free. */
function listen(server: Server, host: string, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < PORT_ATTEMPTS) {
          attempt += 1;
          tryPort(p + 1);
        } else {
          reject(err);
        }
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    tryPort(preferred);
  });
}

export async function handle(req: IncomingMessage, res: ServerResponse, cwd: string): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
    return;
  }

  if (method === 'GET' && path === '/api/usage') {
    sendJson(res, 200, await buildUsageReport(cwd));
    return;
  }

  if (method === 'GET' && path === '/api/settings') {
    sendJson(res, 200, buildSettingsReport(cwd));
    return;
  }

  if (method === 'GET' && path === '/api/openrouter-models') {
    sendJson(res, 200, await buildOpenRouterCatalog());
    return;
  }

  if (method === 'GET' && path === '/api/assets') {
    sendJson(res, 200, await buildAssetsReport(projectCwd(url.searchParams.get('cwd'), cwd)));
    return;
  }

  // Mutating customization endpoints (rules / skills / subagents).
  if (path.startsWith('/api/assets/')) {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    const body = await readJson(req);
    const scope = body.scope === 'global' ? 'global' : 'project';
    const handled = await handleAssetMutation(res, projectCwd(body.cwd, cwd), path, method, scope, body);
    if (handled) return;
  }

  if (method === 'GET' && path === '/api/plugins') {
    sendJson(res, 200, await buildPluginsReport(projectCwd(url.searchParams.get('cwd'), cwd)));
    return;
  }

  if (method === 'GET' && path === '/api/plugins/preview') {
    const id = url.searchParams.get('id') ?? '';
    const marketplace = url.searchParams.get('marketplace') ?? undefined;
    if (!id) {
      sendJson(res, 400, { error: 'id required' });
      return;
    }
    sendJson(res, 200, await buildPluginPreview(id, marketplace));
    return;
  }

  // Plugin install / uninstall / marketplace management — mutates disk.
  if (path.startsWith('/api/plugins/')) {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    const body = await readJson(req);
    const scope = body.scope === 'global' ? 'global' : 'project';
    const handled = await handlePluginMutation(res, projectCwd(body.cwd, cwd), path, method, scope, body);
    if (handled) return;
  }

  // Everything below mutates global state — require same-origin.
  if (path.startsWith('/api/settings/')) {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    const body = await readJson(req);

    if (path === '/api/settings/key' && method === 'POST') {
      const provider = findCredentialProvider(body.name);
      if (!provider) return sendJson(res, 400, { error: `unknown provider: ${body.name}` });
      if (typeof body.apiKey !== 'string' || !body.apiKey.trim())
        return sendJson(res, 400, { error: 'apiKey required' });
      saveCredential(provider, body.apiKey);
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/settings/key' && method === 'DELETE') {
      const provider = findCredentialProvider(body.name);
      if (!provider) return sendJson(res, 400, { error: `unknown provider: ${body.name}` });
      const out = removeCredential(provider);
      return sendJson(res, 200, { ok: true, ...out });
    }

    if (path === '/api/settings/host' && method === 'POST') {
      const valid: HostProvider[] = ['codex', 'claude_code', 'ollama'];
      if (typeof body.provider !== 'string' || !valid.includes(body.provider as HostProvider))
        return sendJson(res, 400, { error: `unknown host: ${String(body.provider)}` });
      setHostEnabled(body.provider as HostProvider, Boolean(body.enabled));
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/settings/limit' && method === 'POST') {
      const raw = body.monthlyUsd;
      if (raw !== null && raw !== undefined && typeof raw !== 'number')
        return sendJson(res, 400, { error: 'monthlyUsd must be a number or null' });
      const limit = typeof raw === 'number' && raw > 0 ? raw : null;
      setSpendingLimit(limit);
      return sendJson(res, 200, { ok: true, monthlyUsd: limit });
    }

    if (path === '/api/settings/auto-apply' && method === 'POST') {
      if (typeof body.enabled !== 'boolean')
        return sendJson(res, 400, { error: 'enabled must be a boolean' });
      setAutoApply(body.enabled);
      return sendJson(res, 200, { ok: true, autoApply: body.enabled });
    }

    if (path === '/api/settings/run-mode' && method === 'POST') {
      const valid: RunMode[] = ['sandboxed', 'allowlist', 'unsandboxed'];
      if (typeof body.runMode !== 'string' || !valid.includes(body.runMode as RunMode))
        return sendJson(res, 400, { error: "runMode must be 'sandboxed', 'allowlist', or 'unsandboxed'" });
      setRunMode(body.runMode as RunMode);
      return sendJson(res, 200, { ok: true, runMode: body.runMode });
    }

    if (path === '/api/settings/preview-in-app' && method === 'POST') {
      if (typeof body.enabled !== 'boolean')
        return sendJson(res, 400, { error: 'enabled must be a boolean' });
      setPreviewInApp(body.enabled);
      return sendJson(res, 200, { ok: true, previewInApp: body.enabled });
    }

    if (path === '/api/settings/preferred-model' && method === 'POST') {
      if (body.tier !== 'strong' && body.tier !== 'cheap')
        return sendJson(res, 400, { error: "tier must be 'strong' or 'cheap'" });
      // Empty / null provider+model clears the preference for that tier.
      if (!body.provider || !body.model) {
        setPreferredModel(body.tier, null);
        return sendJson(res, 200, { ok: true, cleared: true });
      }
      if (typeof body.provider !== 'string' || typeof body.model !== 'string')
        return sendJson(res, 400, { error: 'provider and model must be strings' });
      setPreferredModel(body.tier, { provider: body.provider, model: body.model });
      return sendJson(res, 200, { ok: true });
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

/**
 * Resolve the project directory for an asset/plugin operation. The desktop
 * app passes the user's selected project; fall back to the daemon's own cwd
 * when it's missing or not an existing directory (e.g. global-scope ops).
 */
function projectCwd(candidate: unknown, fallback: string): string {
  if (typeof candidate === 'string' && candidate.trim()) {
    const c = candidate.trim();
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* not a real dir; fall through */
    }
  }
  return fallback;
}

/** Look up a provider by name across cloud + web-search credential lists. */
function findCredentialProvider(name: unknown) {
  return [...SETUP_PROVIDERS, ...SEARCH_PROVIDERS].find((p) => p.name === name);
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

/**
 * CRUD for rules / skills / subagents. Returns true when it handled the
 * request (success or a validation error response), false when the path
 * didn't match any asset route so the caller can fall through to 404.
 */
async function handleAssetMutation(
  res: ServerResponse,
  cwd: string,
  path: string,
  method: string,
  scope: 'project' | 'global',
  body: Record<string, unknown>,
): Promise<boolean> {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean)
      : str(v)
        ? str(v).split(',').map((s) => s.trim()).filter(Boolean)
        : [];

  if (path === '/api/assets/rule') {
    if (method === 'POST') {
      const id = str(body.id) || str(body.description);
      if (!id) return sendJson(res, 400, { error: 'id or description required' }), true;
      if (!str(body.body)) return sendJson(res, 400, { error: 'body required' }), true;
      const rule = await customize.writeRule(cwd, {
        scope,
        id,
        description: str(body.description),
        globs: arr(body.globs),
        alwaysApply: Boolean(body.alwaysApply),
        body: String(body.body),
      });
      return sendJson(res, 200, { ok: true, rule }), true;
    }
    if (method === 'DELETE') {
      if (!str(body.id)) return sendJson(res, 400, { error: 'id required' }), true;
      await customize.deleteRule(cwd, scope, str(body.id));
      return sendJson(res, 200, { ok: true }), true;
    }
  }

  if (path === '/api/assets/skill') {
    if (method === 'POST') {
      if (!str(body.name)) return sendJson(res, 400, { error: 'name required' }), true;
      if (!str(body.body)) return sendJson(res, 400, { error: 'body required' }), true;
      const skill = await customize.writeSkill(cwd, {
        scope,
        name: str(body.name),
        description: str(body.description),
        body: String(body.body),
        slug: str(body.slug) || undefined,
      });
      return sendJson(res, 200, { ok: true, skill }), true;
    }
    if (method === 'DELETE') {
      if (!str(body.slug)) return sendJson(res, 400, { error: 'slug required' }), true;
      await customize.deleteSkill(cwd, scope, str(body.slug));
      return sendJson(res, 200, { ok: true }), true;
    }
  }

  if (path === '/api/assets/subagent') {
    if (method === 'POST') {
      if (!str(body.name)) return sendJson(res, 400, { error: 'name required' }), true;
      if (!str(body.body)) return sendJson(res, 400, { error: 'body required' }), true;
      const effort = VALID_EFFORTS.has(str(body.effort)) ? (str(body.effort) as never) : undefined;
      const subagent = await customize.writeSubagent(cwd, {
        scope,
        name: str(body.name),
        description: str(body.description),
        kind: str(body.kind) || undefined,
        provider: str(body.provider) || undefined,
        model: str(body.model) || undefined,
        effort,
        body: String(body.body),
        slug: str(body.slug) || undefined,
      });
      return sendJson(res, 200, { ok: true, subagent }), true;
    }
    if (method === 'DELETE') {
      if (!str(body.slug)) return sendJson(res, 400, { error: 'slug required' }), true;
      await customize.deleteSubagent(cwd, scope, str(body.slug));
      return sendJson(res, 200, { ok: true }), true;
    }
  }

  return false;
}

/**
 * Plugin + marketplace mutations:
 *  - POST /api/plugins/install   { id, marketplace?, scope } -> resolve + install
 *  - POST /api/plugins/uninstall { id, scope }
 *  - POST /api/plugins/refresh   -> re-pull marketplaces, return report
 *  - POST /api/plugins/marketplace   { repo, name? } -> add
 *  - DELETE /api/plugins/marketplace { name } -> remove (user-added only)
 */
async function handlePluginMutation(
  res: ServerResponse,
  cwd: string,
  path: string,
  method: string,
  scope: 'project' | 'global',
  body: Record<string, unknown>,
): Promise<boolean> {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  if (path === '/api/plugins/install' && method === 'POST') {
    const id = str(body.id);
    const marketplace = str(body.marketplace) || undefined;
    if (!id) {
      sendJson(res, 400, { error: 'id required' });
      return true;
    }
    try {
      const plugin = await plugins.findPlugin(id, marketplace);
      if (!plugin) {
        sendJson(res, 404, { error: `plugin not found: ${id}` });
        return true;
      }
      const resolved = await plugins.resolvePlugin(plugin);
      const record = await plugins.installPlugin(cwd, resolved, scope);
      sendJson(res, 200, { ok: true, installed: record, skipped: resolved.skipped });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  if (path === '/api/plugins/uninstall' && method === 'POST') {
    const id = str(body.id);
    if (!id) {
      sendJson(res, 400, { error: 'id required' });
      return true;
    }
    const removed = await plugins.uninstallPlugin(cwd, id, scope);
    sendJson(res, 200, { ok: true, removed });
    return true;
  }

  if (path === '/api/plugins/refresh' && method === 'POST') {
    sendJson(res, 200, await buildPluginsReport(cwd, { refresh: true }));
    return true;
  }

  if (path === '/api/plugins/marketplace' && method === 'POST') {
    const repo = str(body.repo);
    if (!repo) {
      sendJson(res, 400, { error: 'repo required' });
      return true;
    }
    try {
      const mp = await plugins.addMarketplace(repo, str(body.name) || undefined);
      sendJson(res, 200, { ok: true, marketplace: mp });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  if (path === '/api/plugins/marketplace' && method === 'DELETE') {
    const name = str(body.name);
    if (!name) {
      sendJson(res, 400, { error: 'name required' });
      return true;
    }
    const removed = await plugins.removeMarketplace(name);
    sendJson(res, 200, { ok: true, removed });
    return true;
  }

  return false;
}

/**
 * Accept requests with no Origin (curl, same-tab fetch in some browsers)
 * or an Origin whose host is loopback. Rejects a foreign site POSTing to
 * our port behind the user's back.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}
