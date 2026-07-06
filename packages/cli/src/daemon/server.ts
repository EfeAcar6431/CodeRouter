import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join as joinPath, relative as relativePath, resolve as resolvePath } from 'node:path';
import type { ActivityEvent, ChatMessage, Effort, LoopEvent, LoopSpec, LoopPreset, Mode, PlanPhase } from '@coderouter/core';
import { loadPlanFile, newEmptyPlanFile, parsePlanFile, PRESETS, discoverVerifiers, generateLoopSpec, openStore, resolveDbPath, sandbox, savePlanFile, validateLoopSpec } from '@coderouter/core';
import { CLI_VERSION } from '../version.js';
import { getAutoApply, getRunMode } from '../ui/setup.js';
import { handle as handleDashboard, readJson, sendJson } from '../dashboard/server.js';
import { buildExecutionEnv, executeRun } from '../runtime.js';
import { buildAllLoops, buildChatDetail, buildChatsReport, buildProjectsReport } from './data.js';
import {
  clearDaemonInfo,
  DEFAULT_DAEMON_PORT,
  writeDaemonInfo,
} from './lockfile.js';
import { handlePtyUpgrade } from './pty.js';
import { getSupervisor } from './supervisor.js';
import { assertWithinSpendingLimit } from '../spend.js';

/**
 * CodeRouter daemon ("app-server").
 *
 * A long-lived, loopback-only Node process that supervises loops (they
 * keep running after any UI closes), persists chat history, and serves a
 * JSON API + a Server-Sent-Events stream of loop events. It is a superset
 * of the dashboard: any route it doesn't own is delegated to the existing
 * dashboard handler, so usage/settings/plugins/models keep working and
 * the legacy dashboard SPA is still served at `/`.
 *
 * We use SSE (not WebSocket) for the event stream: loop events are
 * one-directional server->client, SSE needs no extra dependency, and all
 * control actions (pause/resume/stop/approve) are plain POSTs.
 */

export type DaemonHandle = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

// Live SSE clients. The supervisor broadcasts every loop event to each.
const sseClients = new Set<ServerResponse>();
let supervisorWired = false;

function wireSupervisor(): void {
  if (supervisorWired) return;
  supervisorWired = true;
  getSupervisor().subscribe((e: LoopEvent) => broadcast(e));
}

function broadcast(event: LoopEvent): void {
  broadcastRaw(event);
}

/**
 * Push an arbitrary JSON frame to every SSE client on the shared
 * `/api/loops/events` channel. Used for non-loop notifications like
 * `plan-open` (CLI -> app handoff); the app filters by `type`.
 */
function broadcastRaw(obj: unknown): void {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

/**
 * Daemon CSRF/CORS posture: loopback-bound, so we accept requests with no
 * Origin, a loopback Origin, a `null`/`file:` Origin (Electron prod), and
 * reflect the Origin for CORS so the Electron renderer (file:// or the
 * Vite dev origin) can call the API.
 */
function allowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'file:') return true;
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin && origin !== 'null' ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

