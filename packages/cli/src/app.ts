import { Command } from 'commander';
import { runReplCommand } from './commands/repl.js';
import { runOnceCommand } from './commands/once.js';
import { runModeCommand } from './commands/mode.js';
import { runMemoryCommand } from './commands/memory.js';
import { runRouteCommand } from './commands/route.js';
import { runInitCommand } from './commands/init.js';
import { runDashboardCommand } from './commands/dashboard.js';
import { runDaemonCommand } from './commands/daemon.js';
import { runLoopCommand } from './commands/loop.js';
import { runAppCommand } from './commands/app.js';
import { runMcpCommand } from './commands/mcp.js';
import { loadCredentialsIntoEnv } from './ui/setup.js';
import { BRAND_NAME } from './branding/index.js';
import { CLI_VERSION } from './version.js';

export async function runCli(argv: string[]): Promise<void> {
  // Hydrate API keys saved via the REPL's /setup wizard
  // (~/.coderouter/credentials.json) into the environment for EVERY
  // subcommand, not just the REPL. Without this, `coderouter run`
  // and the mode aliases only saw literal env vars - a user who
  // configured OpenRouter through /setup would get "no provider
  // ready" the moment they tried a non-interactive run. Real env
  // vars still win: loadCredentialsIntoEnv never overwrites a var
  // that's already set.
  loadCredentialsIntoEnv();

  const program = new Command();
  program
    .name('coderouter')
    .description(`${BRAND_NAME} - route smarter. build faster.`)
    .version(CLI_VERSION);

  // Default (no subcommand) -> REPL
  program
    .command('repl', { isDefault: true })
    .description('start interactive CodeRouter REPL')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .option('--fullscreen', 'fixed-input fullscreen renderer (alternate screen)', false)
    .action(async (opts: { cwd?: string; fullscreen?: boolean }) => {
      await runReplCommand({
        cwd: opts.cwd ?? process.cwd(),
        fullscreen: opts.fullscreen,
      });
    });

  // Top-level: run once and exit
  program
    .command('run <prompt...>')
    .description('run a single prompt non-interactively')
    .option('-m, --mode <mode>', 'plan|masterplan|agent|orchestrate|debug|review', 'agent')
    .option('-e, --effort <effort>', 'low|medium|high|max', 'medium')
    .option('--fast', 'skip classifier/context/validators', false)
    .option('--apply', 'apply diff to working tree on success', false)
    .option('-r, --route <route>', 'force a specific route (provider,model)')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .option('--json', 'emit JSON report', false)
    .action(async (promptParts: string[], opts) => {
      await runOnceCommand({ prompt: promptParts.join(' '), ...opts });
    });

  // Mode commands (aliases for `run -m <mode>`)
  for (const m of ['plan', 'masterplan', 'agent', 'orchestrate', 'debug', 'review'] as const) {
    program
      .command(`${m} [prompt...]`)
      .description(`run CodeRouter in ${m} mode`)
      .option(
        '-e, --effort <effort>',
        'low|medium|high|max',
        m === 'masterplan' || m === 'orchestrate' ? 'high' : 'medium',
      )
      .option('--fast', 'skip classifier/context/validators', false)
      .option('--apply', 'apply diff to working tree on success', false)
      .option('-c, --cwd <path>', 'working directory', process.cwd())
      .option('--json', 'emit JSON report', false)
      .action(async (promptParts: string[], opts) => {
        const prompt = (promptParts ?? []).join(' ').trim();
        await runModeCommand(m, { prompt, ...opts });
      });
  }

  program
    .command('route <prompt...>')
    .description('classify a prompt and show the chosen route (no execution)')
    .option('-e, --effort <effort>', 'low|medium|high|max', 'medium')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .option('--explain', 'show difficulty, policy, value breakdown, and runners-up', false)
    .action(async (promptParts: string[], opts) => {
      await runRouteCommand({ prompt: promptParts.join(' '), ...opts });
    });

  program
    .command('memory <action> [key]')
    .description('inspect/manage L5 persistent memory: show|forget|reset|export|import')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .action(async (action: string, key: string | undefined, opts: { cwd?: string }) => {
      await runMemoryCommand({ action, key, cwd: opts.cwd ?? process.cwd() });
    });

  program
    .command('dashboard')
    .description('open the local usage + settings dashboard in your browser')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .option('-p, --port <port>', 'preferred port', (v) => Number.parseInt(v, 10))
    .option('--no-open', "don't open the browser automatically")
    .action(async (opts: { cwd?: string; port?: number; open?: boolean }) => {
      await runDashboardCommand({
        cwd: opts.cwd ?? process.cwd(),
        port: opts.port,
        open: opts.open !== false,
      });
    });

  program
    .command('daemon')
    .description('run the persistent CodeRouter app-server (supervises loops, serves the app)')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .option('-p, --port <port>', 'preferred port', (v) => Number.parseInt(v, 10))
    .action(async (opts: { cwd?: string; port?: number }) => {
      await runDaemonCommand({ cwd: opts.cwd ?? process.cwd(), port: opts.port });
    });

  program
    .command('loop [request...]')
    .description('AI Loop Builder: describe an outcome, CodeRouter generates + runs a verified loop')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .option('--preset <preset>', 'safe|aggressive|ci-repair|migration', 'safe')
    .option('--run', 'execute the generated loop (otherwise just preview the spec)', false)
    .option('--apply', 'merge changes without an approval pause', false)
    .option('--max-iterations <n>', 'override the iteration cap', (v) => Number.parseInt(v, 10))
    .option('--json', 'emit JSON', false)
    .action(async (parts: string[], opts) => {
      await runLoopCommand({ request: (parts ?? []).join(' '), ...opts });
    });

  program
    .command('app')
    .description('launch the CodeRouter Studio desktop app (starts the daemon if needed)')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .action(async (opts: { cwd?: string }) => {
      await runAppCommand({ cwd: opts.cwd ?? process.cwd() });
    });

  program
    .command('mcp <action> [args...]')
    .description('manage external MCP servers the agent connects to: list | add | remove | add-graphify | test')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .option('-g, --global', 'apply to the global (~/.coderouter) config instead of this project', false)
    .action(async (action: string, args: string[], opts: { cwd?: string; global?: boolean }) => {
      await runMcpCommand({ action, args: args ?? [], cwd: opts.cwd ?? process.cwd(), global: opts.global });
    });

  program
    .command('init')
    .description('first-run onboarding: detect host agent, install MCP, write config')
    .option('-c, --cwd <path>', 'working directory', process.cwd())
    .action(async (opts: { cwd?: string }) => {
      await runInitCommand({ cwd: opts.cwd ?? process.cwd() });
    });

  await program.parseAsync(argv);
}
