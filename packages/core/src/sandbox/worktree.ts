import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandError, exec, git, gitOrThrow } from './exec.js';

export type WorktreeOptions = {
  /** Absolute path of the source repo. */
  repoPath: string;
  /** Base ref to fork from. Defaults to HEAD. */
  baseRef?: string;
  /** Optional prefix for the worktree directory. */
  prefix?: string;
  /** Optional explicit branch name. Defaults to `cr/<runId>`. */
  branch?: string;
  /** Optional runId used for branch/dir naming. Defaults to a random uuid. */
  runId?: string;
  /** Where to put the worktree. Defaults to a tmpdir. */
  parentDir?: string;
};

export type Worktree = {
  runId: string;
  branch: string;
  path: string;
  baseRef: string;
  baseSha: string;
  repoPath: string;
  createdAt: number;
};

export type WorktreeMetrics = {
  filesChanged: number;
  insertions: number;
  deletions: number;
};

/**
 * Bootstrap a working git repo at `repoPath` if one isn't already
 * present. CodeRouter's sandboxing depends on `git worktree`, which
 * is only available inside a real repo - so first-time runs in
 * brand-new project dirs (Claude Code-style "just point it at any
 * folder") need a one-shot `git init` + empty initial commit so we
 * have a HEAD to fork worktrees off.
 *
 * Auto-init is opt-in via the `autoInit` flag. The caller (REPL,
 * CLI runtime) decides whether to flip it - typically true once
 * the user has trusted the directory, false in unattended/CI runs
 * where silently writing a `.git/` would be surprising.
 *
 * Existing files are NOT staged or committed - they remain
 * untracked, exactly as they were. The empty initial commit just
 * gives us a HEAD; CodeRouter's worktree-mirroring step
 * (`mirrorHostState`) already handles untracked files for the
 * agent's view of state.
 *
 * Returns `{ created }` so the caller can surface a one-time hint
 * to the user ("CodeRouter initialized git for this directory").
 * Throws if `autoInit` is false and the dir isn't a repo, with an
 * actionable message.
 */
export async function ensureGitRepo(
  repoPath: string,
  opts: { autoInit?: boolean } = {},
): Promise<{ created: boolean }> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
  if (inside.exitCode === 0 && inside.stdout.trim() === 'true') {
    return { created: false };
  }
  if (!opts.autoInit) {
    throw new Error(
      `${repoPath} is not a git repository. CodeRouter sandboxes agent runs in a git worktree, ` +
        `so the target directory needs to be a git repo. Either run \`git init\` here yourself, ` +
        `or re-run CodeRouter with auto-init enabled to do it for you.`,
    );
  }
  // git init + an empty initial commit. Empty so we don't sweep all
  // pre-existing files into "tracked" status without the user's
  // consent - they stay untracked, exactly as before.
  await gitOrThrow(['init', '-q', '--initial-branch=main'], { cwd: repoPath });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'CodeRouter',
    GIT_AUTHOR_EMAIL: 'noreply@coderouter.dev',
    GIT_COMMITTER_NAME: 'CodeRouter',
    GIT_COMMITTER_EMAIL: 'noreply@coderouter.dev',
  };
  await gitOrThrow(
    ['commit', '-q', '--allow-empty', '-m', 'CodeRouter: bootstrap commit'],
    { cwd: repoPath, env },
  );
  return { created: true };
}

/**
 * Creates a fresh git worktree forked from `baseRef` of `repoPath`. The
 * worktree lives in a tmpdir by default; the caller owns its lifecycle and
 * must call `destroyWorktree` (or `mergeWorktree`) when done.
 *
 * This is the foundation of CodeRouter's run-isolation contract: every
 * agent invocation operates inside its own worktree, so we can read the
 * diff, decide whether to keep it, and abandon failed runs without
 * polluting the user's working copy.
 */
