import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coderouterHome } from '../paths.js';
import type { McpFile, McpServerConfig } from './types.js';

/** Project-scoped MCP config: `<cwd>/.coderouter/mcp.json`. */
export function projectMcpPath(cwd: string): string {
  return join(cwd, '.coderouter', 'mcp.json');
}

/** Global MCP config: `~/.coderouter/mcp.json`. */
export function globalMcpPath(): string {
  return join(coderouterHome(), 'mcp.json');
}

function readFile(path: string): McpFile {
  try {
    if (!existsSync(path)) return { servers: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpFile>;
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    // Keep only well-formed entries so a hand-edited file can't crash a run.
    return { servers: servers.filter((s) => s && typeof s.name === 'string' && typeof s.command === 'string') };
  } catch {
    return { servers: [] };
  }
}

function writeFile(path: string, file: McpFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * Effective server list for a project: global servers overlaid by project
 * servers (project wins on name collision), with `enabled === false` entries
 * dropped. Each server's `cwd` defaults to the project cwd so per-project
 * tools (graphify) read the right repo.
 */
export function loadMcpServers(cwd: string): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const s of readFile(globalMcpPath()).servers) byName.set(s.name, s);
  for (const s of readFile(projectMcpPath(cwd)).servers) byName.set(s.name, s);
  return [...byName.values()]
    .filter((s) => s.enabled !== false)
    .map((s) => ({ ...s, cwd: s.cwd ?? cwd }));
}

/** List raw entries for a scope (unmerged), for CLI display. */
export function listMcpServers(cwd: string, scope: 'project' | 'global'): McpServerConfig[] {
  return readFile(scope === 'global' ? globalMcpPath() : projectMcpPath(cwd)).servers;
}

/** Add or replace a server entry in the chosen scope. */
export function saveMcpServer(cwd: string, cfg: McpServerConfig, scope: 'project' | 'global' = 'project'): void {
  const path = scope === 'global' ? globalMcpPath() : projectMcpPath(cwd);
  const file = readFile(path);
  file.servers = [...file.servers.filter((s) => s.name !== cfg.name), cfg];
  writeFile(path, file);
}

/** Remove a server entry by name from the chosen scope. Returns true if removed. */
export function removeMcpServer(cwd: string, name: string, scope: 'project' | 'global' = 'project'): boolean {
  const path = scope === 'global' ? globalMcpPath() : projectMcpPath(cwd);
  const file = readFile(path);
  const next = file.servers.filter((s) => s.name !== name);
  const removed = next.length !== file.servers.length;
  if (removed) writeFile(path, { servers: next });
  return removed;
}

/**
 * Preset for graphify's MCP server. graphify exposes its knowledge-graph
 * tools over `graphify --mcp`; it reads the graph built for the cwd it runs
 * in (so leave `cwd` unset to inherit the project).
 */
export function graphifyPreset(): McpServerConfig {
  return { name: 'graphify', command: 'graphify', args: ['--mcp'] };
}
