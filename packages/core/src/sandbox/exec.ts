import { spawn } from 'node:child_process';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Optional callback invoked with every stdout chunk as it arrives.
   * The chunk is a UTF-8 string (already decoded). Used by adapters
   * that want to stream tokens to the UI rather than wait for the
   * full subprocess to exit. The final accumulated stdout is still
   * returned in the resolved ExecResult.
   */
  onStdout?: (chunk: string) => void;
  /** Same as onStdout but for stderr. */
  onStderr?: (chunk: string) => void;
};

/**
 * Promise-based subprocess wrapper. Captures stdout/stderr fully (no
 * streaming); used by sandbox/validate/adapters where command output is
 * small and structured. For streaming subprocess work, prefer the dedicated
 * adapter implementations that stream tokens.
 */
export async function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    // We don't pass `signal` straight to spawn() because Node's
    // built-in handler sends SIGTERM and then gives up - if the
    // child traps SIGTERM (the Claude Code / Codex CLIs do, to flush
    // network state on shutdown) the parent hangs waiting on it,
    // and the user's ESC keystroke produces no observable effect.
    // Instead we manage the abort ourselves: SIGTERM first, then
    // force SIGKILL after KILL_GRACE_MS so a stuck subprocess can't
    // wedge the REPL forever.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let aborted = false;
    let killEscalation: NodeJS.Timeout | null = null;

    const KILL_GRACE_MS = 2_000;
    const escalateKill = (reason: 'abort' | 'timeout') => {
      if (reason === 'abort') aborted = true;
      else killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // child already exited
      }
      // Some CLIs trap SIGTERM and try to flush state; if they
      // don't exit fast enough we force-kill. The grace window is
      // intentionally short - the REPL feels broken if ESC takes
      // 10+ seconds to take effect.
      killEscalation = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, KILL_GRACE_MS);
    };

    const timeout = opts.timeoutMs
      ? setTimeout(() => escalateKill('timeout'), opts.timeoutMs)
      : null;

    const onAbort = () => escalateKill('abort');
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stderr += s;
      opts.onStderr?.(s);
    });

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const exitCode = code ?? (signal ? 128 : -1);
      // We surface aborts as a thrown AbortError so callers can
      // unwind cleanly instead of getting a confusing exit-128 they
      // have to interpret. Timeouts continue to come back as a
      // resolved result (with the kill marker) because some callers
      // explicitly tolerate a slow subprocess up to the timeout.
      if (aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      resolve({
        stdout,
        stderr: killed ? `${stderr}\n[killed after ${opts.timeoutMs}ms]` : stderr,
        exitCode,
        durationMs: performance.now() - start,
      });
    });

    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Outcome of {@link execForeground}: either the process exited on its own
 * (we have its exit code + captured output), or it was still running when it
 * clearly turned into a long-lived process (server / watcher / GUI / game) and
 * we handed it off to the background instead of blocking the turn on it.
 */
export type ForegroundOutcome =
  | { kind: 'exited'; stdout: string; stderr: string; exitCode: number; durationMs: number }
  | { kind: 'running'; pid: number; output: string; durationMs: number };

/**
 * Run a foreground command but transparently hand it off to the background
 * once it's obviously a persistent process, so the agent turn never wedges on
 * a dev server or a `python game.py` that opens a window and loops forever.
 *
 * Resolution order:
 *  - the process exits            -> `{ kind: 'exited', exitCode, ... }`
 *  - `ready(output)` becomes true -> `{ kind: 'running', pid }` immediately
 *    (used to detach the instant we see a "Local: http://..." server banner)
 *  - the process has been alive `minRunMs` AND output has been idle `idleMs`
 *                                 -> `{ kind: 'running', pid }` (quiet loops,
 *    e.g. a game window with no console output)
 *  - `timeoutMs` elapses while still chatty -> kill + `{ kind: 'exited' }`
 *
 * On hand-off the child is detached (its own process group) and unref'd so it
 * outlives the caller, exactly like {@link execBackground}.
 */
