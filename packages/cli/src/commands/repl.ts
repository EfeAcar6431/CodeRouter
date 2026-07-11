import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Mode } from '@coderouter/core';
import { executeRun } from '../runtime.js';
import { renderBanner, renderPromptPrefix } from '../ui/banner.js';
import { c } from '../ui/colors.js';
import { printReport } from '../ui/report.js';
import { askForRating } from '../ui/rating.js';
import { runInkRepl } from '../ui/repl-app.js';

export type ReplOpts = {
  cwd: string;
  initialMode?: Mode;
  /** Start in the alternate-screen fullscreen renderer (fixed input). */
  fullscreen?: boolean;
};

/**
 * Entry point for the interactive REPL.
 *
 * Routes to the Ink-based TUI when stdin/stdout are both TTYs (the
 * normal interactive case) and to a line-based readline loop for
 * piped/non-TTY stdin (CI, `echo … | coderouter`).
 */
export async function runReplCommand(opts: ReplOpts): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY && !process.env.CODEROUTER_NO_TUI) {
    const fullscreen = opts.fullscreen || process.env.CODEROUTER_FULLSCREEN === '1';
    await runInkRepl({ cwd: opts.cwd, initialMode: opts.initialMode, fullscreen });
    return;
  }
  await runReadlineRepl(opts);
}

/**
 * Line-based fallback REPL. Slash commands match the Ink UI 1:1; see
 * {@link COMMANDS} in `ui/repl-app.tsx`.
 */
async function runReadlineRepl(opts: ReplOpts): Promise<void> {
  process.stdout.write(renderBanner());
  process.stdout.write(`  ${c.muted('type /help for commands, /exit to quit')}\n\n`);

  let mode: Mode = opts.initialMode ?? 'agent';
  let effort = mode === 'masterplan' ? ('high' as const) : ('medium' as const);
  let apply = false;
  let fast = false;

  const rl = createInterface({ input, output });
  rl.setPrompt(`${renderPromptPrefix()}${c.muted(`(${mode})`)} `);

  // Use line-based REPL to keep terminal handling simple and to allow
  // piped stdin in CI.
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      rl.setPrompt(`${renderPromptPrefix()}${c.muted(`(${mode})`)} `);
      rl.prompt();
      continue;
    }

    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(' ');
      const arg = rest.join(' ').trim();
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help') {
        process.stdout.write(helpText());
      } else if (cmd === 'clear') {
        process.stdout.write('\x1b[2J\x1b[H');
      } else if (cmd === 'effort') {
        if (['low', 'medium', 'high', 'max'].includes(arg)) {
          effort = arg as typeof effort;
          process.stdout.write(c.muted(`  effort set to ${effort}\n`));
        } else {
          process.stdout.write(c.warn('  usage: /effort low|medium|high|max\n'));
        }
      } else if (cmd === 'apply') {
        apply = !apply;
        process.stdout.write(c.muted(`  apply ${apply ? 'on' : 'off'}\n`));
      } else if (cmd === 'fast') {
        fast = !fast;
        process.stdout.write(c.muted(`  fast ${fast ? 'on' : 'off'}\n`));
      } else if (['plan', 'masterplan', 'agent', 'debug', 'review'].includes(cmd ?? '')) {
        mode = cmd as Mode;
        if (mode === 'masterplan' && effort === 'medium') effort = 'high';
        if (arg) await dispatch(arg, mode, effort, apply, fast, opts.cwd);
        else process.stdout.write(c.muted(`  mode set to ${mode}\n`));
      } else if (cmd === 'route') {
        process.stdout.write(c.muted('  use `coderouter route <prompt>` (not yet wired into REPL)\n'));
      } else {
        process.stdout.write(c.warn(`  unknown command: /${cmd}\n`));
      }
    } else {
      await dispatch(line, mode, effort, apply, fast, opts.cwd);
    }

    rl.setPrompt(`${renderPromptPrefix()}${c.muted(`(${mode})`)} `);
    rl.prompt();
  }
  rl.close();
  process.stdout.write(c.muted('bye.\n'));
}

async function dispatch(
  prompt: string,
  mode: Mode,
  effort: 'low' | 'medium' | 'high' | 'max',
  apply: boolean,
  fast: boolean,
  cwd: string,
): Promise<void> {
  const { report, output, store } = await executeRun({
    prompt,
    cwd,
    mode,
    effort,
    apply,
    fast,
  });
  printReport(report, { json: false });
  if (mode === 'agent' && output.status === 'success') {
    const r = await askForRating();
    if (r !== 0) {
      try {
        store.runs.setRating(output.runId, r);
      } catch {
        // ignore
      }
    }
  }
  try {
    store.db.close();
  } catch {
    // ignore
  }
}

function helpText(): string {
  return [
    c.bold('commands:'),
    '  /plan <prompt>        quick planning (Cursor-style)',
    '  /masterplan <prompt>  6-phase research-grade plan',
    '  /agent <prompt>       decisive execution',
    '  /debug <prompt>       investigation + hypothesis tree',
    '  /review               review the current diff',
    '  /effort low|medium|high|max',
    '  /apply                toggle: apply diff on success',
    '  /fast                 toggle: skip classifier/context',
    '  /clear, /help, /exit',
    '',
  ]
    .map((s) => `  ${s}\n`)
    .join('');
}
