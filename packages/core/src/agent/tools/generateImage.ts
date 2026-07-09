/**
 * First-class image generation via OpenRouter's chat completions
 * `modalities: ["image","text"]` path.
 *
 * Without this tool, models reinvent image gen with bash + curl against
 * the OpenRouter key — burning millions of tokens on a coding model that
 * shouldn't be doing raster work at all. The agent calls this instead;
 * we pick a cheap image-output model from the live catalog and write the
 * resulting PNG into the worktree.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  fetchOpenRouterModels,
  isImageOutputCapable,
  type OpenRouterModel,
} from '../providers/openrouter.js';
import type { Tool } from '../types.js';
import { oneLine, resolveSafe, stringArg } from './helpers.js';

const DEFAULT_IMAGE_MODELS = [
  'google/gemini-2.5-flash-image',
  'google/gemini-3.1-flash-image-preview',
  'openai/gpt-5-image-mini',
  'black-forest-labs/flux.2-pro',
] as const;

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function pickImageModel(models: OpenRouterModel[], preferred?: string): string {
  if (preferred) {
    const hit = models.find((m) => m.id === preferred && isImageOutputCapable(m));
    if (hit) return hit.id;
  }
  for (const id of DEFAULT_IMAGE_MODELS) {
    const hit = models.find((m) => m.id === id && isImageOutputCapable(m));
    if (hit) return hit.id;
  }
  const any = models.find(isImageOutputCapable);
  if (any) return any.id;
  throw new Error(
    'no OpenRouter image-output model is available; refresh the catalog with a valid OPENROUTER_API_KEY',
  );
}

type ImagePayload = {
  image_url?: { url?: string };
  imageUrl?: { url?: string };
  url?: string;
  b64_json?: string;
};

function extractDataUrl(images: ImagePayload[] | undefined, content: unknown): string | null {
  if (Array.isArray(images)) {
    for (const img of images) {
      const url = img.image_url?.url ?? img.imageUrl?.url ?? img.url;
      if (typeof url === 'string' && url.startsWith('data:image/')) return url;
      if (typeof img.b64_json === 'string' && img.b64_json.length > 0) {
        return `data:image/png;base64,${img.b64_json}`;
      }
    }
  }
  // Some models embed the data URL in the text content.
  if (typeof content === 'string') {
    const m = content.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/);
    if (m) return m[0];
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block) {
        const b = block as { type: string; image_url?: { url?: string }; text?: string };
        if (b.type === 'image_url' && b.image_url?.url?.startsWith('data:image/')) {
          return b.image_url.url;
        }
        if (b.type === 'text' && typeof b.text === 'string') {
          const m = b.text.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/);
          if (m) return m[0];
        }
      }
    }
  }
  return null;
}

function dataUrlToBuffer(dataUrl: string): { buf: Buffer; ext: string } {
  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('image response was not a base64 data URL');
  const mime = m[1]!.toLowerCase();
  const ext = mime === 'jpeg' ? 'jpg' : mime === 'svg+xml' ? 'svg' : mime;
  return { buf: Buffer.from(m[2]!, 'base64'), ext };
}

export const generateImageTool: Tool = {
  name: 'generate_image',
  description:
    'Generate a raster image (logo, icon, illustration, mockup) via OpenRouter and save it to a project path. ' +
    'USE THIS instead of inventing your own curl/bash OpenRouter image calls. ' +
    'Pass a detailed `prompt` describing the image, and a relative `path` where the PNG/WebP should be written. ' +
    'Optionally set `model` to a specific OpenRouter image-output model id; otherwise a cheap default is chosen.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed image-generation prompt (subject, style, background, transparency needs, etc.).',
      },
      path: {
        type: 'string',
        description:
          'Project-relative path to write the image to (e.g. `packages/app/public/logo.png`). Extension is adjusted to match the returned format if needed.',
      },
      model: {
        type: 'string',
        description:
          'Optional OpenRouter model id with image output (e.g. `google/gemini-2.5-flash-image`). Defaults to a cheap image-capable model.',
      },
    },
    required: ['prompt', 'path'],
  },
  describe: (args) => `Generated image → ${oneLine(stringArg(args, 'path'), 80)}`,
  run: async (args, ctx) => {
    const prompt = stringArg(args, 'prompt');
    const relPath = stringArg(args, 'path');
    const preferredModel = typeof args.model === 'string' ? args.model : undefined;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        body: 'OPENROUTER_API_KEY is not set; cannot generate images. Configure it via /setup.',
      };
    }

    let abs: string;
    try {
      abs = resolveSafe(ctx.cwd, relPath);
    } catch (err) {
      return { ok: false, body: (err as Error).message };
    }

    let modelId: string;
    try {
      const models = await fetchOpenRouterModels({ apiKey });
      modelId = pickImageModel(models, preferredModel);
    } catch (err) {
      return { ok: false, body: (err as Error).message };
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://coderouter.dev',
        'X-Title': 'CodeRouter',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
        stream: false,
      }),
      signal: ctx.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        body: `OpenRouter image generation failed (${res.status}): ${text.slice(0, 500)}`,
      };
    }

    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: unknown; images?: ImagePayload[] };
      }>;
      error?: { message?: string };
    };

    if (json.error?.message) {
      return { ok: false, body: `OpenRouter error: ${json.error.message}` };
    }

    const message = json.choices?.[0]?.message;
    const dataUrl = extractDataUrl(message?.images, message?.content);
    if (!dataUrl) {
      return {
        ok: false,
        body: `model ${modelId} returned no image data. Try a different image-output model (e.g. google/gemini-2.5-flash-image).`,
      };
    }

    const { buf, ext } = dataUrlToBuffer(dataUrl);
    // If the caller asked for .png but we got webp/jpeg, keep their
    // basename and swap the extension so the file is valid.
    let outPath = abs;
    const wantExt = extname(abs).slice(1).toLowerCase();
    if (wantExt && wantExt !== ext) {
      outPath = join(dirname(abs), `${basenameWithoutExt(abs)}.${ext}`);
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);

    const writtenRel = outPath.startsWith(ctx.cwd)
      ? outPath.slice(ctx.cwd.length).replace(/^[\\/]/, '')
      : outPath;

    return {
      ok: true,
      body: `wrote ${buf.byteLength} bytes to ${writtenRel} (model=${modelId})`,
      display: `wrote ${writtenRel} via ${modelId}`,
    };
  },
};

function basenameWithoutExt(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.[^.]+$/, '');
}