export async function startDaemon(opts: { cwd: string; port?: number } = { cwd: process.cwd() }): Promise<DaemonHandle> {
  const cwd = opts.cwd;
  wireSupervisor();

  const server = createServer((req, res) => {
    applyCors(req, res);
    if ((req.method ?? 'GET') === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    handleRequest(req, res, cwd).catch((err) => {
      try {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } catch {
        // response already sent
      }
    });
  });

  // Real PTY terminal for Studio: upgrade `/api/pty` to a WebSocket and
  // relay a genuine pseudo-terminal session (see daemon/pty.ts).
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/api/pty' && allowedOrigin(req)) {
      void handlePtyUpgrade(req, socket, head, cwd);
    } else {
      socket.destroy();
    }
  });

  const port = await listen(server, opts.port ?? DEFAULT_DAEMON_PORT);
  writeDaemonInfo({ port, pid: process.pid, startedAt: Date.now(), version: CLI_VERSION });

  const cleanup = (): void => {
    clearDaemonInfo();
    killAllBackgroundProcesses();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of sseClients) c.end();
        sseClients.clear();
        clearDaemonInfo();
        killAllBackgroundProcesses();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function listen(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number, attemptsLeft: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          tryPort(p + 1, attemptsLeft - 1);
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
      server.listen(p, '127.0.0.1');
    };
    tryPort(preferred, 10);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, cwd: string): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  // ---- health / events -------------------------------------------
  if (method === 'GET' && path === '/api/health') {
    sendJson(res, 200, { ok: true, pid: process.pid, version: CLI_VERSION, port: (req.socket.localPort ?? 0), uptime: process.uptime() });
    return;
  }

  if (method === 'GET' && path === '/api/loops/events') {
    openSse(req, res);
    return;
  }

  // ---- projects / chats ------------------------------------------
  if (method === 'GET' && path === '/api/projects') {
    sendJson(res, 200, await buildProjectsReport(cwd));
    return;
  }

  if (method === 'GET' && path === '/api/chats') {
    const project = url.searchParams.get('cwd') ?? undefined;
    sendJson(res, 200, await buildChatsReport(cwd, project));
    return;
  }

  if (method === 'GET' && path === '/api/chat') {
    const project = url.searchParams.get('cwd');
    const id = url.searchParams.get('id');
    if (!project || !id) return sendJson(res, 400, { error: 'cwd and id required' });
    const detail = await buildChatDetail(project, id);
    return sendJson(res, detail ? 200 : 404, detail ?? { error: 'not found' });
  }

  // DELETE /api/chat?cwd=&id= -> permanently remove a chat and its messages.
  if (method === 'DELETE' && path === '/api/chat') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    const project = url.searchParams.get('cwd');
    const id = url.searchParams.get('id');
    if (!project || !id) return sendJson(res, 400, { error: 'cwd and id required' });
    const store = await openStore(resolveDbPath(project));
    try {
      const removed = store.chats.deleteSession(id);
      return sendJson(res, 200, { ok: true, removed });
    } finally {
      store.db.close();
    }
  }

  // POST /api/chat/send -> run one conversation turn, streaming the
  // model's answer back as SSE-style chunks. Reuses the same agent
  // execution path as the CLI so chats route, persist, and bill identically.
  if (method === 'POST' && path === '/api/chat/send') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handleChatSend(req, res, cwd);
  }

  // POST /api/exec -> run a shell command in a project dir, streaming
  // stdout/stderr back as SSE frames. Powers the Studio terminal panel.
  if (method === 'POST' && path === '/api/exec') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handleExec(req, res, cwd);
  }

  // POST /api/changes/apply -> apply a reviewed diff to the project's
  // working tree (the "Accept changes" action).
  if (method === 'POST' && path === '/api/changes/apply') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handleChangesApply(req, res, cwd);
  }

  // POST /api/changes/revert -> reverse a previously-applied diff (the
  // "Undo" action), restoring the files to their pre-change state.
  if (method === 'POST' && path === '/api/changes/revert') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handleChangesRevert(req, res, cwd);
  }

  // POST /api/open -> open a file (or its containing folder) in the
  // user's editor/IDE. Local-only convenience for the diff viewer.
  if (method === 'POST' && path === '/api/open') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handleOpen(req, res, cwd);
  }

  // GET /api/files?cwd=&dir= -> list one directory's entries (folders
  // first, then files), for the IDE-style file explorer. Lazy: the UI
  // requests each directory as the user expands it.
  if (method === 'GET' && path === '/api/files') {
    const project = url.searchParams.get('cwd') ?? cwd;
    return handleFiles(res, project, url.searchParams.get('dir') ?? '');
  }

  // GET /api/processes?cwd= -> list background processes the agent
  // started for a project that are still alive.
  if (method === 'GET' && path === '/api/processes') {
    const project = url.searchParams.get('cwd') ?? cwd;
    return sendJson(res, 200, { processes: listProcesses(project) });
  }

  // POST /api/processes/stop -> kill a tracked background process.
  if (method === 'POST' && path === '/api/processes/stop') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handleProcessStop(req, res);
  }

  // POST /api/preview -> open a (local) URL in the user's default browser.
  if (method === 'POST' && path === '/api/preview') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handlePreview(req, res);
  }

  // POST /api/preview/app -> CLI -> app handoff: broadcast a `preview-open`
  // event so a running Studio shows the URL in its built-in browser. Returns
  // `delivered` = the number of connected clients, so the CLI can fall back
  // to the OS browser when no app is listening.
  if (method === 'POST' && path === '/api/preview/app') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    const body = await readJson(req);
    const target = String(body.url ?? '').trim();
    if (!target) return sendJson(res, 400, { error: 'url required' });
    const delivered = sseClients.size;
    broadcastRaw({ type: 'preview-open', url: target, at: Date.now() });
    return sendJson(res, 200, { ok: true, delivered });
  }

  // ---- plans ------------------------------------------------------
  // GET /api/plans?cwd= -> list saved plans (.coderouter/plans/*.plan.md).
  if (method === 'GET' && path === '/api/plans') {
    const project = url.searchParams.get('cwd') ?? cwd;
    return sendJson(res, 200, { plans: await listPlans(project) });
  }

  // GET /api/plan?cwd=&id= -> load one parsed plan (frontmatter + body).
  if (method === 'GET' && path === '/api/plan') {
    const project = url.searchParams.get('cwd') ?? cwd;
    const id = url.searchParams.get('id');
    if (!id) return sendJson(res, 400, { error: 'id required' });
    const plan = await loadPlanById(project, id);
    return sendJson(res, plan ? 200 : 404, plan ?? { error: 'not found' });
  }

  // PUT /api/plan -> save an edited plan body / phases / status.
  if (method === 'PUT' && path === '/api/plan') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handlePlanSave(req, res, cwd);
  }

  // POST /api/plans/handoff -> CLI pushes a draft plan; the daemon persists
  // it (if needed) and broadcasts a `plan-open` event so a running app can
  // open it in the Plan workspace for refinement.
  if (method === 'POST' && path === '/api/plans/handoff') {
    if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handlePlanHandoff(req, res, cwd);
  }

  // ---- loops ------------------------------------------------------
  if (path === '/api/loops' || path.startsWith('/api/loops/')) {
    const handled = await handleLoops(req, res, cwd, method, path, url);
    if (handled) return;
  }

  // ---- delegate everything else to the dashboard -----------------
  await handleDashboard(req, res, cwd);
}

