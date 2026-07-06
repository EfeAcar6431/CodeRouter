import type { Tool, ToolResult } from '../types.js';
import { clip, oneLine, stringArg } from './helpers.js';

/** Hard cap on web_fetch output (bytes). */
const MAX_FETCH_BYTES = 48 * 1024;
/** Default request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 15_000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

/** Pull the <title> out of an HTML document, if present. */
function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m
    ? decodeEntities(m[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    : undefined;
}

/**
 * Convert an HTML document to readable plain text: drop non-content
 * elements (script/style/etc), turn block tags into line breaks, strip the
 * remaining tags, decode entities, and collapse runaway whitespace.
 */
function htmlToText(html: string): string {
  const withoutHead = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, ' ');
  const withBreaks = withoutHead
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(
      /<\/(?:p|div|section|article|li|ul|ol|h[1-6]|tr|table|header|footer|nav|pre|blockquote)>/gi,
      '\n',
    )
    .replace(/<li[^>]*>/gi, '\n- ');
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '));
  return text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function runWebFetch(url: string, signal?: AbortSignal): Promise<ToolResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { body: `Invalid URL: ${url}`, ok: false, display: 'invalid url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      body: `Unsupported URL scheme '${parsed.protocol}'. Use http(s).`,
      ok: false,
      display: 'bad scheme',
    };
  }

  const ctl = new AbortController();
  if (signal) {
    if (signal.aborted) return { body: '(aborted)', ok: false, display: 'aborted' };
    signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  const timeout = setTimeout(() => ctl.abort(new Error('timeout')), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(parsed.href, {
      method: 'GET',
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        // A real UA + Accept avoids the trivial bot blocks that return 403 to `node`.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      return {
        body: `Fetch failed: HTTP ${res.status} ${res.statusText} for ${parsed.href}`,
        ok: false,
        display: `HTTP ${res.status}`,
      };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const isHtml =
      /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(raw);
    const title = isHtml ? extractTitle(raw) : undefined;
    const content = isHtml ? htmlToText(raw) : raw.trim();

    const header = [`Fetched ${parsed.href}`, title ? `Title: ${title}` : undefined]
      .filter(Boolean)
      .join('\n');
    const { text, truncated } = clip(content, MAX_FETCH_BYTES);
    const body = `${header}\n\n${text}${truncated ? '\n\n[truncated]' : ''}`;
    return { body, ok: true, display: title ? oneLine(title, 60) : `${parsed.host}` };
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'request timed out or was cancelled'
        : (err as Error).message;
    return { body: `Could not fetch ${parsed.href}: ${msg}`, ok: false, display: 'fetch error' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * web_fetch - retrieve and read a specific web page.
 *
 * Complements web_search (which only returns links + snippets): when the user
 * gives a URL, or a search result looks relevant, the agent uses this to
 * actually open the page and read its content (HTML is reduced to readable
 * text). This is how the agent "goes and looks at the site."
 */
export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a specific URL and return its readable text content. Use this to actually READ a web ' +
    'page - documentation, a tutorial, an API reference, a GitHub file, release notes - especially ' +
    'when the user gives you a link or a web_search result looks relevant. HTML is converted to ' +
    'plain text. Pair it with web_search (which only returns links + snippets) to look things up ' +
    'and then read the best source. Never tell the user to go read a page themselves - fetch it.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to fetch and read.' },
    },
    required: ['url'],
  },
  describe: (args) => `Fetched ${oneLine(stringArg(args, 'url'), 80)}`,
  run: async (args, ctx) => runWebFetch(stringArg(args, 'url'), ctx.signal),
};
