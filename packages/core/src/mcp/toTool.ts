import type { JsonSchema, JsonSchemaProp, Tool } from '../agent/types.js';
import type { McpClient } from './client.js';
import type { McpToolInfo } from './types.js';

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function normalizeProp(raw: unknown): JsonSchemaProp {
  const r = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const t = typeof r.type === 'string' && ALLOWED_TYPES.has(r.type) ? (r.type as JsonSchemaProp['type']) : 'string';
  const prop: JsonSchemaProp = { type: t };
  if (typeof r.description === 'string') prop.description = r.description;
  if (Array.isArray(r.enum)) prop.enum = r.enum.filter((e): e is string => typeof e === 'string');
  if (t === 'array' && r.items) prop.items = normalizeProp(r.items);
  if (t === 'object' && r.properties && typeof r.properties === 'object') {
    prop.properties = normalizeProps(r.properties as Record<string, unknown>);
    if (Array.isArray(r.required)) prop.required = r.required.filter((x): x is string => typeof x === 'string');
  }
  if ('default' in r) prop.default = r.default;
  return prop;
}

function normalizeProps(props: Record<string, unknown>): Record<string, JsonSchemaProp> {
  const out: Record<string, JsonSchemaProp> = {};
  for (const [k, v] of Object.entries(props)) out[k] = normalizeProp(v);
  return out;
}

/**
 * Coerce an MCP server's `inputSchema` (arbitrary JSON Schema) into the
 * bounded shape our transport advertises to the model. Unknown types fall
 * back to string and unsupported keywords are dropped, so a quirky schema
 * can never crash the loop.
 */
export function normalizeSchema(input: unknown): JsonSchema {
  const r = (input && typeof input === 'object' ? (input as Record<string, unknown>) : {}) as Record<string, unknown>;
  const properties =
    r.properties && typeof r.properties === 'object' ? normalizeProps(r.properties as Record<string, unknown>) : {};
  const required = Array.isArray(r.required) ? r.required.filter((x): x is string => typeof x === 'string') : undefined;
  return { type: 'object', properties, ...(required && required.length ? { required } : {}) };
}

/** snake/kebab-safe tool id, namespaced by server so two servers can't collide. */
export function mcpToolName(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Adapt one advertised MCP tool into a CodeRouter `Tool`. Calls are
 * forwarded to the connected client; text content is returned to the model
 * and `isError` maps to `ok: false`.
 */
export function mcpToolToTool(client: McpClient, info: McpToolInfo): Tool {
  const name = mcpToolName(client.name, info.name);
  const description = `[mcp:${client.name}] ${info.description ?? info.name}`.trim();
  return {
    name,
    description,
    parameters: info.inputSchema,
    describe: () => `${client.name} · ${info.name}`,
    run: async (args) => {
      try {
        const { text, isError } = await client.call(info.name, args);
        return { body: text, ok: !isError };
      } catch (err) {
        return { body: `MCP tool '${client.name}:${info.name}' failed: ${(err as Error).message}`, ok: false };
      }
    },
  };
}