export async function createWorktree(opts: WorktreeOptions): Promise<Worktree> {
  const repoPath = opts.repoPath;

  // Validate the source path is a git repo.
  const insideCheck = await git(['rev-parse', '--is-inside-work-tree'], {
    cwd: repoPath,
  });
  if (insideCheck.exitCode !== 0 || insideCheck.stdout.trim() !== 'true') {
    throw new Error(`createWorktree: ${repoPath} is not a git working tree`);
  }

  const runId = opts.runId ?? randomUUID().slice(0, 8);
  const branch = opts.branch ?? `cr/${runId}`;

  const baseRef = opts.baseRef ?? 'HEAD';
  const baseShaRes = await gitOrThrow(['rev-parse', baseRef], { cwd: repoPath });
  let baseSha = baseShaRes.stdout.trim();

  // Always place worktrees in a tmpdir under our prefix; this keeps them
  // outside the repo (avoiding stray nested .git folders) and easy to GC.
  const parent = opts.parentDir ?? (await mkdtemp(join(tmpdir(), 'coderouter-')));
  await mkdir(parent, { recursive: true });
  const wtPath = join(parent, `${opts.prefix ?? 'wt'}-${runId}`);

  // `git worktree add -b <branch> <path> <baseSha>` creates a new branch
  // forked at baseSha and checks it out into the worktree path.
  await gitOrThrow(['worktree', 'add', '-b', branch, wtPath, baseSha], {
    cwd: repoPath,
  });

  // Mirror the host repo's pending working-tree state into the
  // worktree, so a multi-turn REPL session sees its own previous
  // edits even when those edits were applied via `git apply --index`
  // (staged but not committed). Without this, a follow-up prompt
  // like "you run it" looks at a fresh HEAD checkout that doesn't
  // have the file the previous turn just wrote.
  //
  // Implementation notes:
  //   1. Apply the host's `git diff HEAD --binary` to the worktree.
  //      `--binary` so binary files (images, sqlite dbs) ship.
  //   2. Copy each gitignore-respecting untracked file directly.
  //   3. Stage everything and commit to a sentinel ref so the
  //      worktree's `baseSha` advances - subsequent `diffWorktree`
  //      calls now produce ONLY the agent's net changes, never the
  //      host pending changes (which would otherwise get re-applied
  //      by `applyArtifact`, doubling them up in the host repo).
  //
  // The whole step is best-effort: any failure falls back to a
  // pristine HEAD worktree rather than aborting the run.
  try {
    const mirrored = await mirrorHostState(repoPath, wtPath);
    if (mirrored) baseSha = mirrored;
  } catch {
    // best-effort - keep the un-mirrored worktree
  }

  return {
    runId,
    branch,
    path: wtPath,
    baseRef,
    baseSha,
    repoPath,
    createdAt: Date.now(),
  };
}

/**
 * Replays the host repo's pending changes (tracked diffs + untracked
 * files) into a freshly-created worktree, then commits them so the
 * worktree's "starting state" matches the user's actual workspace.
 *
 * Returns the new sha to use as `baseSha` on the worktree, or null
 * when the host has no pending changes (no work to do).
 */
async function mirrorHostState(
  repoPath: string,
  wtPath: string,
): Promise<string | null> {
  // 1. Tracked changes (working tree + index vs HEAD), as a binary
  //    patch so non-text files come through with index info that
  //    `git apply` understands.
  const diff = await git(['diff', '--binary', 'HEAD'], { cwd: repoPath });
  const trackedPatch = diff.exitCode === 0 ? diff.stdout : '';

  // 2. Untracked files (respecting .gitignore so we don't drag
  //    node_modules / build artifacts into the agent's workspace).
  const untrackedRes = await git(
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: repoPath },
  );
  const untracked = untrackedRes.exitCode === 0
    ? untrackedRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];

  if (!trackedPatch && untracked.length === 0) return null;

  // Apply the tracked diff inside the worktree.
  if (trackedPatch) {
    const apply = await exec('git', ['apply', '--index', '-'], {
      cwd: wtPath,
      input: trackedPatch,
    });
    if (apply.exitCode !== 0) {
      // 3-way fallback covers minor index drift between repo + worktree.
      const apply3 = await exec('git', ['apply', '--3way', '--index', '-'], {
        cwd: wtPath,
        input: trackedPatch,
      });
      if (apply3.exitCode !== 0) {
        throw new CommandError(
          `mirrorHostState: failed to apply host diff: ${apply3.stderr.trim()}`,
          apply3,
          'git',
          ['apply', '--3way', '--index'],
        );
      }
    }
  }

  // Copy each untracked file from repo to worktree, preserving
  // path layout. Cheaper than re-implementing rsync; respects
  // .gitignore via the `ls-files --exclude-standard` we ran above.
  for (const rel of untracked) {
    const src = join(repoPath, rel);
    const dst = join(wtPath, rel);
    await mkdir(dirname(dst), { recursive: true });
    try {
      await copyFile(src, dst);
    } catch {
      // skip files that vanish between ls-files and copyFile
      continue;
    }
  }

  // Stage everything (including the just-copied untracked files) and
  // commit to advance the worktree branch's HEAD. The new HEAD is
  // what subsequent `diffWorktree` / `changedFiles` calls compare
  // against - so the agent's diff captures only its own work, not
  // the host's pre-existing pending state.
  await gitOrThrow(['add', '-A'], { cwd: wtPath });
  // `--allow-empty` covers the rare case where the diff was a noop
  // (e.g. permission-only change that didn't survive apply).
  await gitOrThrow(
    [
      '-c', 'user.email=coderouter@local',
      '-c', 'user.name=CodeRouter',
      'commit', '--allow-empty', '-m', 'coderouter: mirror host state',
    ],
    { cwd: wtPath },
  );
  const newHead = await gitOrThrow(['rev-parse', 'HEAD'], { cwd: wtPath });
  return newHead.stdout.trim();
}

