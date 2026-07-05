import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeSchema } from './toTool.js';
import type { McpServerConfig, McpToolInfo } from './types.js';

/**
 * A thin client for one stdio MCP server. Spawns the server process, runs
 * the initialize handshake, and exposes `listTools` / `call`. Everything
 * here is best-effort: connect failures throw so the manager can skip the
 * server, and a failed tool call is surfaced as text rather than crashing
 * the agent loop.
 */
export class McpClient {
  readonly name: string;
  private client: Client | null = null;

  constructor(private readonly cfg: McpServerConfig) {
    this.name = cfg.name;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    // Inherit the parent env (so the server sees PATH, API keys graphify
    // needs, etc.), then overlay any per-server overrides.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    if (this.cfg.env) Object.assign(env, this.cfg.env);

    const transport = new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args,
      env,
      cwd: this.cfg.cwd,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'coderouter', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) throw new Error(`MCP client '${this.name}' not connected`);
    const res = await this.client.listTools();
    const allow = this.cfg.tools ? new Set(this.cfg.tools) : null;
    return (res.tools ?? [])
      .filter((t) => !allow || allow.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: normalizeSchema(t.inputSchema) }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (!this.client) throw new Error(`MCP client '${this.name}' not connected`);
    const res = await this.client.callTool({ name, arguments: args });
    const content = Array.isArray(res.content) ? (res.content as Array<Record<string, unknown>>) : [];
    const text = content
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : c.type ? `[${String(c.type)}]` : ''))
      .filter(Boolean)
      .join('\n');
    return { text: text || '(no output)', isError: Boolean(res.isError) };
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* best-effort */
    }
    this.client = null;
  }
}
