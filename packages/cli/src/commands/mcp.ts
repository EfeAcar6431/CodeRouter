import {
  graphifyPreset,
  listMcpServers,
  probeMcpServer,
  removeMcpServer,
  saveMcpServer,
  type McpServerConfig,
} from '@coderouter/core';
import { c } from '../ui/colors.js';

export type McpOpts = {
  action: string;
  args: string[];
  cwd: string;
  global?: boolean;
};

/**
 * `coderouter mcp <action>` - manage external MCP servers the agent loop
 * connects to as a client.
 *
 *   list                        show configured servers (project + global)
 *   add <name> <command> [args] register/replace a stdio server
 *   remove <name>               delete a server entry
 *   add-graphify                register graphify's `--mcp` server + verify
 *   test <name>                 connect to a configured server and list its tools
 */
export async function runMcpCommand(opts: McpOpts): Promise<void> {
  const scope: 'project' | 'global' = opts.global ? 'global' : 'project';
  switch (opts.action) {
    case 'list':
      listServers(opts.cwd);
      return;
    case 'add':
      await addServer(opts.cwd, opts.args, scope);
      return;
    case 'remove':
    case 'rm':
      removeServer(opts.cwd, opts.args[0], scope);
      return;
    case 'add-graphify':
      await addGraphify(opts.cwd, scope);
      return;
    case 'test':
      await testServer(opts.cwd, opts.args[0]);
      return;
    default:
      process.stderr.write(`unknown mcp action: ${opts.action}\n`);
      process.stderr.write('actions: list | add | remove | add-graphify | test\n');
      process.exit(2);
  }
}

function printServers(label: string, servers: McpServerConfig[]): void {
  if (servers.length === 0) {
    process.stdout.write(`  ${c.muted('(none)')}\n`);
    return;
  }
  for (const s of servers) {
    const cmd = [s.command, ...(s.args ?? [])].join(' ');
    const flags = s.enabled === false ? c.muted(' [disabled]') : '';
    process.stdout.write(`  ${c.bold(s.name)}${flags}  ${c.muted(cmd)}\n`);
  }
  void label;
}

function listServers(cwd: string): void {
  process.stdout.write(`${c.bold('project servers')} ${c.muted('(.coderouter/mcp.json)')}\n`);
  printServers('project', listMcpServers(cwd, 'project'));
  process.stdout.write(`\n${c.bold('global servers')} ${c.muted('(~/.coderouter/mcp.json)')}\n`);
  printServers('global', listMcpServers(cwd, 'global'));
  process.stdout.write(
    `\n${c.muted('these tools are exposed to the CodeRouter agent loop (OpenRouter/OpenAI/etc.).')}\n`,
  );
}

async function addServer(cwd: string, args: string[], scope: 'project' | 'global'): Promise<void> {
  const [name, command, ...rest] = args;
  if (!name || !command) {
    process.stderr.write('usage: coderouter mcp add <name> <command> [args...]\n');
    process.exit(2);
  }
  const cfg: McpServerConfig = { name, command, ...(rest.length ? { args: rest } : {}) };
  process.stdout.write(c.muted(`  probing ${name} (${[command, ...rest].join(' ')})...\n`));
  const probe = await probeMcpServer({ ...cfg, cwd });
  if (!probe.ok) {
    process.stderr.write(c.warn(`  could not connect: ${probe.error}\n`));
    process.stderr.write(c.muted('  saving anyway; fix the command and it will connect on the next run.\n'));
  } else {
    process.stdout.write(c.primary(`  connected - ${probe.tools?.length ?? 0} tool(s): ${(probe.tools ?? []).join(', ')}\n`));
  }
  saveMcpServer(cwd, cfg, scope);
  process.stdout.write(c.muted(`  saved to ${scope} config.\n`));
}

function removeServer(cwd: string, name: string | undefined, scope: 'project' | 'global'): void {
  if (!name) {
    process.stderr.write('usage: coderouter mcp remove <name>\n');
    process.exit(2);
  }
  const removed = removeMcpServer(cwd, name, scope);
  process.stdout.write(removed ? c.muted(`  removed ${name}\n`) : c.warn(`  no ${scope} server named ${name}\n`));
}

async function addGraphify(cwd: string, scope: 'project' | 'global'): Promise<void> {
  const cfg = graphifyPreset();
  process.stdout.write(c.muted('  probing graphify --mcp...\n'));
  const probe = await probeMcpServer({ ...cfg, cwd });
  if (!probe.ok) {
    process.stderr.write(c.warn(`  graphify not reachable: ${probe.error}\n`));
    process.stderr.write(
      c.muted('  install it first (pip install graphifyy) and build a graph (graphify .), then rerun.\n'),
    );
    process.stderr.write(c.muted('  saving the entry anyway so it connects once graphify is ready.\n'));
  } else {
    process.stdout.write(
      c.primary(`  graphify connected - ${probe.tools?.length ?? 0} tool(s): ${(probe.tools ?? []).join(', ')}\n`),
    );
  }
  saveMcpServer(cwd, cfg, scope);
  process.stdout.write(c.muted(`  saved graphify to ${scope} config. The agent loop will use its graph tools.\n`));
}

async function testServer(cwd: string, name: string | undefined): Promise<void> {
  if (!name) {
    process.stderr.write('usage: coderouter mcp test <name>\n');
    process.exit(2);
  }
  const all = [...listMcpServers(cwd, 'project'), ...listMcpServers(cwd, 'global')];
  const cfg = all.find((s) => s.name === name);
  if (!cfg) {
    process.stderr.write(c.warn(`  no configured server named ${name}\n`));
    process.exit(2);
  }
  process.stdout.write(c.muted(`  connecting to ${name}...\n`));
  const probe = await probeMcpServer({ ...cfg, cwd: cfg.cwd ?? cwd });
  if (probe.ok) {
    process.stdout.write(c.primary(`  ok - ${probe.tools?.length ?? 0} tool(s): ${(probe.tools ?? []).join(', ')}\n`));
  } else {
    process.stderr.write(c.warn(`  failed: ${probe.error}\n`));
    process.exit(1);
  }
}