/**
 * Pathspec exclusions appended to every worktree diff command.
 *
 * These are common build artifacts and machine-state files that an
 * agent run can incidentally produce (the model executes
 * `python3 script.py` for a smoke test, Python compiles the source
 * to `__pycache__/script.cpython-312.pyc`, etc.) but that the user
 * doesn't actually want in their patch:
 *
 *   1. The user's `.gitignore` may already exclude them - but a
 *      worktree forked from a clean tree has no `.gitignore`-aware
 *      diff context for paths that didn't exist before.
 *   2. Binary patches for `.pyc`, `.so`, etc. need full index
 *      lines to apply, which our cross-worktree apply pipeline
 *      can't always produce; including them silently breaks accept.
 *   3. Even when they apply, the user never asked the agent to
 *      modify their cache directories - it's pure noise.
 *
 * Conservative on purpose: when in doubt the file ships. Adding a
 * pattern here only filters paths that NO sane workflow tracks.
 */
const DIFF_EXCLUDES: readonly string[] = [
  ':(exclude)__pycache__',
  ':(exclude,glob)**/__pycache__/**',
  ':(exclude,glob)**/*.pyc',
  ':(exclude,glob)**/*.pyo',
  ':(exclude,glob)**/*.pyd',
  ':(exclude)node_modules',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude)dist',
  ':(exclude,glob)**/dist/**',
  ':(exclude).next',
  ':(exclude,glob)**/.next/**',
  ':(exclude).turbo',
  ':(exclude,glob)**/.turbo/**',
  ':(exclude).cache',
  ':(exclude,glob)**/.cache/**',
  ':(exclude)target',
  ':(exclude,glob)**/target/**',
  ':(exclude,glob)**/.DS_Store',
  ':(exclude,glob)**/Thumbs.db',
];

/**
 * Reads the worktree's current diff against its base sha. Includes
 * untracked files (which `git diff` omits by default) by staging them
 * with `git add -N` so they appear as adds. Filters out common build
 * artifacts via `DIFF_EXCLUDES` so a stray `__pycache__/*.pyc` from
 * the model running a smoke test doesn't end up in the user's patch.
 */
export async function diffWorktree(wt: Worktree): Promise<string> {
  // Force untracked files to appear in the diff.
  await git(['add', '-N', '.'], { cwd: wt.path });

  // `--binary` is required: without it, git emits a "Binary files
  // differ" stub with no payload, and `git apply` later fails with
  // "cannot apply binary patch ... without full index line". Logo
  // PNGs / preview assets then can't be accepted from the REPL.
  const result = await git(
    ['diff', '--patch', '--binary', wt.baseSha, '--', '.', ...DIFF_EXCLUDES],
    { cwd: wt.path },
  );
  if (result.exitCode !== 0) {
    throw new CommandError(
      `git diff failed: ${result.stderr.trim()}`,
      result,
      'git',
      ['diff', wt.baseSha],
    );
  }
  return result.stdout;
}