const VALID_MODES = new Set<Mode>(['plan', 'masterplan', 'agent', 'debug', 'review', 'orchestrate']);
const VALID_EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'max']);

// ---- background process registry --------------------------------
//
// The agent can start long-running processes (dev servers) via
// `bash(background:true)`. Those emit a `process_started` activity event;
// we record them here (keyed by pid) so the app can list them per project,
// open their URL in a browser, and stop them. The processes themselves are
// spawned detached inside the core layer, so they outlive the run - this
// registry is just metadata + a kill switch.
type ProcRecord = {
  pid: number;
  command: string;
  cwd: string;
  url?: string;
  sessionId: string;
  startedAt: number;
};
const backgroundProcesses = new Map<number, ProcRecord>();

function registerProcess(
  sessionId: string,
  cwd: string,
  ev: Extract<ActivityEvent, { kind: 'process_started' }>,
): void {
  if (!ev.pid || ev.pid <= 0) return;
  backgroundProcesses.set(ev.pid, {
    pid: ev.pid,
    command: ev.command,
    cwd: ev.cwd || cwd,
    url: ev.url,
    sessionId,
    startedAt: Date.now(),
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live processes for a project, pruning any that have since exited. */
function listProcesses(project: string): ProcRecord[] {
  const root = resolvePath(project);
  const out: ProcRecord[] = [];
  for (const [pid, rec] of backgroundProcesses) {
    if (!isAlive(pid)) {
      backgroundProcesses.delete(pid);
      continue;
    }
    if (resolvePath(rec.cwd) === root) out.push(rec);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function killProcess(pid: number): boolean {
  try {
    // execBackground spawned detached, so target the whole process group.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 2_000);
  } catch {
    backgroundProcesses.delete(pid);
    return false;
  }
  backgroundProcesses.delete(pid);
  return true;
}

/** Kill every tracked background process. Called on daemon shutdown. */
function killAllBackgroundProcesses(): void {
  for (const pid of backgroundProcesses.keys()) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  backgroundProcesses.clear();
}

async function handleProcessStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const pid = typeof body.pid === 'number' ? body.pid : Number(body.pid);
  if (!Number.isInteger(pid) || pid <= 0) return sendJson(res, 400, { error: 'valid pid required' });
  const ok = killProcess(pid);
  return sendJson(res, ok ? 200 : 422, { ok });
}

async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const raw = String(body.url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return sendJson(res, 400, { error: 'valid http(s) url required' });
  try {
    const opened = await openUrl(raw);
    return sendJson(
      res,
      opened ? 200 : 422,
      opened ? { ok: true, url: raw } : { ok: false, error: 'no opener found' },
    );
  } catch (e) {
    return sendJson(res, 422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Open a URL in the OS default browser (loopback-only convenience). */
function openUrl(target: string): Promise<boolean> {
  const trySpawn = (cmd: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.on('error', () => resolve(false));
        child.unref();
        setTimeout(() => resolve(true), 100);
      } catch {
        resolve(false);
      }
    });
  if (process.platform === 'darwin') return trySpawn('open', [target]);
  if (process.platform === 'win32') return trySpawn('cmd', ['/c', 'start', '', target]);
  return trySpawn('xdg-open', [target]);
}

/**
 * Run a single chat turn and stream the answer. We open an SSE-style
 * response (text/event-stream) and forward every adapter chunk as it
 * lands, then a terminal `done` event with the routed model + usage.
 * `executeRun` persists both the user prompt and the assistant reply to
 * the chat store, so the conversation shows up in history automatically.
 */
async function handleChatSend(req: IncomingMessage, res: ServerResponse, daemonCwd: string): Promise<void> {
  const body = await readJson(req);
  const project = String(body.cwd ?? daemonCwd);
  const prompt = String(body.prompt ?? '').trim();
  const sessionId = String(body.sessionId ?? randomUUID());
  const mode: Mode = VALID_MODES.has(body.mode as Mode) ? (body.mode as Mode) : 'agent';
  const effort: Effort | undefined = VALID_EFFORTS.has(body.effort as Effort) ? (body.effort as Effort) : undefined;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '*',
  });
  const send = (o: unknown): void => {
    try {
      res.write(`data: ${JSON.stringify(o)}\n\n`);
    } catch {
      // client gone
    }
  };

  if (!prompt) {
    send({ type: 'error', error: 'prompt required' });
    res.end();
    return;
  }

  send({ type: 'start', sessionId });
  try {
    // Prior turns give the agent multi-turn memory. Read them before the
    // run persists this turn.
    const store = await openStore(resolveDbPath(project));
    const prior = store.chats.messages(sessionId).map((m) => ({ role: m.role, content: m.text }) as ChatMessage);
    store.db.close();

    // Honor an explicit per-request override; otherwise fall back to the
    // global auto-apply preference. When false, the run keeps its edits
    // as a reviewable diff the user accepts later via /api/changes/apply.
    const apply = typeof body.apply === 'boolean' ? body.apply : getAutoApply();
    const runMode = getRunMode();

    const { output, report } = await executeRun({
      cwd: project,
      prompt,
      mode,
      effort,
      sessionId,
      apply,
      runMode,
      onChunk: (text) => send({ type: 'chunk', text }),
      onActivity: (event) => {
        send({ type: 'activity', event });
        if (event.kind === 'process_started') registerProcess(sessionId, project, event);
      },
      onUsage: (usage) => send({ type: 'usage', ...usage }),
      priorMessages: prior,
    });

    const route = (output.routes ?? [])[0];
    send({
      type: 'done',
      sessionId,
      text: output.text ?? '',
      runId: output.runId,
      route: route ? `${route.via ?? route.provider},${route.model}` : null,
      costUsd: output.costUsd,
      tokensIn: output.tokensIn,
      tokensOut: output.tokensOut,
      diff: output.diff ?? null,
      filesChanged: output.filesChanged ?? [],
      applied: apply,
      // Plan metadata (parity with the CLI REPL): lets the app open the
      // saved plan in the Plan workspace and highlight decisions to confirm.
      planId: report.planId ?? null,
      planPath: report.planPath ?? null,
      phases: report.phases ?? [],
      openQuestions: report.openQuestions ?? [],
      clarifications: report.clarifications ?? [],
      escalationHint: report.escalationHint ?? null,
      citations: report.citations ?? [],
    });
  } catch (e) {
    send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
}

/**
 * Apply a previously-produced diff to a project's working tree. Powers
 * the "Accept changes" button: a chat run that wasn't auto-applied keeps
 * its edits as a diff, and this replays that patch against the host repo.
 */
async function handleChangesApply(req: IncomingMessage, res: ServerResponse, daemonCwd: string): Promise<void> {
  const body = await readJson(req);
  const project = String(body.cwd ?? daemonCwd);
  const diff = typeof body.diff === 'string' ? body.diff : '';
  if (!diff.trim()) return sendJson(res, 400, { error: 'diff required' });
  try {
    await sandbox.applyPatchToRepo(project, diff);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Reverse a previously-applied diff, restoring the working tree. Powers
 * the "Undo" button beside "Accept": it re-applies the same patch with
 * `git apply --reverse` so accepted (or auto-applied) edits can be
 * rolled back from the UI.
 */
async function handleChangesRevert(req: IncomingMessage, res: ServerResponse, daemonCwd: string): Promise<void> {
  const body = await readJson(req);
  const project = String(body.cwd ?? daemonCwd);
  const diff = typeof body.diff === 'string' ? body.diff : '';
  if (!diff.trim()) return sendJson(res, 400, { error: 'diff required' });
  try {
    await sandbox.revertPatchFromRepo(project, diff);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// ---- plans -------------------------------------------------------

type PlanSummary = {
  id: string;
  title: string;
  status: string;
  mode: 'plan' | 'masterplan';
  route: string;
  effort: string;
  createdAt: string;
  phaseCount: number;
};

function plansDir(project: string): string {
  return joinPath(resolvePath(project), '.coderouter', 'plans');
}

/**
 * Derive a human title from a plan body: prefer a top-level `# heading`
 * (stripping a `Masterplan:` prefix), else the first line under `## Task`.
 */
function deriveTitleFromBody(body: string): string | undefined {
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1?.[1]) return h1[1].replace(/^Masterplan:\s*/i, '').trim().slice(0, 100);
  const task = /^##\s+Task\s*\n+(.+)$/m.exec(body);
  if (task?.[1]) return task[1].trim().slice(0, 100);
  return undefined;
}

async function listPlans(project: string): Promise<PlanSummary[]> {
  const dir = plansDir(project);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.plan.md'));
  } catch {
    return [];
  }
  const out: PlanSummary[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(joinPath(dir, f), 'utf8');
      const plan = parsePlanFile(raw);
      out.push({
        id: plan.frontmatter.planId,
        title: deriveTitleFromBody(plan.body) ?? plan.frontmatter.planId,
        status: plan.frontmatter.status,
        mode: plan.frontmatter.planId.startsWith('mp-') ? 'masterplan' : 'plan',
        route: plan.frontmatter.route,
        effort: plan.frontmatter.effort,
        createdAt: plan.frontmatter.createdAt,
        phaseCount: plan.frontmatter.phases.length,
      });
    } catch {
      // Skip malformed plan files rather than failing the whole listing.
    }
  }
  return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

async function loadPlanById(
  project: string,
  id: string,
): Promise<{ frontmatter: unknown; body: string; citations: unknown; title: string; path: string } | null> {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '');
  const path = joinPath(plansDir(project), `${safeId}.plan.md`);
  try {
    const plan = await loadPlanFile(path);
    return {
      frontmatter: plan.frontmatter,
      body: plan.body,
      citations: plan.citations,
      title: deriveTitleFromBody(plan.body) ?? id,
      path,
    };
  } catch {
    return null;
  }
}

async function handlePlanSave(req: IncomingMessage, res: ServerResponse, daemonCwd: string): Promise<void> {
  const body = await readJson(req);
  const project = String(body.cwd ?? daemonCwd);
  const id = String(body.id ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (!id) return sendJson(res, 400, { error: 'id required' });
  const path = joinPath(plansDir(project), `${id}.plan.md`);
  let plan;
  try {
    plan = await loadPlanFile(path);
  } catch {
    return sendJson(res, 404, { error: 'plan not found' });
  }
  if (typeof body.body === 'string') plan.body = body.body;
  if (Array.isArray(body.phases)) plan.frontmatter.phases = body.phases as PlanPhase[];
  if (typeof body.status === 'string') {
    plan.frontmatter.status = body.status as typeof plan.frontmatter.status;
  }
  try {
    const saved = await savePlanFile(project, plan);
    return sendJson(res, 200, { ok: true, path: saved });
  } catch (e) {
    return sendJson(res, 422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Create a draft plan file from raw markdown (used when a handoff arrives
 * for a plan that isn't on disk yet). Returns the plan id.
 */
async function createDraftPlan(project: string, markdown: string, planId?: string): Promise<string> {
  const id = (planId || `plan-${randomUUID().slice(0, 8)}`).replace(/[^a-zA-Z0-9._-]/g, '');
  const plan = newEmptyPlanFile({ planId: id, runId: id, route: 'draft', effort: 'medium' });
  plan.body = markdown;
  plan.frontmatter.status = 'draft';
  await savePlanFile(project, plan);
  return id;
}

async function handlePlanHandoff(req: IncomingMessage, res: ServerResponse, daemonCwd: string): Promise<void> {
  const body = await readJson(req);
  const project = String(body.cwd ?? daemonCwd);
  let planId = String(body.planId ?? '').trim();
  const draft = typeof body.body === 'string' ? body.body : '';
  try {
    if (planId) {
      const existing = await loadPlanById(project, planId);
      if (!existing) {
        if (!draft) return sendJson(res, 404, { error: 'plan not found and no body to create it' });
        planId = await createDraftPlan(project, draft, planId);
      }
    } else if (draft) {
      planId = await createDraftPlan(project, draft);
    } else {
      return sendJson(res, 400, { error: 'planId or body required' });
    }
  } catch (e) {
    return sendJson(res, 422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  // Notify any running app to open this plan for refinement.
  broadcastRaw({ type: 'plan-open', cwd: project, planId, refine: true, at: Date.now() });
  return sendJson(res, 200, { ok: true, planId });
}

/**
 * Open a path in the user's editor. Resolves `path` relative to `cwd`,
 * then tries known editor CLIs (Cursor, then VS Code) before falling
 * back to the OS "open in default app" handler. Runs locally on the
 * same machine as the daemon, so this is safe for a loopback API.
 */
async function handleOpen(req: IncomingMessage, res: ServerResponse, daemonCwd: string): Promise<void> {
  const body = await readJson(req);
  const base = String(body.cwd ?? daemonCwd);
  const rel = String(body.path ?? '').trim();
  if (!rel) return sendJson(res, 400, { error: 'path required' });
  const target = isAbsolute(rel) ? rel : resolvePath(base, rel);
  const reveal = body.reveal === true;
  try {
    const opened = await openInEditor(target, reveal);
    return sendJson(res, opened ? 200 : 422, opened ? { ok: true, path: target } : { ok: false, error: 'no opener found' });
  } catch (e) {
    return sendJson(res, 422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Directories the file explorer never descends into (noise/huge). */
const FILE_TREE_IGNORE = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '.turbo',
  '.next',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.pnpm-store',
]);

type FileEntry = { name: string; type: 'dir' | 'file'; path: string };

/**
 * List a single directory's entries for the file explorer. `dir` is
 * project-relative; we resolve it, guard against escaping the project
 * root, skip heavy/ignored folders, and return folders-first sorted
 * entries. Lazy by design — the UI fetches each level on expand.
 */
async function handleFiles(res: ServerResponse, project: string, dir: string): Promise<void> {
  const root = resolvePath(project);
  const target = resolvePath(root, dir);
  // Contain traversal to the project root.
  if (target !== root && !target.startsWith(root + '/')) {
    return sendJson(res, 400, { error: 'path escapes project root' });
  }
  try {
    const dirents = await readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (FILE_TREE_IGNORE.has(d.name)) continue;
      const isDir = d.isDirectory();
      if (!isDir && !d.isFile()) continue; // skip sockets/symlinks-to-nowhere
      const abs = joinPath(target, d.name);
      entries.push({ name: d.name, type: isDir ? 'dir' : 'file', path: relativePath(root, abs) });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return sendJson(res, 200, { root, dir, entries });
  } catch (e) {
    return sendJson(res, 404, { error: e instanceof Error ? e.message : String(e), entries: [] });
  }
}

/**
 * Best-effort "open in IDE": prefer an editor CLI on PATH (Cursor, then
 * VS Code, then $EDITOR/$VISUAL) so the file lands in the user's IDE,
 * and fall back to the platform file opener. `reveal` shows the file in
 * its folder instead of opening it. Resolves true once something starts.
 */
function openInEditor(target: string, reveal: boolean): Promise<boolean> {
  const trySpawn = (cmd: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.on('error', () => resolve(false));
        // If it didn't error almost immediately, assume it launched.
        setTimeout(() => {
          child.unref();
          resolve(true);
        }, 120);
      } catch {
        resolve(false);
      }
    });

  const platformOpen = (): Promise<boolean> => {
    if (reveal && process.platform === 'darwin') return trySpawn('open', ['-R', target]);
    if (process.platform === 'darwin') return trySpawn('open', [target]);
    if (process.platform === 'win32') return trySpawn('cmd', ['/c', 'start', '', target]);
    return trySpawn('xdg-open', [target]);
  };

  return (async () => {
    // When revealing in the folder, the OS handler is the reliable path.
    if (reveal) return platformOpen();
    const editors = ['cursor', 'code', process.env.VISUAL, process.env.EDITOR].filter(Boolean) as string[];
    for (const ed of editors) {
      if (await trySpawn(ed, [target])) return true;
    }
    return platformOpen();
  })();
}

/**
 * Run one shell command in a project directory and stream its output.
 * Each command is its own short-lived `bash -lc` (or `cmd /c`) process —
 * not a persistent PTY — so the client tracks `cwd` itself and sends it
 * with every command. Good enough for git/npm/ls/test workflows.
 */
function handleExec(req: IncomingMessage, res: ServerResponse, daemonCwd: string): void {
  void readJson(req).then((body) => {
    const command = String(body.command ?? '').trim();
    let cwd = String(body.cwd ?? daemonCwd);
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) cwd = daemonCwd;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '*',
    });
    const send = (o: unknown): void => {
      try {
        res.write(`data: ${JSON.stringify(o)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    if (!command) {
      send({ type: 'exit', code: 0, cwd });
      res.end();
      return;
    }

    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'cmd' : 'bash', isWin ? ['/c', command] : ['-lc', command], {
      cwd,
      env: process.env,
    });
    child.stdout.on('data', (d: Buffer) => send({ type: 'out', text: d.toString() }));
    child.stderr.on('data', (d: Buffer) => send({ type: 'err', text: d.toString() }));
    child.on('error', (e) => send({ type: 'err', text: `${e.message}\n` }));
    child.on('close', (code) => {
      send({ type: 'exit', code: code ?? 0, cwd });
      res.end();
    });
    req.on('close', () => {
      if (!child.killed) child.kill();
    });
  });
}

function openSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '*',
  });
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25_000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

const VALID_PRESETS = new Set<LoopPreset>(['safe', 'aggressive', 'ci-repair', 'migration']);

async function handleLoops(
  req: IncomingMessage,
  res: ServerResponse,
  daemonCwd: string,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  const sup = getSupervisor();

  // GET /api/loops?cwd= -> loops for a project, or all when cwd omitted.
  if (path === '/api/loops' && method === 'GET') {
    const project = url.searchParams.get('cwd');
    if (project) sendJson(res, 200, { loops: await sup.list(project) });
    else sendJson(res, 200, await buildAllLoops(daemonCwd));
    return true;
  }

  // GET /api/loops/presets -> preset catalog for the UI.
  if (path === '/api/loops/presets' && method === 'GET') {
    sendJson(res, 200, {
      presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description, limits: p.limits })),
    });
    return true;
  }

  // GET /api/loops/discover?cwd= -> detected verifier commands.
  if (path === '/api/loops/discover' && method === 'GET') {
    const project = url.searchParams.get('cwd') ?? daemonCwd;
    sendJson(res, 200, await discoverVerifiers(project));
    return true;
  }

  // All remaining loop routes mutate -> require an allowed origin.
  const body = method === 'GET' ? {} : await readJson(req);
  if (method !== 'GET' && !allowedOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin request rejected' });
    return true;
  }

  // POST /api/loops/generate -> generate + validate without persisting.
  if (path === '/api/loops/generate' && method === 'POST') {
    const project = String(body.cwd ?? daemonCwd);
    const request = String(body.request ?? '').trim();
    if (!request) return reply(res, 400, { error: 'request required' });
    const preset = pickPreset(body.preset);
    const { registry, router } = await buildExecutionEnv(project);
    const result = await generateLoopSpec(request, { registry, router, cwd: project }, {
      preset,
      verifierCommands: Array.isArray(body.verifierCommands) ? (body.verifierCommands as string[]) : undefined,
    });
    return reply(res, 200, {
      spec: result.spec,
      discovered: result.discovered,
      generated: result.generated,
      validation: validateLoopSpec(result.spec),
    });
  }

  // POST /api/loops -> create (generate + persist as draft).
  if (path === '/api/loops' && method === 'POST') {
    const project = String(body.cwd ?? daemonCwd);
    const request = String(body.request ?? '').trim();
    if (!request) return reply(res, 400, { error: 'request required' });
    const created = await sup.create(project, request, { preset: pickPreset(body.preset) });
    return reply(res, 200, created);
  }

  // POST /api/loops/from-spec -> persist an explicit/edited spec as draft.
  if (path === '/api/loops/from-spec' && method === 'POST') {
    const project = String(body.cwd ?? daemonCwd);
    const spec = body.spec as LoopSpec | undefined;
    if (!spec) return reply(res, 400, { error: 'spec required' });
    return reply(res, 200, await sup.createFromSpec(project, spec));
  }

  // /api/loops/:id and /api/loops/:id/:action
  const m = path.match(/^\/api\/loops\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return false;
  const loopId = m[1]!;
  const action = m[2];
  const project = String(body.cwd ?? url.searchParams.get('cwd') ?? daemonCwd);

  if (!action && method === 'GET') {
    const rec = await sup.get(project, loopId);
    return reply(res, rec ? 200 : 404, rec ?? { error: 'not found' });
  }
  if (!action && method === 'DELETE') {
    await sup.deleteLoop(project, loopId);
    return reply(res, 200, { ok: true });
  }
  if (action === 'iterations' && method === 'GET') {
    return reply(res, 200, { iterations: await sup.iterations(project, loopId) });
  }
  if (action === 'spec' && method === 'PUT') {
    const spec = body.spec as LoopSpec | undefined;
    if (!spec) return reply(res, 400, { error: 'spec required' });
    const rec = await sup.updateSpec(loopId, project, spec);
    return reply(res, rec ? 200 : 404, rec ?? { error: 'not found' });
  }
  if (method === 'POST') {
    switch (action) {
      case 'start':
        await assertWithinSpendingLimit(project);
        await sup.start(project, loopId).catch((e) => {
          throw e;
        });
        return reply(res, 200, { ok: true });
      case 'pause':
        sup.pause(loopId);
        return reply(res, 200, { ok: true });
      case 'resume':
        await assertWithinSpendingLimit(project);
        await sup.resume(project, loopId);
        return reply(res, 200, { ok: true });
      case 'stop':
        sup.stop(loopId);
        return reply(res, 200, { ok: true });
      case 'approve':
        return reply(res, 200, await sup.approve(project, loopId));
      case 'reject':
        await sup.reject(project, loopId);
        return reply(res, 200, { ok: true });
      default:
        return false;
    }
  }
  return false;
}

function pickPreset(v: unknown): LoopPreset {
  return typeof v === 'string' && VALID_PRESETS.has(v as LoopPreset) ? (v as LoopPreset) : 'safe';
}

function reply(res: ServerResponse, status: number, body: unknown): true {
  sendJson(res, status, body);
  return true;
}
