/**
 * Tests for the per-tool implementations.
 *
 * Each tool is exercised against a real temp directory so the file
 * I/O paths are covered (path-safe resolution, multi-line edits,
 * binary clipping). External commands (rg/grep/git/find) run via
 * `exec` so these tests need a working shell - that's the same
 * environment the agent actually runs in, not a stretch.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../sandbox/exec.js';
import {
  askUserQuestionTool,
  bashTool,
  defaultTools,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  multiEditTool,
  openPreviewTool,
  readFileTool,
  webSearchTool,
  withTool,
  withoutTool,
  writeFileTool,
} from '../tools/index.js';
import type { ToolContext } from '../types.js';
import type { ActivityEvent } from '../../adapters/types.js';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cra-tools-'));
  await exec('git', ['init', '-q'], { cwd });
  ctx = { cwd };
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('default tool registry', () => {
  it('exposes the canonical built-in toolbox', () => {
    const names = defaultTools().map((t) => t.name);
    expect(names).toEqual([
      'read_file',
      'glob',
      'grep',
      'list_dir',
      'web_search',
      'write_file',
      'edit_file',
      'multi_edit',
      'bash',
      'open_preview',
      'ask_user_question',
    ]);
  });
  it('withTool replaces by name (no duplicates)', () => {
    const tools = withTool(defaultTools(), { ...readFileTool, description: 'custom' });
    expect(tools.filter((t) => t.name === 'read_file')).toHaveLength(1);
    expect(tools.find((t) => t.name === 'read_file')?.description).toBe('custom');
  });
  it('withoutTool drops by name', () => {
    expect(withoutTool(defaultTools(), 'bash').map((t) => t.name)).not.toContain('bash');
  });
});

describe('web_search', () => {
  it('describe summarizes the query', () => {
    expect(webSearchTool.describe({ query: 'react server components' })).toMatch(
      /Searched the web/,
    );
  });
});

describe('write_file + read_file', () => {
  it('round-trips file content with line numbers on read', async () => {
    const w = await writeFileTool.run({ path: 'a.txt', content: 'one\ntwo\n' }, ctx);
    expect(w.ok).toBe(true);
    const r = await readFileTool.run({ path: 'a.txt' }, ctx);
    expect(r.body).toContain('     1|one');
    expect(r.body).toContain('     2|two');
  });
  it('rejects paths that escape the worktree', async () => {
    await expect(writeFileTool.run({ path: '../boom', content: 'x' }, ctx)).rejects.toThrow(
      /outside the worktree/,
    );
  });
});

describe('edit_file', () => {
  it('replaces a unique occurrence', async () => {
    await writeFile(join(cwd, 'src.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
    const r = await editFileTool.run(
      { path: 'src.ts', old_string: 'const x = 1;', new_string: 'const x = 9;' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(cwd, 'src.ts'), 'utf8')).toContain('const x = 9;');
  });
  it('errors when the match is non-unique without replace_all', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo\nfoo\n', 'utf8');
    await expect(
      editFileTool.run({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, ctx),
    ).rejects.toThrow(/multiple times/);
  });
  it('replace_all rewrites every occurrence', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo\nfoo\n', 'utf8');
    const r = await editFileTool.run(
      { path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('bar\nbar\n');
  });
});

describe('multi_edit', () => {
  it('applies a sequence of edits atomically', async () => {
    await writeFile(join(cwd, 's.ts'), 'a\nb\nc\n', 'utf8');
    const r = await multiEditTool.run(
      {
        path: 's.ts',
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'c', new_string: 'C' },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(cwd, 's.ts'), 'utf8')).toBe('A\nb\nC\n');
  });
  it('aborts (no partial writes) if any edit fails', async () => {
    await writeFile(join(cwd, 's.ts'), 'a\nb\nc\n', 'utf8');
    await expect(
      multiEditTool.run(
        {
          path: 's.ts',
          edits: [
            { old_string: 'a', new_string: 'A' },
            { old_string: 'NOPE', new_string: 'X' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow();
    expect(await readFile(join(cwd, 's.ts'), 'utf8')).toBe('a\nb\nc\n');
  });
});

describe('glob + list_dir', () => {
  it('glob returns matching git-tracked files', async () => {
    await writeFile(join(cwd, 'a.ts'), 'x', 'utf8');
    await writeFile(join(cwd, 'b.txt'), 'y', 'utf8');
    await exec('git', ['add', '.'], { cwd });
    const r = await globTool.run({ pattern: '*.ts' }, ctx);
    expect(r.body).toContain('a.ts');
    expect(r.body).not.toContain('b.txt');
  });
  it('list_dir lists entries', async () => {
    await writeFile(join(cwd, 'a.txt'), 'x', 'utf8');
    const r = await listDirTool.run({ path: '.' }, ctx);
    expect(r.body).toContain('a.txt');
  });
});

describe('grep', () => {
  it('finds matching lines', async () => {
    await writeFile(join(cwd, 'a.txt'), 'hello\nworld\nhello world\n', 'utf8');
    const r = await grepTool.run({ pattern: 'hello' }, ctx);
    expect(r.body).toContain('a.txt');
    expect(r.body).toContain('hello');
  });
});

describe('bash', () => {
  it('runs commands and reports exit code', async () => {
    const r = await bashTool.run({ command: 'echo hi' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.body).toContain('exit code: 0');
    expect(r.body).toContain('hi');
  });
  it('reports non-zero exit', async () => {
    const r = await bashTool.run({ command: 'exit 7' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.body).toContain('exit code: 7');
  });
});

describe('open_preview', () => {
  it('emits an http url unchanged for a running server', async () => {
    const events: ActivityEvent[] = [];
    const r = await openPreviewTool.run(
      { target: 'http://localhost:5173' },
      { ...ctx, onActivity: (e) => events.push(e) },
    );
    expect(r.ok).toBe(true);
    expect(events).toEqual([{ kind: 'open_preview', url: 'http://localhost:5173' }]);
  });

  it('expands a bare host:port into an http url', async () => {
    const events: ActivityEvent[] = [];
    await openPreviewTool.run(
      { target: 'localhost:8000' },
      { ...ctx, onActivity: (e) => events.push(e) },
    );
    expect(events[0]).toMatchObject({ kind: 'open_preview', url: 'http://localhost:8000' });
  });

  it('resolves a project file to a file:// url', async () => {
    await writeFile(join(cwd, 'index.html'), '<!doctype html><title>Game</title>');
    const events: ActivityEvent[] = [];
    const r = await openPreviewTool.run(
      { target: 'index.html' },
      { ...ctx, onActivity: (e) => events.push(e) },
    );
    expect(r.ok).toBe(true);
    const ev = events[0] as Extract<ActivityEvent, { kind: 'open_preview' }>;
    expect(ev.kind).toBe('open_preview');
    expect(ev.url.startsWith('file://')).toBe(true);
    expect(ev.url.endsWith('/index.html')).toBe(true);
  });

  it('fails (without emitting) when the file does not exist', async () => {
    const events: ActivityEvent[] = [];
    const r = await openPreviewTool.run(
      { target: 'nope.html' },
      { ...ctx, onActivity: (e) => events.push(e) },
    );
    expect(r.ok).toBe(false);
    expect(events).toEqual([]);
  });
});

describe('ask_user_question', () => {
  it('forwards the parsed payload via ctx.onUserQuestion', async () => {
    const captured: unknown[] = [];
    const r = await askUserQuestionTool.run(
      {
        questions: [
          {
            question: 'Pick approach',
            options: [
              { label: 'A', description: 'first' },
              { label: 'B' },
            ],
          },
        ],
      },
      { ...ctx, onUserQuestion: (p) => captured.push(p) },
    );
    expect(r.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const payload = captured[0] as { questions: Array<{ question: string; options?: unknown[] }> };
    expect(payload.questions[0].question).toBe('Pick approach');
    expect(payload.questions[0].options).toHaveLength(2);
  });
  it('does not blow up when called without onUserQuestion', async () => {
    const r = await askUserQuestionTool.run(
      { questions: [{ question: 'x' }] },
      ctx,
    );
    expect(r.ok).toBe(true);
  });
});