/** Returns the list of files that differ from baseSha (added/modified/deleted). */
export async function changedFiles(wt: Worktree): Promise<string[]> {
  await git(['add', '-N', '.'], { cwd: wt.path });
  const result = await gitOrThrow(
    ['diff', '--name-only', wt.baseSha, '--', '.', ...DIFF_EXCLUDES],
    { cwd: wt.path },
  );
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Snapshot the current working tree (tracked + non-ignored untracked files)
 * as a git tree object WITHOUT touching the repo's real index. Uses a
 * throwaway index file so `git add -A` + `git write-tree` capture the exact
 * on-disk state without staging anything for the user. Returns the tree sha.
 *
 * Powers in-place (unsandboxed/allowlist) diffing: snapshot before the run,
 * snapshot after, then diff the two trees with `diffWorkingTree`.
 */
export async function snapshotWorkingTree(repoPath: string): Promise<string> {
  const tmpIndex = join(tmpdir(), `cr-index-${randomUUID()}`);
  try {
    const add = await git(['add', '-A'], { cwd: repoPath, env: { GIT_INDEX_FILE: tmpIndex } });
    if (add.exitCode !== 0) {
      throw new CommandError(
        `snapshotWorkingTree: git add failed: ${add.stderr.trim()}`,
        add,
        'git',
        ['add', '-A'],
      );
    }
    const tree = await gitOrThrow(['write-tree'], {
      cwd: repoPath,
      env: { GIT_INDEX_FILE: tmpIndex },
    });
    return tree.stdout.trim();
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/**
 * Diff the current working tree against a previously-captured tree sha
 * (see `snapshotWorkingTree`). Returns the unified patch + changed-file
 * list, filtering the same build-artifact noise as `diffWorktree`. Used for
 * in-place runs where there's no worktree - the edits are already on the
 * user's real files, and we just need to describe what changed so the UI can
 * render + optionally undo them.
 */
export async function diffWorkingTree(
  repoPath: string,
  baseTree: string,
): Promise<{ diff: string; files: string[] }> {
  const afterTree = await snapshotWorkingTree(repoPath);
  const patch = await git(
    ['diff', '--patch', '--binary', baseTree, afterTree, '--', '.', ...DIFF_EXCLUDES],
    { cwd: repoPath },
  );
  const names = await git(['diff', '--name-only', baseTree, afterTree, '--', '.', ...DIFF_EXCLUDES], {
    cwd: repoPath,
  });
  const files = names.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { diff: patch.exitCode === 0 ? patch.stdout : '', files };
}

/** Returns short metrics for the worktree diff (used by report layer). */
export async function diffStats(wt: Worktree): Promise<WorktreeMetrics> {
  await git(['add', '-N', '.'], { cwd: wt.path });
  const result = await git(
    ['diff', '--numstat', wt.baseSha, '--', '.', ...DIFF_EXCLUDES],
    { cwd: wt.path },
  );
  if (result.exitCode !== 0) {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
  let insertions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [insStr, delStr] = line.split('\t');
    const ins = Number.parseInt(insStr ?? '', 10);
    const del = Number.parseInt(delStr ?? '', 10);
    if (!Number.isNaN(ins)) insertions += ins;
    if (!Number.isNaN(del)) deletions += del;
    filesChanged += 1;
  }
  return { filesChanged, insertions, deletions };
}

/**
 * Merges the worktree's changes back into the host repo. Uses a patch +
 * `git apply` strategy so we don't need to fast-forward branches or mess
 * with the user's checked-out branch state. Returns the list of files
 * touched on the host side.
 */
export async function mergeWorktree(
  wt: Worktree,
  opts: { strategy?: 'apply' | 'cherry-pick'; cleanup?: boolean } = {},
): Promise<string[]> {
  const strategy = opts.strategy ?? 'apply';
  const files = await changedFiles(wt);
  if (files.length === 0) {
    if (opts.cleanup !== false) await destroyWorktree(wt);
    return [];
  }

  if (strategy === 'apply') {
    const patch = await diffWorktree(wt);
    // Plain working-tree apply - deliberately NOT `--index`. The host
    // repo may have been auto-inited by CodeRouter, in which case
    // every pre-existing file is untracked; `git apply --index`
    // refuses to patch files that aren't in the index ("does not
    // exist in index"), which silently broke `--apply` for the
    // entire point-at-any-folder flow. Plain apply only needs the
    // file on disk. Staging is the user's call anyway.
    const apply = await exec('git', ['apply', '-'], {
      cwd: wt.repoPath,
      input: patch,
    });
    if (apply.exitCode !== 0) {
      // Fall back to a 3-way apply for context drift.
      const apply3 = await exec(
        'git',
        ['apply', '--3way', '-'],
        { cwd: wt.repoPath, input: patch },
      );
      if (apply3.exitCode !== 0) {
        throw new CommandError(
          `mergeWorktree: git apply failed: ${apply3.stderr.trim() || apply.stderr.trim()}`,
          apply3,
          'git',
          ['apply'],
        );
      }
    }
  } else {
    // cherry-pick path; rarely used because we don't commit inside the
    // worktree by default.
    await gitOrThrow(['cherry-pick', wt.branch], { cwd: wt.repoPath });
  }

  if (opts.cleanup !== false) await destroyWorktree(wt);
  return files;
}

/**
 * Apply a unified diff (as produced by `diffWorktree`) directly to a
 * repo's working tree. Used when the user reviews a chat's changes and
 * chooses to accept them after the run's worktree is already gone — the
 * diff text is the only surviving artifact, so we replay it against the
 * host repo. Mirrors `mergeWorktree`'s plain→3way fallback. Throws with a
 * readable message when the patch can't be applied (e.g. the files drifted).
 */
export async function applyPatchToRepo(repoPath: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const apply = await exec('git', ['apply', '-'], { cwd: repoPath, input: patch });
  if (apply.exitCode === 0) return;
  const apply3 = await exec('git', ['apply', '--3way', '-'], { cwd: repoPath, input: patch });
  if (apply3.exitCode !== 0) {
    throw new CommandError(
      `applyPatchToRepo: git apply failed: ${apply3.stderr.trim() || apply.stderr.trim()}`,
      apply3,
      'git',
      ['apply'],
    );
  }
}

/**
 * Reverse a unified diff previously applied by {@link applyPatchToRepo},
 * restoring the working tree to its pre-patch state. Powers the "Undo"
 * action in Studio: the same diff text is re-applied with `--reverse`.
 * Mirrors the plain→3way fallback so an undo still succeeds when the
 * files have drifted slightly. Throws a readable message on failure.
 */
export async function revertPatchFromRepo(repoPath: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const apply = await exec('git', ['apply', '--reverse', '-'], { cwd: repoPath, input: patch });
  if (apply.exitCode === 0) return;
  const apply3 = await exec('git', ['apply', '--reverse', '--3way', '-'], { cwd: repoPath, input: patch });
  if (apply3.exitCode !== 0) {
    throw new CommandError(
      `revertPatchFromRepo: git apply --reverse failed: ${apply3.stderr.trim() || apply.stderr.trim()}`,
      apply3,
      'git',
      ['apply', '--reverse'],
    );
  }
}

/**
 * Snapshots the worktree's current state into a new commit on its
 * branch and returns the resulting sha. Used by long-lived REPL
 * sessions to advance `baseSha` after each turn so that subsequent
 * `diffWorktree` calls produce only the *next* turn's net changes
 * rather than re-listing every file the agent ever touched.
 *
 * Returns `null` when there's nothing to snapshot (no diff vs the
 * current baseSha) - callers can keep the existing baseSha in that
 * case. Best-effort: on any git failure we return `null` so the
 * caller can fall back to the original baseSha rather than crashing
 * the run.
 */
export async function commitWorktreeState(
  wt: Worktree,
  message = 'coderouter: turn snapshot',
): Promise<string | null> {
  try {
    // Make untracked files visible to the index so `git commit` picks
    // them up. -N adds intent-to-add (no content yet); the subsequent
    // `git add -A` does the real staging.
    await git(['add', '-N', '.'], { cwd: wt.path });
    const status = await git(['status', '--porcelain'], { cwd: wt.path });
    if (status.exitCode !== 0 || !status.stdout.trim()) return null;

    const add = await git(['add', '-A', '--', '.', ...DIFF_EXCLUDES], { cwd: wt.path });
    if (add.exitCode !== 0) return null;

    // `--allow-empty` is defensive: some pathspec exclusions can leave
    // the index empty even when status was non-empty.
    const commit = await git(
      [
        '-c', 'user.email=coderouter@local',
        '-c', 'user.name=CodeRouter',
        'commit', '--allow-empty', '-m', message,
      ],
      { cwd: wt.path },
    );
    if (commit.exitCode !== 0) return null;

    const head = await git(['rev-parse', 'HEAD'], { cwd: wt.path });
    if (head.exitCode !== 0) return null;
    return head.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Discards the worktree and its branch. Safe to call multiple times; each
 * step swallows missing-target errors so cleanup never fails the run.
 */
export async function destroyWorktree(wt: Worktree): Promise<void> {
  // git worktree remove + branch delete; both best-effort.
  await git(['worktree', 'remove', '--force', wt.path], { cwd: wt.repoPath });
  await git(['branch', '-D', wt.branch], { cwd: wt.repoPath });
  await rm(wt.path, { recursive: true, force: true });
}

/**
 * Lists all worktrees the user has registered for this repo. Used by the
 * `coderouter log` / GC paths to clean up orphans.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<{ path: string; branch: string; sha: string }[]> {
  const result = await git(['worktree', 'list', '--porcelain'], { cwd: repoPath });
  if (result.exitCode !== 0) return [];
  const out: { path: string; branch: string; sha: string }[] = [];
  let current: Partial<{ path: string; branch: string; sha: string }> = {};
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        out.push({
          path: current.path,
          branch: current.branch ?? '',
          sha: current.sha ?? '',
        });
      }
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line.startsWith('HEAD ')) {
      current.sha = line.slice('HEAD '.length);
    }
  }
  if (current.path) {
    out.push({
      path: current.path,
      branch: current.branch ?? '',
      sha: current.sha ?? '',
    });
  }
  return out;
}

export type RunArtifact = {
  /** Absolute path of the on-disk artifact directory. */
  dir: string;
  /** Absolute path of the unified diff (`changes.patch`). */
  patchPath: string;
  /** Files touched by the run (paths relative to the repo root). */
  files: string[];
};

/**
 * Persist the diff + a small manifest to `<repo>/.coderouter/runs/<runId>/`
 * so the worktree is recoverable even after we destroy it. Used by
 * runs that produce changes the user may want to keep without having
 * `--apply` enabled - they can `git apply` the patch later.
 *
 * Best-effort: returns null if the diff is empty or persistence
 * fails (we never want artifact persistence to fail the run itself).
 */
export async function persistRunArtifact(
  wt: Worktree,
  opts: { diff: string; files: string[] },
): Promise<RunArtifact | null> {
  if (!opts.diff || opts.diff.trim().length === 0) return null;
  if (opts.files.length === 0) return null;
  try {
    const dir = join(wt.repoPath, '.coderouter', 'runs', wt.runId);
    await mkdir(dir, { recursive: true });
    const patchPath = join(dir, 'changes.patch');
    await writeFile(patchPath, opts.diff, 'utf8');
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          runId: wt.runId,
          branch: wt.branch,
          baseSha: wt.baseSha,
          createdAt: wt.createdAt,
          completedAt: Date.now(),
          files: opts.files,
        },
        null,
        2,
      ),
      'utf8',
    );
    return { dir, patchPath, files: opts.files };
  } catch {
    return null;
  }
}

/**
 * Run `git worktree prune` to clear out stale worktree refs left over
 * from previous sessions that crashed or were SIGKILL'd before
 * `destroyWorktree` could run. Cheap and idempotent; safe to call on
 * REPL launch.
 */
export async function pruneStaleWorktrees(repoPath: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd: repoPath });
}

/**
 * One-shot helper: create a worktree, hand it to `fn`, and clean up
 * regardless of outcome. Useful for tournament/handoff workflows that
 * always discard their worktrees after extracting a diff.
 */
export async function withWorktree<T>(
  opts: WorktreeOptions,
  fn: (wt: Worktree) => Promise<T>,
): Promise<T> {
  const wt = await createWorktree(opts);
  try {
    return await fn(wt);
  } finally {
    await destroyWorktree(wt).catch(() => {
      // best-effort cleanup
    });
  }
}
