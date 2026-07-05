import type { JsonSchema } from '../agent/types.js';

/**
 * Declarative config for one external MCP (Model Context Protocol) server
 * that CodeRouter's agent loop connects to as a *client*. Servers are
 * launched over stdio (the transport every MCP host uses today) and their
 * advertised tools are surfaced to the model as regular CodeRouter tools.
 *
 * graphify is the motivating first consumer: `{ command: 'graphify', args:
 * ['--mcp'] }` exposes its knowledge-graph query/path/explain tools.
 */
export type McpServerConfig = {
  /** Stable identifier; also namespaces the server's tools (`<name>_<tool>`). */
  name: string;
  /** Executable to spawn (e.g. 'graphify', 'npx', 'uvx'). */
  command: string;
  /** Arguments passed to the executable (e.g. ['--mcp']). */
  args?: string[];
  /** Extra environment variables, merged over the inherited process env. */
  env?: Record<string, string>;
  /**
   * Working directory for the spawned server. Defaults to the active
   * project cwd, so a per-project server (like graphify) reads that repo.
   */
  cwd?: string;
  /** Set false to keep the entry on disk but skip connecting. Default: true. */
  enabled?: boolean;
  /**
   * Optional allowlist of tool names to expose. When set, tools the server
   * advertises that aren't listed are hidden from the model.
   */
  tools?: string[];
};

/** On-disk shape of `.coderouter/mcp.json` (project) and `~/.coderouter/mcp.json` (global). */
export type McpFile = {
  servers: McpServerConfig[];
};

/** A tool as advertised by a connected MCP server, normalized for our loop. */
export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
};
