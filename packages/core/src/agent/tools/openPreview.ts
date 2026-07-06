import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Tool } from '../types.js';
import { oneLine, resolveSafe, stringArg } from './helpers.js';

/** Does the string already carry an explicit URI scheme (http:, file:, ...)? */
function hasScheme(t: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t);
}

/** localhost:3000 / 127.0.0.1:8000 / [::1]:5173 / :5173 style shorthand. */
function looksLikeHostPort(t: string): boolean {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?(\/.*)?$/i.test(t) || /^:\d+(\/.*)?$/.test(t);
}

type Resolved = { url: string; isFile: boolean } | { error: string };

/**
 * Turn the model's `target` (a URL, a host:port, or a project-relative /
 * absolute file path) into something a browser can load. File paths become
 * `file://` URLs; bare host:port becomes an `http://` URL.
 */
function resolveTarget(target: string, cwd: string): Resolved {
  const t = target.trim();
  if (!t) return { error: 'target is empty' };

  if (hasScheme(t)) {
    // Non-browsable bind addresses -> localhost, matching dev-server detection.
    const url = t.replace('0.0.0.0', 'localhost').replace(/\[::1?\]/, 'localhost');
    return { url, isFile: /^file:/i.test(t) };
  }

  if (looksLikeHostPort(t)) {
    const host = t.startsWith(':') ? `localhost${t}` : t.replace('0.0.0.0', 'localhost');
    return { url: `http://${host}`, isFile: false };
  }

  // Treat everything else as a file path relative to the project.
  let abs: string;
  try {
    abs = resolveSafe(cwd, t);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (!existsSync(abs)) return { error: `no such file in the project: ${t}` };
  return { url: pathToFileURL(abs).href, isFile: true };
}

/**
 * open_preview - the agent's way to actually SHOW work to the user.
 *
 * Emits an `open_preview` activity event; the client decides how to honor
 * it (in-app browser panel in the desktop app, OS default browser in the
 * CLI). The tool itself performs no I/O beyond resolving the target, so it
 * is safe under every run mode.
 */
export const openPreviewTool: Tool = {
  name: 'open_preview',
  description:
    "Open a URL or a local file in the user's browser so they can see the result. " +
    'Use this whenever you produce something visual worth looking at: a running dev ' +
    'server (pass its http URL, e.g. http://localhost:5173) or a standalone web page / ' +
    'game / HTML file (pass the project path, e.g. index.html). In the desktop app it ' +
    'opens an in-app browser panel; in the CLI it launches the default browser. This is ' +
    'how you present finished work - NEVER tell the user to open a file or URL themselves, ' +
    'and NEVER claim you cannot open a browser.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description:
          'An http(s) URL (e.g. http://localhost:5173) or a path to a local file relative ' +
          'to the project (e.g. index.html, dist/index.html).',
      },
    },
    required: ['target'],
  },
  describe: (args) => `Open ${oneLine(stringArg(args, 'target'), 80)} in the browser`,
  run: async (args, ctx) => {
    const target = stringArg(args, 'target');
    const resolved = resolveTarget(target, ctx.cwd);
    if ('error' in resolved) {
      return { body: `Could not open preview: ${resolved.error}`, ok: false, display: 'not found' };
    }
    ctx.onActivity?.({ kind: 'open_preview', url: resolved.url });
    const note = resolved.isFile
      ? ' (Static file: if the page relies on ES modules or fetch it may need a server - ' +
        'start one with bash(background: true) and open that http URL instead.)'
      : '';
    return {
      body: `Opened ${resolved.url} in the user's browser.${note}`,
      ok: true,
      display: resolved.url,
    };
  },
};
