import type { Tool } from '../agent/types.js';
import { McpClient } from './client.js';
import { loadMcpServers } from './config.js';
import { mcpToolToTool } from './toTool.js';
import type { McpServerConfig } from './types.js';

/**
 * Process-level MCP connection manager. Connections are lazy and cached per
 * project cwd so an agent that runs many turns in a REPL/daemon reuses the
 * same server subprocesses instead of respawning each turn. When a cwd's
 * config changes (different servers) the stale connections are torn down.
 *
 * Everything is best-effort: a server that fails to connect or list tools is
 * skipped, never blocking a run.
 */
type Connected = { clients: McpClient[]; tools: Tool[] };

const byCwd = new Map<string, { key: string; conn: Promise<Connected> }>();
let exitHooked = false;

function signature(servers: McpServerConfig[]): string {
  return servers
    .map((s) => `${s.name}|${s.command}|${(s.args ?? []).join(' ')}|${s.cwd ?? ''}|${(s.tools ?? []).join(',')}`)
    .sort()
    .join(';');
}

async function connectAll(servers: McpServerConfig[]): Promise<Connected> {
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  for (const cfg of servers) {
    const client = new McpClient(cfg);
    try {
      await client.connect();
      for (const info of await client.listTools()) tools.push(mcpToolToTool(client, info));
      clients.push(client);
    } catch {
      await client.close();
    }
  }
  return { clients, tools };
}

function dropStale(cwd: string): void {
  const stale = byCwd.get(cwd);
  if (!stale) return;
  byCwd.delete(cwd);
  void stale.conn.then((c) => c.clients.forEach((x) => void x.close())).catch(() => {});
}

/**
 * Connect (or reuse) the MCP servers configured for `cwd` and return their
 * advertised tools adapted to CodeRouter's `Tool` interface. Returns `[]`
 * quickly when nothing is configured, so there is zero overhead by default.
 */
export async function getMcpToolsForCwd(cwd: string): Promise<Tool[]> {
  const servers = loadMcpServers(cwd);
  if (servers.length === 0) {
    dropStale(cwd);
    return [];
  }
  const key = signature(servers);
  const existing = byCwd.get(cwd);
  if (existing && existing.key === key) {
    try {
      return (await existing.conn).tools;
    } catch {
      byCwd.delete(cwd);
    }
  } else if (existing) {
    dropStale(cwd);
  }
  const conn = connectAll(servers);
  byCwd.set(cwd, { key, conn });
  ensureExitHook();
  try {
    return (await conn).tools;
  } catch {
    byCwd.delete(cwd);
    return [];
  }
}

/** Close every cached MCP connection (subprocess teardown). */
export async function disposeAllMcp(): Promise<void> {
  const entries = [...byCwd.values()];
  byCwd.clear();
  await Promise.all(
    entries.map(async (e) => {
      try {
        const c = await e.conn;
        await Promise.all(c.clients.map((x) => x.close()));
      } catch {
        /* best-effort */
      }
    }),
  );
}

/**
 * One-shot connectivity check for a single server config (used by the CLI to
 * verify a server before saving it). Connects, lists tools, then closes.
 */
export async function probeMcpServer(cfg: McpServerConfig): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  const client = new McpClient({ ...cfg, cwd: cfg.cwd });
  try {
    await client.connect();
    const tools = (await client.listTools()).map((t) => t.name);
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    await client.close();
  }
}

function ensureExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  // Only hook beforeExit so we don't interfere with the app's own SIGINT
  // handling. Stdio MCP servers also exit on their own when our end of the
  // pipe closes, so orphaned subprocesses aren't a concern on hard kills.
  process.once('beforeExit', () => void disposeAllMcp());
}
