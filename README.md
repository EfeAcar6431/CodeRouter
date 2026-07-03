# CodeRouter

<img width="1024" height="191" alt="CodeRouter banner" src="https://github.com/user-attachments/assets/d8eacfbd-1d65-4546-982f-16a15718e670" />

**Route smarter. Build faster.**

One coding agent that picks the right model for every task — fast, cheap models for the easy 80%, frontier models for the hard 20% — then runs each change in a safe sandbox, checks it, and learns what works on your repo. You stop choosing models. You just build.

Works with your existing **Claude Code** or **Codex** CLI, or any API key — OpenAI, Anthropic, OpenRouter, DeepSeek, Groq, or a local Ollama model.

Use it two ways: the **CLI** (`coderouter`) for the terminal, or **CodeRouter Studio**, a desktop app for everything else.

## Install

### CLI

Requires **Node 24+**.

```bash
npm install -g coderouter-cli
coderouter
```

First launch walks you through adding an API key (or auto-detects a Claude Code / Codex CLI you already have). No other setup, no extra services.

Prefer not to install globally? `npx coderouter-cli`.

### Studio (desktop app)

**Download** the latest build from the [Releases page](https://github.com/Code-Router/CodeRouter/releases):

- **macOS (Apple Silicon):** the `.dmg` — open it and drag CodeRouter Studio to Applications.
- **Windows:** the `.exe` installer — run it and CodeRouter Studio installs and launches.

> Builds aren't code‑signed yet. On macOS, right‑click the app → **Open** and confirm. On Windows, if SmartScreen appears, click **More info → Run anyway**. The app is fully self‑contained — no separate Node or CLI install required.

## Quick start

```bash
coderouter                         # interactive REPL
coderouter agent "rename getCwd"   # one-shot execution
coderouter masterplan "design an L1-L5 memory system"
coderouter debug  "tests fail in CI but pass locally"
coderouter review                  # review the current diff
coderouter route "fix typo"        # show the chosen route (no run)
```

In the REPL, type `/` for commands and `@` to reference files.

## CodeRouter Studio (desktop app)

CodeRouter Studio is a native desktop app that wraps the same router in a full UI — your projects, chats, loops, usage, and plugins in one place. It runs a persistent local daemon so background work (like loops) keeps going after you close the window.

What's inside:

- **Chat** with all five modes — Agent, Plan, Masterplan, Debug, Review — picked from a color‑coded selector. Voice‑to‑text, a project picker, and inline code diffs with **Review / Undo**.
- **Projects & Chats** — register any folder, browse your work, and open the chats that belong to each project. CLI sessions and app chats share the same store, so they show up identically in both places.
- **Loops** — describe an outcome in plain English; CodeRouter generates a verifiable loop (goal, verifier, stop condition), you approve it, and it runs and self‑corrects until the check passes.
- **Usage & Spending** — cost/usage across *all* CodeRouter work on your machine, an activity heatmap, and a spending limit (default **$50/mo**) that's actually enforced by the daemon, with a progress bar on the Overview.
- **Plugins** — install plugins, rules, skills, and subagents, or browse the marketplace.
- **Terminal** — a real, responsive shell in the bottom/side panel.
- **Light & dark themes.**

### Build Studio from source

```bash
pnpm i
pnpm --filter @coderouter/app dev       # run in development
pnpm --filter @coderouter/app package   # build a distributable (.dmg / AppImage / nsis)
```

`package` builds the renderer + Electron main, bundles the daemon into the app (so it's self‑contained), and emits an installer under `packages/app/release/`.

## Why it pays off

Most of a coding session isn't hard. Renames, boilerplate, test scaffolding, "where is X?" — none of it needs a frontier model. The expensive models only earn their price on the hard slice: deep reasoning, large refactors, architecture, taste-sensitive multi-file edits.

CodeRouter scores every prompt by its **cognitive shape** and sends it to the cheapest model that can do the job well.

- **Spend less.** Easy work goes to fast, cheap models (or local Ollama); only the hard 10–20% reaches the premium tier — often a multiple-x cut on a mixed workload versus paying frontier prices for everything.
- **Move faster.** Cheap models are also quicker, so the routine majority of your tasks finish in a fraction of the time — and CodeRouter handles fixer→reviewer handoffs on its own, so you're not babysitting.
- **Stop micromanaging.** You describe the work; CodeRouter picks the model, explains *why*, and learns what actually succeeds on your repo. Steer it any time with preferred "strong" / "cheap" models — or let the default optimize the cost/quality tradeoff for you.

## The five modes

| Mode | What it does | Writes? | Output |
|------|--------------|---------|--------|
| `plan` | Quick, Cursor-style planning | ✗ | 3-phase plan |
| `masterplan` | Research-grade, evidence-backed planning | ✗ | Cited plan (internal + external) |
| `agent` | Decisive execution in a sandbox | ✓ (worktree) | Diff + validators + report |
| `debug` | Evidence-gathering, hypothesis tree | ✗ | Root-cause writeup |
| `review` | Read-only diff / PR critique | ✗ | Structured review |

`plan` auto-upgrades to `masterplan` when it detects high-risk or architectural language. `agent` runs each change in an isolated **git worktree**, so your repo is never touched mid-run — you get a diff to apply or discard.

## Masterplan: planning you can trust

Bad code usually starts with cheap planning. `masterplan` is the heavyweight mode for high-stakes work — migrations, new subsystems, anything you'd want a senior engineer to think hard about first.

- **Evidence-backed.** Pulls internal context (your code, conventions, prior runs) *and* external evidence (docs, GitHub, the web), and cites it — grounded in how things actually work, not a confident guess.
- **Two opinions when it matters.** Runs **dual planners** (e.g. Opus + GPT‑5) in parallel and uses a judge model to surface where they *agree* (just do it) and where they *diverge* (a call you should make).
- **Straight to execution.** The output is a phased plan you can hand directly to `agent`.

## How it remembers (L1–L5)

Every run is persisted, so routing gets better on *your* repo over time.

| Layer | What it holds | Where |
|-------|---------------|-------|
| L1 | Per-task context (relevant files + git activity, token-budgeted) | in-memory |
| L2 | Project memory: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.coderouter/memory.md` | repo |
| L3 | Conversation session | SQLite, 6 h TTL |
| L4 | Structured handoff between agents | per workflow |
| L5 | Learned runs, route stats, failure patterns, overrides | `.coderouter/memory.db` |

L5 steers the router two ways: **bias toward routes that have worked** for a task type, and **avoid routes that keep failing**. Both decay over time.

## Inside Claude Code / Codex (MCP)

Run `coderouter init` to register CodeRouter as an MCP server — then your host agent can call it as a tool (`plan`, `masterplan`, `agent_run`, `route`, `validate`, `research_*`, `memory_*`, …).

Manual setup:

```jsonc
// ~/.claude.json
{ "mcpServers": { "coderouter": { "command": "coderouter-mcp" } } }
```

```toml
# ~/.codex/config.toml
[mcp_servers.coderouter]
command = "coderouter-mcp"
```

## Configuration

Optional `coderouter.config.{ts,js,json}` at the repo root:

```ts
export default {
  providers: [
    {
      name: 'openrouter',
      adapter: 'openai_compat',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: {
        'anthropic/claude-sonnet-4.5': {
          pricePer1MIn: 3, pricePer1MOut: 15, contextWindow: 200_000,
        },
      },
    },
  ],
  routes: { default: 'anthropic,claude-sonnet-4.5' },
  validators: { test: 'pnpm test', lint: 'pnpm lint', typecheck: 'pnpm typecheck' },
  workflows: { handoff: true, dualPlan: true, maxHandoffPasses: 3 },
  costCeilings: { perRun: 2.50, perDay: 25.00 },
};
```

## Development

```bash
pnpm i
pnpm build
pnpm test
```

## License

MIT