export function execForeground(
  cmd: string,
  args: string[],
  opts: ExecOptions & {
    /** Detach after output is idle this long once eligible (default 6000ms). */
    idleMs?: number;
    /** Don't detach before the process has run at least this long (default 2500ms). */
    minRunMs?: number;
    /** Predicate on combined output; returning true detaches immediately. */
    ready?: (combined: string) => boolean;
  } = {},
): Promise<ForegroundOutcome> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let combined = '';
    let done = false;
    let killed = false;
    let aborted = false;
    let eligible = false;
    let killEscalation: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const idleMs = opts.idleMs ?? 6_000;
    const minRunMs = opts.minRunMs ?? 2_500;
    const KILL_GRACE_MS = 2_000;

    const clearTimers = (): void => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(minRunTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    const handoff = (): void => {
      if (done) return;
      done = true;
      clearTimers();
      child.unref();
      resolve({ kind: 'running', pid: child.pid ?? -1, output: combined, durationMs: performance.now() - start });
    };

    const bumpIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!eligible || done) return;
      idleTimer = setTimeout(handoff, idleMs);
    };

    const minRunTimer = setTimeout(() => {
      eligible = true;
      bumpIdle();
    }, minRunMs);

    const escalateKill = (reason: 'abort' | 'timeout'): void => {
      if (reason === 'abort') aborted = true;
      else killed = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // already exited
      }
      killEscalation = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }, KILL_GRACE_MS);
    };

    const timeout = opts.timeoutMs ? setTimeout(() => escalateKill('timeout'), opts.timeoutMs) : null;
    const onAbort = (): void => escalateKill('abort');
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const onData = (s: string, isErr: boolean): void => {
      if (isErr) stderr += s;
      else stdout += s;
      combined += s;
      (isErr ? opts.onStderr : opts.onStdout)?.(s);
      if (!done && opts.ready?.(combined)) {
        handoff();
        return;
      }
      bumpIdle();
    };
    child.stdout.on('data', (c: Buffer) => onData(c.toString('utf8'), false));
    child.stderr.on('data', (c: Buffer) => onData(c.toString('utf8'), true));

    child.on('error', (err: Error) => {
      if (done) return;
      done = true;
      clearTimers();
      reject(err);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimers();
      if (aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      const exitCode = code ?? (signal ? 128 : -1);
      resolve({
        kind: 'exited',
        stdout,
        stderr: killed ? `${stderr}\n[killed after ${opts.timeoutMs}ms]` : stderr,
        exitCode,
        durationMs: performance.now() - start,
      });
    });
  });
}

export type BackgroundHandle = {
  pid: number;
  /** Combined stdout+stderr captured so far (bounded to `maxBuffer`). */
  output: () => string;
  /** Kill the process (SIGTERM, then SIGKILL after a short grace). */
  kill: () => void;
  /** Resolves once early output settles or `settleMs` elapses. */
  settled: Promise<void>;
};

/**
 * Spawn a long-running process that OUTLIVES the caller (dev servers,
 * watchers, etc). Unlike {@link exec}, this does not await the child: it
 * returns a handle immediately with the pid and a live output buffer. The
 * child is detached so it isn't torn down when the parent tool call returns.
 *
 * `settled` resolves once the process has been quiet for `quietMs` or
 * `settleMs` has elapsed, whichever comes first - long enough to capture a
 * dev server's "Local: http://..." banner without blocking on a server that
 * never exits.
 */
export function execBackground(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    settleMs?: number;
    quietMs?: number;
    maxBuffer?: number;
  } = {},
): BackgroundHandle {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const maxBuffer = opts.maxBuffer ?? 64 * 1024;
  let buffer = '';
  const append = (s: string): void => {
    buffer += s;
    if (buffer.length > maxBuffer) buffer = buffer.slice(buffer.length - maxBuffer);
  };
  child.stdout?.on('data', (c: Buffer) => append(c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => append(c.toString('utf8')));

  const settleMs = opts.settleMs ?? 2_500;
  const quietMs = opts.quietMs ?? 700;
  const settled = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    // Resolve after a period of no output (server booted + printed banner),
    // capped by an absolute deadline so we never hang on a chatty process.
    let quietTimer: NodeJS.Timeout = setTimeout(finish, quietMs);
    const bump = (): void => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    child.stdout?.on('data', bump);
    child.stderr?.on('data', bump);
    child.on('error', finish);
    child.on('exit', finish);
    setTimeout(finish, settleMs);
  });

  const kill = (): void => {
    try {
      // Negative pid targets the whole detached process group.
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 2_000);
  };

  // Let the parent exit independently of this child.
  child.unref();

  return {
    pid: child.pid ?? -1,
    output: () => buffer,
    kill,
    settled,
  };
}

/**
 * Build a platform-appropriate shell invocation for a command string.
 *
 * POSIX uses `/bin/sh`; Windows uses the ComSpec shell (`cmd.exe`), which is
 * always present and supports `&&` chaining. Without this, spawning `/bin/sh`
 * on Windows fails with ENOENT and the agent can't run any commands at all.
 */
export function shellInvocation(
  command: string,
  opts: { login?: boolean } = {},
): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    const shell = process.env.ComSpec || 'cmd.exe';
    return { cmd: shell, args: ['/d', '/s', '/c', command] };
  }
  return { cmd: '/bin/sh', args: [opts.login ? '-lc' : '-c', command] };
}

export async function git(
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return exec('git', args, opts);
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly result: ExecResult,
    public readonly cmd: string,
    public readonly args: string[],
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export async function gitOrThrow(
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const result = await git(args, opts);
  if (result.exitCode !== 0) {
    throw new CommandError(
      `git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      result,
      'git',
      args,
    );
  }
  return result;
}
